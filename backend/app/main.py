"""Kiseki API + SPA server.

One process, one container:
  - /api/health, /api/trips/<token>, /api/trips/<token>/booklet.pdf
  - /media/**        → trip images (backend/data/assets)
  - everything else  → the built React SPA (backend/app/static) with
                       history-mode fallback to index.html
"""

from __future__ import annotations

import os
import tempfile
import time
import urllib.request
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .acl import authorize_trip_path, is_trip_id, require_trip_role
from .auth import AuthSession, get_current_session, get_current_user
from .claims import ClaimError, claim_identity, trip_by_claim_token
from .config import ASSETS_DIR, LISTEN_PORT, MAPS_KEY, STATIC_DIR
from .maps import (
    build_single_place_url,
    build_static_map_url,
    build_static_map_url_legs,
    directions_polyline,
    resolve_places,
    resolve_query,
    route_legs,
)
from .models import Trip
from .ratelimit import allow
from .pdf import render_booklet_pdf
from .store import get_trip_by_id as get_trip_by_id_store
from .store import get_trip_by_token, list_trips_for_user

app = FastAPI(title="Kiseki", version="0.1.0")

# Directions results, keyed on (token, places, loop) -> (expiry, legs). Every
# map view would otherwise be one Google call per leg, on every mount.
_route_cache: dict[tuple, tuple[float, list[dict]]] = {}
_ROUTE_TTL = 300.0


def _public_trip(trip: Trip, my_role: str | None = None) -> dict:
    """Serialize a trip for API responses.

    ``claimToken`` is a SECRET (issue #6) — it is stripped from every trip
    document response, including anonymous/public ones. The join link is only
    obtainable via the owner-only ``/join-link`` endpoint. ``my_role`` (the
    caller's crew role on this trip) is attached for authenticated responses.
    """
    data = trip.model_dump(by_alias=True)
    data.pop("claimToken", None)
    if my_role:
        data["myRole"] = my_role
    return data


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(user: dict = Depends(get_current_user)) -> dict:
    """Who am I — identity from a validated Auth0 access token.

    `sub` is the stable user identity (future ACLs, #5/#6). Profile claims
    (email/name/picture) are only included when the token carries them — by
    default they live in the ID token; the access token always has `sub`."""
    return {
        "sub": user["sub"],
        **{
            k: user[k]
            for k in ("email", "name", "picture", "email_verified")
            if k in user
        },
    }


@app.get("/api/trips")
def my_trips(user: dict = Depends(get_current_user)) -> dict:
    """The caller's trips (issue #7 — logged-in landing).

    Requires a valid Auth0 token; returns the trips the user has a crew role
    on (via ``hasCrew``), with that role. Registered before the
    ``{trip_param}`` route so the bare path is never captured by it.
    """
    return {"trips": list_trips_for_user(user["sub"])}


@app.get("/api/trips/by-claim/{claim_token}")
def trip_by_claim(claim_token: str) -> dict:
    """Join-link read (issue #6): the trip behind a claim token.

    Authorized by possession of the claim token (the invite) — same trust
    model as the share link. Serves the trip + crew so the join page can
    offer 'This is me' claiming. Registered BEFORE /api/trips/{trip_param}
    so 'by-claim' is never swallowed by the generic route.
    """
    trip = trip_by_claim_token(claim_token)
    if trip is None:
        raise HTTPException(status_code=404, detail="Unknown join link")
    return _public_trip(trip)


class ClaimRequest(BaseModel):
    claimToken: str
    personId: str


