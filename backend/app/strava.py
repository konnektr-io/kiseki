"""Strava as an import source (#449) — pull-only, nothing stored server-side.

The track Kiseki renders already exists: ``Block.track`` is a bare ``.gpx``/
``.fit`` filename, parsed by :mod:`app.gpx` + :mod:`app.tracklegs` and drawn by
the day map, the minimap and the booklet. Strava exposes the same recording as
JSON streams, so the import is exactly: **streams → minimal GPX → the existing
media path**. Nothing downstream knows where the file came from; the only trace
is the block's "View on Strava" link (and the idempotency scan that reads it).

Why this shape, and not a token store:

  * The app has no PKCE (verified against the auth docs, #449), so the
    code→token exchange needs ``client_secret`` — the browser cannot mint a
    token and must never hold a long-lived refresh token. So the exchange is
    server-side.
  * Persisting the refresh token server-side would mean a graph twin, a k8s
    Secret or a DB row, each of which the erasure path (#196) then has to
    cover. Instead the token lives in **one HttpOnly cookie**, scoped to
    ``/api/integrations/strava``. Disconnect is the absence of the cookie:
    nothing to forget, nothing to leak from a backup.
  * Cost, stated plainly: the link is per browser. Clearing cookies or
    switching device means reconnecting (~30 s). Accepted (#449).

Strava rotates the refresh token on every exchange, so refreshes are serialized
per athlete: two concurrent refreshes with the same token leave one caller
holding an already-invalidated token (the second response's refresh token is
the only live one). One ``threading.Lock`` per athlete — these routes are sync
(FastAPI runs them in the threadpool), so a lock is the right primitive here,
not an ``asyncio.Lock``.

Trip-shaped work (which day, which block, the write, photos onto the block)
lives in :mod:`app.strava_import`, so this module stays transport-only.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
from typing import Any, Optional
from xml.sax.saxutils import escape as _xml_escape

import httpx

from app import config

# --------------------------------------------------------------------- endpoints

API_BASE = "https://www.strava.com/api/v3"
OAUTH_AUTHORIZE = "https://www.strava.com/oauth/authorize"
OAUTH_TOKEN = "https://www.strava.com/oauth/token"
# Deauthorization: the revoke endpoint (HTTP Basic, token in the body) is the
# documented recommendation and becomes the only one on 2026-06-01+ — the
# legacy /oauth/deauthorize (access_token as a param) is not used at all.
OAUTH_REVOKE = "https://www.strava.com/oauth/revoke"

# Least data that still renders the track (#449): read for the athlete, plus
# activity:read_all so an activity set to "Only You" is visible at all.
SCOPES = "read,activity:read_all"

# How long before expiry an access token is refreshed. Strava hands back the
# existing token when it has more than an hour left, so a refresh costs one
# round trip, not a new token — but it also rotates the refresh token, which is
# why it is never done per-render.
REFRESH_SKEW_S = 300

SESSION_COOKIE = "kiseki_strava"
STATE_COOKIE = "kiseki_strava_state"
# The cookie is the whole credential, so it is scoped to the only path that may
# read it. Everything trip-shaped lives under this prefix for exactly that
# reason (see main.py's routes).
COOKIE_PATH = "/api/integrations/strava"
STATE_TTL_S = 600
SESSION_MAX_AGE_S = 30 * 24 * 3600


class StravaError(Exception):
    """A Strava failure with the HTTP status the API should surface."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class StravaNotConnected(StravaError):
    """No usable session cookie — the caller must connect Strava first."""

    def __init__(self) -> None:
        super().__init__(401, "Strava is not connected in this browser — connect it first")


def _cfg(name: str, default: str = "") -> Any:
    """Read a config value at call time (tests monkeypatch ``config``)."""
    return getattr(config, name, default)


def enabled() -> bool:
    """Whether this deployment has a Strava application configured at all."""
    return bool(_cfg("STRAVA_CLIENT_ID")) and bool(_cfg("STRAVA_CLIENT_SECRET"))


def redirect_uri() -> str:
    return str(_cfg("STRAVA_REDIRECT_URI")) or (
        f"{_cfg('PUBLIC_BASE_URL', 'https://kiseki.konnektr.io').rstrip('/')}"
        "/api/integrations/strava/callback"
    )


