"""HERE Location Services client — Routing v8 → GeoJSON legs, server-side (#15).

Replaces the Google Directions call in maps.py (2026-09 provider decision:
HERE owns kiseki's map plumbing — no "non-Google map" clause, MapLibre is
officially supported, ~10x the free allowance, EEA/NL terms). The browser
never talks to HERE: the backend mints a short-lived OAuth2 bearer token and
calls Routing v8 per consecutive pair, exactly where Google Directions used
to be.

Compliance: HERE results may not be cached/stored outside the platform for
longer than 30 days (Japan routing: 24 h). The in-process route cache in
main.py has a 5-minute TTL — comfortably inside. Nothing persists.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from .config import HERE_ROUTES_URL, HERE_TOKEN_ENDPOINT_URL

# ---------------------------------------------------------------------------
# Flexible Polyline (spec v1 — heremaps/flexible-polyline)
# https://github.com/heremaps/flexible-polyline
# HERE Routing v8 returns route geometry in this encoding — NOT Google's
# encoded-polyline algorithm. Format: [header version: 1 char][header
# content: 1 char][data: signed varints of coordinate deltas].
# ---------------------------------------------------------------------------

_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_VALUES = {c: i for i, c in enumerate(_CHARSET)}


def decode_flexpolyline(encoded: str) -> list[tuple[float, float]]:
    """Decode a HERE flexible polyline (v1) into [(lat, lng), ...].

    Two header characters (version + header content), then signed varint
    deltas of 5-bit chunks (0x20 = continuation). Header content:
    `precision_2d = v & 0xF`, `type_3d = (v >> 4) & 0x7`,
    `precision_3d = (v >> 7) & 0xF`. Returns [] on anything malformed or on
    a 3-dimensional polyline (routing returns 2-d only).
    """
    if len(encoded) < 2:
        return []
    version = _VALUES.get(encoded[0])
    header = _VALUES.get(encoded[1])
    if version != 1 or header is None:
        return []  # unknown spec version
    precision = header & 0xF
    if (header >> 4) & 0x7:  # 3rd dimension present — not supported
        return []

    values: list[int] = []
    next_value = 0
    shift = 0
    for ch in encoded[2:]:
        chunk = _VALUES.get(ch)
        if chunk is None:
            return []  # character outside the charset — malformed input
        is_last = (chunk & 0x20) == 0
        next_value = ((chunk & 0x1F) << shift) | next_value
        shift += 5
        if is_last:
            if next_value & 1:  # sign bit — negative
                values.append(-((next_value + 1) >> 1))
            else:
                values.append(next_value >> 1)
            next_value = 0
            shift = 0

    scale = 10**precision
    coords: list[tuple[float, float]] = []
    lat = lng = 0
    for i in range(0, len(values) - 1, 2):
        lat += values[i]
        lng += values[i + 1]
        coords.append((lat / scale, lng / scale))
    return coords


# ---------------------------------------------------------------------------
# OAuth 2.0 bearer token (RFC 5849 HMAC-SHA256 signed client_credentials)
# ---------------------------------------------------------------------------


def _enc(s: str) -> str:
    return urllib.parse.quote(s, safe="-_.~")


def _signature_base(method: str, url: str, params: dict) -> str:
    norm = "&".join(f"{_enc(k)}={_enc(params[k])}" for k in sorted(params))
    return "&".join([method.upper(), _enc(url), _enc(norm)])


def get_here_token(
    access_key_id: str,
    access_key_secret: str,
    token_url: str | None = None,
) -> tuple[int, dict]:
    """Mint a HERE OAuth2 bearer token (24 h validity).

    HERE's token endpoint rejects Basic auth and body client_credentials —
    the request must carry an OAuth1-flavoured ``Authorization`` header
    (``oauth_consumer_key`` = Access Key ID) signed with the Access Key Secret
    via HMAC-SHA256 (docs.here.com IAM "python-oauth-token"). Returns
    (status, json); on success json["access_token"] / json["expires_in"].
    """
    token_url = token_url or HERE_TOKEN_ENDPOINT_URL
    body_params = {"grant_type": "client_credentials"}
    oauth = {
        "oauth_consumer_key": access_key_id,
        "oauth_nonce": secrets.token_urlsafe(16),
        "oauth_signature_method": "HMAC-SHA256",
        "oauth_timestamp": str(int(time.time())),
        "oauth_version": "1.0",
    }
    all_params = {**body_params, **oauth}
    base = _signature_base("POST", token_url, all_params)
    key = _enc(access_key_secret) + "&"
    sig = base64.b64encode(
        hmac.new(key.encode(), base.encode(), hashlib.sha256).digest()
    ).decode()
    oauth["oauth_signature"] = sig
    headers = {
        "Authorization": "OAuth " + ", ".join(
            f'{k}="{_enc(oauth[k])}"' for k in sorted(oauth)
        ),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    req = urllib.request.Request(
        token_url,
        data=urllib.parse.urlencode(body_params).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, {"_err": e.read()[:300].decode("utf-8", "replace")}


# ---------------------------------------------------------------------------
# Routing v8 — one driving leg
# ---------------------------------------------------------------------------


def _fmt_duration(seconds: float | None) -> str | None:
    """Seconds → human text close to the old Google style ("1 hour 35 mins")."""
    if seconds is None:
        return None
    total = max(1, int(seconds))
    mins, secs = divmod(total, 60)
    if mins < 60:
        return f"{mins} mins" if secs or mins else "1 min"
    hours, mins = divmod(mins, 60)
    unit = "hour" if hours == 1 else "hours"
    return f"{hours} {unit} {mins} mins" if mins else f"{hours} {unit}"


def _fmt_distance(meters: float | None) -> str | None:
    """Meters → "143 km" / "57.4 km" style text (was Google's text form)."""
    if meters is None:
        return None
    km = meters / 1000.0
    if km >= 100:
        return f"{km:.0f} km"
    return f"{km:.1f} km"


def route_leg_v8(
    a: tuple[str, float, float],
    b: tuple[str, float, float],
    token: str,
    *,
    transport_mode: str = "car",
) -> dict | None:
    """Single HERE Routing v8 leg — road geometry when available, else None.

    Returns a dict with keys the route-surface consumer expects
    (``points`` = flat [(lat, lng), ...] so callers don't reshape), or None
    when there is no road route (flight/ferry) or the request fails.

    ``transport_mode`` overrides the default ``car``. HERE Routing v8 has no
    ``train`` mode (car/truck/pedestrian/bicycle/scooter/taxi/bus/
    privateBus/transit are the set) — rail legs keep the car default, which
    at least follows the access road.
    """
    params = {
        "apiKey": token,
        "transportMode": transport_mode,
        "routingMode": "fast",
        "origin": f"{a[1]},{a[2]}",
        "destination": f"{b[1]},{b[2]}",
        "return": "polyline,summary",
    }
    url = HERE_ROUTES_URL + "?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as resp:
            js = json.load(resp)
        route = js["routes"][0]
        return {
            "points": decode_flexpolyline(route["sections"][0]["polyline"]),
            "summary": route["sections"][0]["summary"],
        }
    except (urllib.error.HTTPError, KeyError, IndexError, ValueError):
        return None