@app.post("/api/claims")
def create_claim(
    body: ClaimRequest,
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Claim a crew identity on a trip (issue #6).

    Requires a valid Auth0 token AND the trip's claim token. The claim token
    is what makes this an *invite*: the read link alone can never grant an
    identity.
    """
    try:
        trip = claim_identity(
            body.claimToken,
            body.personId,
            session.user["sub"],
            session.profile,
        )
    except ClaimError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return _public_trip(trip)


@app.get("/api/trips/{trip_id}/join-link")
def trip_join_link(
    trip_id: str,
    _: None = Depends(require_trip_role("owner")),
) -> dict:
    """Owner-only: the trip's join link (issue #6).

    The ``claimToken`` is never included in trip documents — this is the ONLY
    way to obtain the join link, and it requires the ``owner`` crew role
    (crews manage their own invites).
    """
    trip = get_trip_by_id_store(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    return {"joinUrl": f"/join/{trip.claimToken}"}


@app.get("/api/trips/{trip_param}")
def get_trip(
    trip_param: str,
    my_role: str | None = Depends(authorize_trip_path),
) -> dict:
    """Read a trip — two paths in one route, distinguished by param SHAPE:

    - ``/api/trips/<dashed-uuid>`` → the trip ``$dtId``: PROTECTED (Auth0
      token + crew role, see ``app/acl.py``) — issue #5.
    - ``/api/trips/<token>``       → the secret share link: public-by-link,
      no auth (stays the anonymous share flow).

    Both return the same trip document shape (``claimToken`` always stripped).
    The protected path additionally reports the caller's ``myRole``.
    """
    if is_trip_id(trip_param):
        trip = get_trip_by_id_store(trip_param.lower())
    else:
        trip = get_trip_by_token(trip_param)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    return _public_trip(trip, my_role=my_role)


@app.get("/api/trips/{trip_param}/booklet.pdf")
async def booklet_pdf(
    trip_param: str,
    _: str | None = Depends(authorize_trip_path),
    authorization: str | None = Header(default=None),
) -> FileResponse:
    """Crew-only PDF booklet (issue #13).

    The booklet is a CREW feature: the endpoint is id-based and protected
    (JWT + crew role via ``authorize_trip_path`` — the param must be named
    ``trip_param`` for FastAPI to bind the dependency's path param), so it
    works for private trips too (no share token needed). The renderer's SPA
    page loads the PROTECTED trip, so the caller's access token is forwarded
    to the headless browser (it seeds the page's auth0 session cache).
    """
    trip = get_trip_by_id_store(trip_param.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    access_token = None
    if authorization and authorization.lower().startswith("bearer "):
        access_token = authorization.split(" ", 1)[1].strip() or None
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    base_url = f"http://127.0.0.1:{LISTEN_PORT}"
    try:
        await render_booklet_pdf(base_url, trip_param.lower(), Path(path), access_token=access_token)
    except Exception as exc:
        Path(path).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"PDF rendering failed: {exc}") from exc
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=f"{trip.slug}-booklet.pdf",
        background=BackgroundTask(lambda: Path(path).unlink(missing_ok=True)),
    )


# --- Map proxies (#18/#27) -----------------------------------------------
#
# The browser never talks to Google. It renders MapLibre over keyless tiles and
# asks US for anything that needs the key. That makes /api/maps/* the thing
# worth protecting: every endpoint below is scoped to a valid trip token and
# rate-limited so a shared link cannot be turned into a free Google quota.

# Loopback is our own headless PDF renderer (app/pdf.py) fetching a booklet's
# worth of static maps in one burst from inside the pod — limiting it would
# just break the booklet. Nothing else can reach the app on 127.0.0.1.
_LOCAL = {"127.0.0.1", "::1", "localhost"}


def _client_id(request: Request) -> str:
    """Best-effort caller identity for rate limiting.

    Behind the cluster ingress every request carries the ingress' own address,
    so trust the first X-Forwarded-For hop — without it the whole internet
    shares one bucket and the limit protects nothing. It is spoofable, which is
    acceptable: this is an abuse bound, not an authorization control (the trip
    token is the control).
    """
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit(request: Request, bucket: str, limit: int) -> None:
    client = _client_id(request)
    if client in _LOCAL:
        return
    if not allow(bucket, client, limit=limit):
        raise HTTPException(status_code=429, detail="Too many map requests")


@app.get("/api/maps/key")
def maps_key() -> Response:
    """Gone (#27) — the Google key is server-side only now.

    Kept as an explicit 404 rather than deleted: without it the SPA catch-all
    would answer this path with a 200 and the index shell, which reads like the
    endpoint still exists.
    """
    raise HTTPException(status_code=404, detail="Removed — the Maps key is server-side only")


@app.get("/api/maps/route/{token}")
def maps_route(
    request: Request,
    token: str,
    places: str = Query(..., description="comma-separated place names"),
    loop: int = Query(0, description="1 = close the loop back to the start"),
) -> dict:
    """Real driving route as GeoJSON — what the MapLibre map draws (#18).

    One leg per consecutive pair (the loop closes back to the start), exactly
    the shape the Google JS map produced client-side. `duration` is the live
    `duration_in_traffic` value behind the drive-time chip; a leg with no road
    route comes back `road: false` with a straight line for the client to dash.
    """
    _rate_limit(request, "route", 60)
    trip = get_trip_by_token(token)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    if not MAPS_KEY:
        raise HTTPException(status_code=404, detail="Maps not configured")
    resolved = resolve_places(trip, [p for p in places.split(",") if p.strip()])
    if len(resolved) < 2:
        raise HTTPException(status_code=404, detail="Need at least two resolvable places")
    cache_key = (token, tuple(resolved), bool(loop))
    hit = _route_cache.get(cache_key)
    now = time.monotonic()
    if hit and hit[0] > now:
        return {"legs": hit[1]}
    legs = route_legs(resolved, MAPS_KEY, loop=bool(loop))
    if len(_route_cache) > 512:
        _route_cache.clear()
    # Short TTL: the geometry is stable but `duration` is live traffic, and a
    # chip labelled "live" should not be quarter-hour-old.
    _route_cache[cache_key] = (now + _ROUTE_TTL, legs)
    return {"legs": legs}


@app.get("/api/maps/static/{token}")
def maps_static(
    request: Request,
    token: str,
    places: str = Query(..., description="comma-separated place names"),
    loop: int = Query(0, description="1 = close the loop back to the start"),
    q: str | None = Query(None, description="geocode query — pins the map at the EXACT spot (hotel, not town)"),
) -> Response:
    """Static map proxy: real driving route (Directions API, key stays server-side)
    rendered as an encoded polyline + numbered markers. Used by the booklet PDF.

    Still the print path after #18 — replacing it with a MapLibre render is #37."""
    _rate_limit(request, "static", 240)
    trip = get_trip_by_token(token)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    if not MAPS_KEY:
        raise HTTPException(status_code=404, detail="Maps not configured")
    resolved = resolve_places(trip, [p for p in places.split(",") if p.strip()])
    if len(resolved) < 1:
        raise HTTPException(status_code=404, detail="No resolvable places")
    # route color = trip theme (theme.primary is a hex like #1e3a8a → 0x1e3a8a)
    path_color = "0x" + (trip.theme.primary or "1e3a8a").lstrip("#")
    if len(resolved) == 1:
        # single place (hotel / restaurant card thumbnail): centered pin map —
        # geocoded to the EXACT spot when `q` is given, else the town centre
        place = resolved[0]
        if q:
            hit = resolve_query(q, MAPS_KEY)
            if hit:
                name, _, _ = place
                place = (name, hit[0], hit[1])
        url = build_single_place_url(place, MAPS_KEY)
    else:
        # Primary: one combined route (origin→waypoints→dest; loop = origin==dest) —
        # compact URL, renders fully with RAW pipes + enc LAST (verified). Fallback:
        # per-leg paths (short calls, straight lines for non-drive legs) — also the
        # future mixed-transport shape.
        polyline = directions_polyline(resolved, MAPS_KEY, loop=bool(loop))
        if polyline:
            url = build_static_map_url(resolved, MAPS_KEY, polyline=polyline, loop=bool(loop), path_color=path_color)
        else:
            url = build_static_map_url_legs(resolved, MAPS_KEY, loop=bool(loop), path_color=path_color)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            body = resp.read()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Static map fetch failed: {exc}") from exc
    return Response(
        content=body,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# Trip media (covers, gallery images) — referenced as /media/<trip>/<file>
if ASSETS_DIR.is_dir():
    app.mount("/media", StaticFiles(directory=ASSETS_DIR), name="media")

# Built SPA with history-mode fallback
if STATIC_DIR.is_dir() and (STATIC_DIR / "index.html").is_file():
    _index = STATIC_DIR / "index.html"
    _index_html = _index.read_text()

    # Trip pages are private (secret links, no auth) — keep search engines AND
    # AI crawlers out: robots meta injected into the shell + X-Robots-Tag header.
    _NOINDEX_META = '<meta name="robots" content="noindex, nofollow, noai, noimageai" />'
    _TRIP_HTML = _index_html.replace("<title>", f"{_NOINDEX_META}\n    <title>")

    @app.get("/robots.txt", include_in_schema=False)
    def robots_txt() -> PlainTextResponse:
        return PlainTextResponse(
            "User-agent: *\n"
            "Disallow: /t/\n"
            "Disallow: /api/\n"
            "Disallow: /media/\n"
            "\n"
            "User-agent: GPTBot\n"
            "Disallow: /\n"
            "\n"
            "User-agent: CCBot\n"
            "Disallow: /\n"
            "\n"
            "User-agent: anthropic-ai\n"
            "Disallow: /\n"
            "\n"
            "User-agent: ClaudeBot\n"
            "Disallow: /\n"
            "\n"
            "User-agent: Google-Extended\n"
            "Disallow: /\n"
            "\n"
            "User-agent: PerplexityBot\n"
            "Disallow: /\n"
            "\n"
            "User-agent: Amazonbot\n"
            "Disallow: /\n"
            "\n"
            "User-agent: Bytespider\n"
            "Disallow: /\n"
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> Response:
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and STATIC_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        # SPA shell — trip routes get a noindex robots meta + header (private links)
        is_trip = full_path.startswith("t/") or full_path == "t"
        headers = {}
        if is_trip:
            headers["X-Robots-Tag"] = "noindex, nofollow, noai, noimageai"
        return Response(
            content=_TRIP_HTML if is_trip else _index_html,
            media_type="text/html",
            headers=headers,
        )