def secure_cookies() -> bool:
    """``Secure`` only over https — a localhost dev flow must still round-trip."""
    return str(_cfg("PUBLIC_BASE_URL", "")).startswith("https://")


# ------------------------------------------------------------------ http plumbing


def _client() -> httpx.Client:
    """One short-lived client per call — tests swap this for a MockTransport."""
    return httpx.Client(timeout=20.0)


def _error_detail(resp: httpx.Response, what: str) -> str:
    """Readable failure text, including Strava's own fault body.

    Strava answers most refusals with ``message: "Bad Request"`` plus the useful
    part in ``errors[]`` (``{resource, field, code}``), so the generic message
    alone reads as "something was wrong". Kiseki #449 hit exactly that: the
    cause was ``field: "after", code: "future"`` and the first version of this
    helper threw it away, leaving "Strava returned 400 while reading Strava".
    """
    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001 — a non-JSON error body is still an error
        payload = None
    parts: list[str] = []
    if isinstance(payload, dict):
        message = str(payload.get("message") or payload.get("error") or "").strip()
        if message:
            parts.append(message)
        errors = payload.get("errors")
        if isinstance(errors, list):
            for entry in errors[:2]:
                if not isinstance(entry, dict):
                    continue
                where = " ".join(
                    part
                    for part in (
                        str(entry.get("resource") or "").strip(),
                        str(entry.get("field") or "").strip(),
                    )
                    if part
                )
                code = str(entry.get("code") or "").strip()
                if where and code:
                    parts.append(f"{where} ({code})")
                elif where or code:
                    parts.append(where or code)
    suffix = f": {' — '.join(parts)}" if parts else ""
    if resp.status_code == 429:
        return f"Strava rate limit reached while {what} — try again in a few minutes{suffix}"
    if resp.status_code in (401, 403):
        return f"Strava refused the request while {what} (reconnect if this persists){suffix}"
    return f"Strava returned {resp.status_code} while {what}{suffix}"


def _send(
    method: str,
    url: str,
    *,
    headers: Optional[dict[str, str]] = None,
    params: Optional[dict[str, Any]] = None,
    data: Optional[dict[str, Any]] = None,
    auth: Optional[tuple[str, str]] = None,
    what: str = "talking to Strava",
) -> httpx.Response:
    """One request, with the rate-limit behaviour Strava's docs prescribe.

    A 429 carries a ``Retry-After`` (or the reading-window reset headers); a
    single bounded retry keeps a long activity list working without turning a
    persistent quota exhaustion into a hung request.
    """
    attempt = 0
    while True:
        with _client() as client:
            resp = client.request(
                method, url, headers=headers, params=params, data=data, auth=auth
            )
        if resp.status_code == 429 and attempt == 0:
            wait = 0.0
            for header in ("retry-after", "x-ratelimit-read-limit"):
                raw = resp.headers.get(header)
                if raw and raw.strip().isdigit():
                    wait = float(raw) if header == "retry-after" else 0.0
                    break
            attempt += 1
            time.sleep(min(max(wait, 0.5), 5.0))
            continue
        return resp


def _json(resp: httpx.Response, what: str, *, refused: int = 502) -> Any:
    """Decode a response, mapping a refusal to the status the caller acts on.

    ``refused`` is 401 on a REFRESH (the link is dead → "reconnect") but 400 on
    the code exchange (the code was bad, the connection is not), which is why
    the caller chooses it rather than a generic 502 for both.
    """
    if resp.status_code >= 400:
        if resp.status_code == 429:
            raise StravaError(429, _error_detail(resp, what))
        if resp.status_code in (400, 401, 403):
            raise StravaError(refused, _error_detail(resp, what))
        raise StravaError(502, _error_detail(resp, what))
    try:
        return resp.json()
    except Exception as exc:  # noqa: BLE001
        raise StravaError(502, f"Strava returned an unreadable body while {what}") from exc


