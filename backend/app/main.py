"""Kiseki API + SPA server.

One process, one container:
  - /api/health, /api/trips/<id>, /api/trips/<id>/booklet.pdf (visibility-gated, #64)
  - /media/**        → trip images, proxied from the Garage S3 bucket (#47)
  - everything else  → the built React SPA (backend/app/static) with
                       history-mode fallback to index.html
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .acl import authorize_trip_path, require_trip_role
from .auth import AuthSession, get_current_session, get_current_user
from .claims import ClaimError, claim_identity, follow_via_claim, trip_by_claim_token
from .config import LISTEN_PORT, MAPS_KEY, STATIC_DIR
from .maps import resolve_places, route_legs
from .media import (
    get_media_store,
    is_valid_media_path,
    media_content_type,
    object_key_for,
    resolve_media_urls,
)
from .models import Trip
from .ratelimit import allow
from .pdf import render_booklet_pdf
from .store import get_trip_by_id as get_trip_by_id_store
from .store import list_trips_for_user

app = FastAPI(title="Kiseki", version="0.1.0")

# One render at a time per trip (booklet.pdf). Two concurrent renders double
# the SwiftShader/WebGL memory and the loser comes out with grey maps.
_PDF_RENDER_LOCKS: dict[str, asyncio.Lock] = {}

# The per-trip lock above collapses double-clicks on ONE trip; it does nothing
# about two DIFFERENT trips rendering at once, which is the case that OOMs the
# pod (~2GiB each). Since #64 a public trip's booklet is reachable anonymously,
# so that case is now reachable without an account: cap concurrent renders
# globally at one and let the rest queue behind it.
_PDF_RENDER_SLOT = asyncio.Semaphore(1)

# Directions results, keyed on (trip_id, places, loop) -> (expiry, legs). Every
# map view would otherwise be one Google call per leg, on every mount.
_route_cache: dict[tuple, tuple[float, list[dict]]] = {}
_ROUTE_TTL = 300.0


def _public_trip(trip: Trip, my_role: str | None = None) -> dict:
    """Serialize a trip for API responses.

    ``claimToken`` is a SECRET (issue #6) — it is stripped from every trip
    document response, including anonymous/public ones. The join link is only
    obtainable via the owner-only ``/join-link`` endpoint. ``my_role`` (the
    caller's crew role on this trip) is attached for authenticated responses.

    Media fields are stored as BARE filenames in the data (trip.json / graph);
    the API canonicalizes them to ``/media/<trip.$dtId>/<file>`` so consumers
    only ever see full URLs, namespaced by the trip's durable id — never the
    repo-folder slug (#47 follow-up).
    """
    data = trip.model_dump(by_alias=True)
    data.pop("claimToken", None)
    resolve_media_urls(data, trip.id)
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
    ``{trip_id}`` route so the bare path is never captured by it.
    Summary covers are stored as bare filenames in the graph; canonicalize
    them to ``/media/<trip.$dtId>/<file>`` like full trip documents.
    """
    trips = list_trips_for_user(user["sub"])
    for row in trips:
        if isinstance(row, dict) and row.get("dtId"):
            resolve_media_urls(row, row["dtId"])
    return {"trips": trips}


@app.get("/api/trips/by-claim/{claim_token}")
def trip_by_claim(claim_token: str) -> dict:
    """Join-link read (issue #6): the trip behind a claim token.

    Authorized by possession of the claim token (the invite) — same trust
    model as the share link. Serves the trip + crew so the join page can
    offer 'This is me' claiming. Registered BEFORE /api/trips/{trip_id}
    so 'by-claim' is never swallowed by the generic route.
    """
    trip = trip_by_claim_token(claim_token)
    if trip is None:
        raise HTTPException(status_code=404, detail="Unknown join link")
    return _public_trip(trip)


class ClaimRequest(BaseModel):
    claimToken: str
    personId: str


class FollowRequest(BaseModel):
    claimToken: str


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


@app.post("/api/claims/follow")
def follow_claim(
    body: FollowRequest,
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Follow a trip via its claimToken (#65).

    Non-crew followers get a `hasCrew` edge with `role=follower`.
    Private trips require the invite; public trips can be followed
    optionally (read already works anonymously). Idempotent if already
    on the crew — returns the trip without error.
    """
    try:
        trip = follow_via_claim(body.claimToken, session.user["sub"], session.profile)
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
    if not trip.claimToken:
        raise HTTPException(status_code=404, detail="No invite link for this trip")
    return {"joinUrl": f"/join/{trip.claimToken}"}


@app.get("/api/trips/{trip_id}")
def get_trip(
    trip_id: str,
    my_role: str | None = Depends(authorize_trip_path),
) -> dict:
    """Read a trip — single id route, gated by visibility (#64).

    - visibility == "public"  → anyone (no auth), myRole returned if the
      caller happens to be authenticated and on the crew.
    - visibility == "private" → requires valid Auth0 token + crew role
      (follower+, #65). The ACL is enforced by ``authorize_trip_path``.

    ``claimToken`` is always stripped from the response.
    """
    trip = get_trip_by_id_store(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    return _public_trip(trip, my_role=my_role)


@app.get("/api/trips/{trip_id}/booklet.pdf")
async def booklet_pdf(
    request: Request,
    trip_id: str,
    _: str | None = Depends(authorize_trip_path),
    authorization: str | None = Header(default=None),
) -> FileResponse:
    """Trip booklet PDF (#13) — same visibility gate as the trip itself.

    Public trips: anyone may download (no auth needed). Private trips: JWT +
    crew role required (via ``authorize_trip_path``). The renderer's SPA page
    loads the trip, so the caller's access token (if any) is forwarded to
    the headless browser (injected as a page global by pdf.py).

    A render takes ~40s of SwiftShader + up to 2GiB (15 live WebGL contexts) —
    by far the most expensive thing the pod does, and since #64 the public-trip
    path reaches it with no account. Two bounds, because they stop different
    things:

    - **Rate limit** (per client, like the map proxies): a handful of renders a
      minute is well above real use — nobody clicks PDF five times a minute —
      and it stops one caller looping the endpoint.
    - **Global single-flight** (``_PDF_RENDER_SLOT``): the per-trip lock only
      collapses repeat clicks on the SAME trip; concurrent renders of two
      different trips are what OOMs the pod, so renders serialize pod-wide.

    The per-trip lock stays on top of both: every waiter on one trip reuses the
    SAME finished file, so a double-click still costs one render, not two.
    """
    _rate_limit(request, "booklet", 5)
    trip = get_trip_by_id_store(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    access_token = None
    if authorization and authorization.lower().startswith("bearer "):
        access_token = authorization.split(" ", 1)[1].strip() or None
    render_key = trip_id.lower()
    lock = _PDF_RENDER_LOCKS.setdefault(render_key, asyncio.Lock())
    # Serialize: every waiter reuses the SAME finished file, so a double-click
    # costs one render, not two — and never serves a half-written PDF.
    async with lock:
        fd, path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        base_url = f"http://127.0.0.1:{LISTEN_PORT}"
        try:
            # Pod-wide: one render at a time, whatever the trip.
            async with _PDF_RENDER_SLOT:
                await render_booklet_pdf(base_url, render_key, Path(path), access_token=access_token)
        except Exception as exc:
            Path(path).unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"PDF rendering failed: {exc}") from exc
        return FileResponse(
            path,
            media_type="application/pdf",
            filename=f"{trip.slug}-booklet.pdf",
            background=BackgroundTask(lambda: Path(path).unlink(missing_ok=True)),
        )


# --- Map proxy (#18/#27/#37) ------------------------------------------------
#
# The browser renders MapLibre over keyless tiles; only the driving route still
# needs Google (Directions), served server-side so the key never leaves the
# backend. Static Maps proxy is GONE (#37): the booklet renders the SAME
# MapLibre map live via Playwright (Chromium + SwiftShader), so screen and
# paper share basemap / marker numbering / route colours. #27 removed the
# client-side key; #37 removed the last server-side static-map surface.
#
# Loopback is our own headless PDF renderer (app/pdf.py). Nothing else can
# reach the app on 127.0.0.1.
_LOCAL = {"127.0.0.1", "::1", "localhost"}


def _client_id(request: Request) -> str:
    """Best-effort caller identity for rate limiting.

    Behind the cluster ingress every request carries the ingress' own address,
    so trust the first X-Forwarded-For hop — without it the whole internet
    shares one bucket and the limit protects nothing. It is spoofable, which is
    acceptable: this is an abuse bound, not an authorization control (a leaked
    visibility:private id is an unguessable UUID, not a secret derived from
    content; rate limiting is the abuse bound).
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


def _trip_for_map(trip_id: str) -> Trip:
    """Resolve a map request's trip by $dtId.

    Since #64 the map proxy is id-only (the trip link is the id, gated by
    visibility). No token form remains. Callers get 404 on an unknown id.
    """
    trip = get_trip_by_id_store(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    return trip


@app.get("/api/maps/key")
def maps_key() -> Response:
    """Gone (#27) — the Google key is server-side only now.

    Kept as an explicit 404 rather than deleted: without it the SPA catch-all
    would answer this path with a 200 and the index shell, which reads like the
    endpoint still exists.
    """
    raise HTTPException(status_code=404, detail="Removed — the Maps key is server-side only")


@app.get("/api/maps/route/{trip_id}")
def maps_route(
    request: Request,
    trip_id: str,
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
    trip = _trip_for_map(trip_id)
    if not MAPS_KEY:
        raise HTTPException(status_code=404, detail="Maps not configured")
    resolved = resolve_places(trip, [p for p in places.split(",") if p.strip()])
    if len(resolved) < 2:
        raise HTTPException(status_code=404, detail="Need at least two resolvable places")
    cache_key = (trip.id, tuple(resolved), bool(loop))
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


# Trip media (covers, gallery images) — referenced as /media/<trip_id>/<file>.
# Issue #47: objects live in the Garage S3 bucket (private) and are streamed
# through this proxy. The trip segment is the trip's $dtId (dashed UUID) — the
# durable identity, NOT the repo-folder slug (which is organizational and can
# collide). Data stores bare filenames; the serializer (_public_trip) prefixes
# them into this URL shape, so frontend / PDF / graph are unchanged. When no
# media store is configured (dev / CI without bucket AND no baked assets),
# the route serves 404 as-is rather than mounting a non-existent directory.
@app.get("/media/{trip_id}/{file_name}", include_in_schema=False)
def media_file(trip_id: str, file_name: str) -> Response:
    """Stream a trip media object from the configured store.

    The first path segment is the trip's ``$dtId`` (dashed UUID) — the durable
    identity — never the repo-folder slug. It is structurally validated first
    (as is the flat file name): a ``..`` or encoded-slash traversal lands here
    as a 404 with no filesystem/bucket lookup. When valid, the store is asked
    for the bytes; a miss is a 404 (not a 500). This is the single seam where
    a future crew-level media ACL (#64) will plug in.
    """
    if not is_valid_media_path(trip_id, file_name):
        raise HTTPException(404, "Not Found")
    store = get_media_store()
    if store is None:
        raise HTTPException(404, "Not Found")
    chunks = store.get(object_key_for(trip_id, file_name))
    if chunks is None:
        raise HTTPException(404, "Not Found")
    return StreamingResponse(
        chunks,
        media_type=media_content_type(file_name),
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


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
    def spa(full_path: str, request: Request) -> Response:
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and STATIC_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        # SPA shell — trip routes get a noindex robots meta + header (private links)
        is_trip = full_path.startswith("t/") or full_path == "t"
        headers = {}
        if is_trip:
            headers["X-Robots-Tag"] = "noindex, nofollow, noai, noimageai"
        # PDF render (#58): the booklet.pdf endpoint already enforced visibility +
        # crew role, so it forwards the caller's Bearer token on the loopback GET to
        # this /t/<id>/booklet route. Strip it into a window global so the SPA
        # can attach it to its own /api/* fetches — no Auth0 login required.
        html = _TRIP_HTML if is_trip else _index_html
        auth = request.headers.get("Authorization", "")
        if is_trip and auth.lower().startswith("bearer "):
            token = auth.split(" ", 1)[1].strip()
            if token:
                html = html.replace(
                    "<title>",
                    f'<script>window.__KISEKI_ACCESS_TOKEN__="{token}";</script><title>',
                    1,
                )
        return Response(
            content=html,
            media_type="text/html",
            headers=headers,
        )