# ------------------------------------------------------------------- the session
#
# Cookie payload — deliberately small (one cookie, well under the 4 kB limit):
#   v  version
#   a  athlete id           n  athlete name
#   s  granted scopes       r  refresh token   (rotates on every exchange)
#   t  access token         e  access-token expiry (epoch s)
#
# Integrity via HMAC: the value is HttpOnly, but a tampered cookie must not be
# able to point the per-athlete refresh lock at another athlete, nor to swap a
# token in. The token is NOT encrypted — HttpOnly is the protection against
# script access, and encrypting would only hide it from the browser's own
# cookie store, not from anyone who can read it there anyway.


def _cookie_key() -> bytes:
    secret = str(_cfg("STRAVA_COOKIE_SECRET")) or str(_cfg("STRAVA_CLIENT_SECRET"))
    return hmac.new(secret.encode(), b"kiseki-strava-cookie-v1", hashlib.sha256).digest()


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64u(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def encode_session(session: dict[str, Any]) -> str:
    """Sign a session dict into one cookie value."""
    body = json.dumps(session, separators=(",", ":"), sort_keys=True).encode()
    return f"{_b64u(body)}.{_b64u(hmac.new(_cookie_key(), body, hashlib.sha256).digest())}"


def decode_session(value: Optional[str]) -> Optional[dict[str, Any]]:
    """Verify a cookie value; ``None`` for absent/garbled/forged values."""
    if not value or "." not in value:
        return None
    body_b64, sig_b64 = value.split(".", 1)
    try:
        body = _unb64u(body_b64)
        signature = _unb64u(sig_b64)
    except Exception:  # noqa: BLE001 — any decoding failure means "no session"
        return None
    expected = hmac.new(_cookie_key(), body, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(body)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(payload, dict) or payload.get("v") != 1:
        return None
    if not payload.get("r"):
        return None
    return payload


def session_from_token(payload: dict[str, Any], scope: str = "") -> dict[str, Any]:
    """Build the cookie payload from a /oauth/token response."""
    athlete = payload.get("athlete") or {}
    name = " ".join(
        part for part in (athlete.get("firstname"), athlete.get("lastname")) if part
    ).strip()
    return {
        "v": 1,
        "a": athlete.get("id"),
        "n": name or None,
        "s": (payload.get("scope") or scope or "").strip(),
        "r": payload.get("refresh_token"),
        "t": payload.get("access_token"),
        "e": payload.get("expires_at"),
    }


# --------------------------------------------------------------------- oauth flow


def authorize_url(state: str) -> str:
    """The Strava consent screen for this deployment's client."""
    if not enabled():
        raise StravaError(503, "Strava is not configured on this deployment")
    from urllib.parse import urlencode

    query = urlencode(
        {
            "client_id": _cfg("STRAVA_CLIENT_ID"),
            "redirect_uri": redirect_uri(),
            "response_type": "code",
            "approval_prompt": "auto",
            "scope": SCOPES,
            "state": state,
        }
    )
    return f"{OAUTH_AUTHORIZE}?{query}"


def _token_request(refused: int = 502, **fields: Any) -> dict[str, Any]:
    resp = _send(
        "POST",
        OAUTH_TOKEN,
        data={
            "client_id": _cfg("STRAVA_CLIENT_ID"),
            "client_secret": _cfg("STRAVA_CLIENT_SECRET"),
            **fields,
        },
        what="exchanging the token",
    )
    payload = _json(resp, "exchanging the token", refused=refused)
    if not isinstance(payload, dict) or not payload.get("refresh_token"):
        raise StravaError(502, "Strava returned no refresh token")
    return payload


def exchange_code(code: str, scope: str = "") -> dict[str, Any]:
    """Authorization code → session (the one place ``client_secret`` is used)."""
    if not enabled():
        raise StravaError(503, "Strava is not configured on this deployment")
    payload = _token_request(refused=400, grant_type="authorization_code", code=code)
    return session_from_token(payload, scope=scope)


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(athlete_id: Any) -> threading.Lock:
    key = str(athlete_id or "unknown")
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


def refresh(session: dict[str, Any]) -> dict[str, Any]:
    """Exchange the refresh token for a fresh one; the old one dies immediately.

    Serialized per athlete: Strava invalidates the previous refresh token as
    soon as a new one is issued, so two concurrent refreshes would leave one
    caller holding a token that no longer works ("lossy rotation").
    """
    refresh_token = session.get("r")
    if not refresh_token:
        raise StravaNotConnected()
    with _lock_for(session.get("a")):
        try:
            payload = _token_request(
                refused=401, grant_type="refresh_token", refresh_token=refresh_token
            )
        except StravaError as exc:
            if exc.status == 401:  # revoked, expired, or already rotated elsewhere
                raise StravaNotConnected() from exc
            raise
        fresh = session_from_token(payload, scope=str(session.get("s") or ""))
        if not fresh.get("a"):
            fresh["a"] = session.get("a")
        if not fresh.get("n"):
            fresh["n"] = session.get("n")
        return fresh


def access_token_for(session: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """``(session, access_token)`` — refreshed only when it is about to expire."""
    token = session.get("t")
    expires_at = session.get("e") or 0
    try:
        fresh_enough = bool(token) and float(expires_at) - REFRESH_SKEW_S > time.time()
    except (TypeError, ValueError):
        fresh_enough = False
    session = session if fresh_enough else refresh(session)
    return session, str(session["t"])


def revoke(session: dict[str, Any]) -> None:
    """Deauthorize this application for the athlete (HTTP Basic, per docs).

    Best-effort by contract: the caller clears the cookie regardless, because
    "the cookie is gone" is the only thing disconnect actually promises. A
    revocation returns 200 even when the token was already gone.
    """
    token = session.get("r") or session.get("t")
    if not token or not enabled():
        return
    resp = _send(
        "POST",
        OAUTH_REVOKE,
        auth=(str(_cfg("STRAVA_CLIENT_ID")), str(_cfg("STRAVA_CLIENT_SECRET"))),
        data={"token": token, "token_type_hint": "refresh_token"},
        what="disconnecting",
    )
    if resp.status_code >= 400 and resp.status_code not in (400, 401):
        raise StravaError(502, _error_detail(resp, "disconnecting"))


# ------------------------------------------------------------------- api calls


def _api_get(path: str, session: dict[str, Any], params: Optional[dict[str, Any]] = None
             ) -> tuple[dict[str, Any], Any]:
    """Authenticated GET; a 401 forces exactly one refresh-and-retry."""
    session, token = access_token_for(session)
    resp = _send("GET", f"{API_BASE}{path}", headers={"Authorization": f"Bearer {token}"},
                 params=params, what="reading Strava")
    if resp.status_code == 401:
        session = refresh({**session, "t": None, "e": 0})
        resp = _send(
            "GET",
            f"{API_BASE}{path}",
            headers={"Authorization": f"Bearer {session['t']}"},
            params=params,
            what="reading Strava",
        )
    return session, _json(resp, "reading Strava")


def athlete(session: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Verify the connection and read who it is (the status route's proof)."""
    return _api_get("/athlete", session)


def activities(
    session: dict[str, Any],
    *,
    after: Optional[int] = None,
    before: Optional[int] = None,
    per_page: int = 100,
    max_pages: int = 3,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The athlete's activities in a window, oldest page first (paged)."""
    out: list[dict[str, Any]] = []
    page = 1
    while page <= max_pages:
        params: dict[str, Any] = {"page": page, "per_page": min(per_page, 200)}
        if after is not None:
            params["after"] = int(after)
        if before is not None:
            params["before"] = int(before)
        session, batch = _api_get("/athlete/activities", session, params)
        if not isinstance(batch, list):
            raise StravaError(502, "Strava returned an unexpected activity list")
        out.extend(batch)
        if len(batch) < params["per_page"]:
            break
        page += 1
    return session, out


def streams(session: dict[str, Any], activity_id: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """GPS/altitude/time streams — no heart rate: least data that renders."""
    return _api_get(
        f"/activities/{int(activity_id)}/streams",
        session,
        {"keys": "latlng,altitude,time", "key_by_type": "true"},
    )


def activity_detail(session: dict[str, Any], activity_id: int) -> tuple[dict[str, Any], dict[str, Any]]:
    return _api_get(f"/activities/{int(activity_id)}", session)


def photos(session: dict[str, Any], activity_id: int,
           size: int = 2048) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The activity's photos, capture-ordered.

    ``size=2048`` is the largest documented size; §449 records that this
    account has no photo yet, so the size is verified by the fallback below
    rather than by a live sample: a list entry without that key yields the
    largest URL it does carry.
    """
    session, payload = _api_get(
        f"/activities/{int(activity_id)}/photos", session, {"size": size, "photo_sources": "true"}
    )
    if not isinstance(payload, list):
        raise StravaError(502, "Strava returned an unexpected photo list")
    return session, payload


def download_photo(url: str) -> tuple[bytes, str]:
    """Fetch a photo's bytes (a signed CDN URL — no token needed, sent none)."""
    resp = _send("GET", url, what="downloading an activity photo")
    if resp.status_code >= 400:
        raise StravaError(502, _error_detail(resp, "downloading an activity photo"))
    content_type = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    ext = ".png" if "png" in content_type else ".jpg"
    return resp.content, ext


# ------------------------------------------------------------------ streams → GPX


def iso_utc(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def points_from_streams(
    payload: dict[str, Any], start_epoch: Optional[float]
) -> list[tuple[float, float, Optional[float], Optional[str]]]:
    """``[(lat, lng, ele, time)]`` from a keyed streams response.

    The ``time`` stream is seconds *from the activity start*, so timestamps
    need the activity's own start — without it the GPX keeps geometry and
    loses the clock, which the distance/ascent summary does not need but
    ``tracklegs`` (lift-vs-ride) does.
    """

    def data_of(key: str) -> list[Any]:
        entry = payload.get(key)
        if isinstance(entry, dict):
            raw = entry.get("data")
            return raw if isinstance(raw, list) else []
        return entry if isinstance(entry, list) else []

    latlng = data_of("latlng")
    altitude = data_of("altitude")
    offsets = data_of("time")
    points: list[tuple[float, float, Optional[float], Optional[str]]] = []
    for index, pair in enumerate(latlng):
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            continue
        try:
            lat, lng = float(pair[0]), float(pair[1])
        except (TypeError, ValueError):
            continue
        ele: Optional[float] = None
        if index < len(altitude) and altitude[index] is not None:
            try:
                ele = float(altitude[index])
            except (TypeError, ValueError):
                ele = None
        stamp: Optional[str] = None
        if start_epoch is not None and index < len(offsets):
            try:
                stamp = iso_utc(float(start_epoch) + float(offsets[index]))
            except (TypeError, ValueError):
                stamp = None
        points.append((lat, lng, ele, stamp))
    return points


def build_gpx(
    points: list[tuple[float, float, Optional[float], Optional[str]]], name: str = "Strava activity"
) -> bytes:
    """Minimal, standards-valid GPX 1.1 — exactly what :func:`app.gpx.parse_gpx` reads."""
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Kiseki" xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <metadata><name>{_xml_escape(name)}</name></metadata>",
        f"  <trk><name>{_xml_escape(name)}</name><trkseg>",
    ]
    for lat, lng, ele, stamp in points:
        inner = ""
        if ele is not None:
            inner += f"<ele>{ele:.1f}</ele>"
        if stamp:
            inner += f"<time>{_xml_escape(stamp)}</time>"
        lines.append(f'      <trkpt lat="{lat:.7f}" lon="{lng:.7f}">{inner}</trkpt>')
    lines += ["    </trkseg>", "  </trk>", "</gpx>", ""]
    return "\n".join(lines).encode()


def stream_points_for(
    session: dict[str, Any], activity: dict[str, Any]
) -> tuple[dict[str, Any], list[tuple[float, float, Optional[float], Optional[str]]]]:
    """Fetch and convert the streams of one activity."""
    session, payload = streams(session, int(activity["id"]))
    start = activity.get("start_date")
    start_epoch: Optional[float] = None
    if isinstance(start, str) and start:
        try:
            import datetime as _dt

            start_epoch = _dt.datetime.fromisoformat(
                start.replace("Z", "+00:00")
            ).timestamp()
        except ValueError:
            start_epoch = None
    points = points_from_streams(payload if isinstance(payload, dict) else {}, start_epoch)
    if not points:
        raise StravaError(422, "This activity has no GPS stream to import")
    return session, points
