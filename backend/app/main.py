"""Kiseki API + SPA server.

One process, one container:
  - /api/health, /api/trips/<id>, /api/trips/<id>/booklet.pdf (visibility-gated, #64)
  - /media/**        → trip images, proxied from the Garage S3 bucket (#47)
  - everything else  → the built React SPA (backend/app/static) with
                       history-mode fallback to index.html
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
import time
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .acl import (
    authorize_trip_path,
    require_trip_owner,
    require_trip_role,
    require_user_token,
    resolve_actor_sub,
    resolve_request_actor_sub,
)
from .auth import AuthSession, get_current_session, get_current_user
from .chat import (
    ChatRequest,
    RunGone,
    SSE_DONE,
    TurnRequest,
    attach_turn_stream,
    build_run_body,
    error_chunk,
    get_turn,
    latest_turn_for_thread,
    new_turn_key,
    require_actor_trip_access,
    sse_data,
    start_turn,
    stop_chat_run,
    thread_scope,
    turn_key_for,
    turn_status_payload,
)
from .claims import (
    ClaimError,
    claim_identity,
    follow_trip_by_id,
    follow_via_claim,
    follow_via_follow_token,
    trip_by_claim_token,
    trip_by_follow_token,
)
from .erasure import ErasureError, erase_account, export_account
from .feed import FEED_LIMIT_DEFAULT, build_feed, is_iso_timestamp
from .config import (
    HERE_ACCESS_KEY_ID,
    HERE_ACCESS_KEY_SECRET,
    HERE_TOKEN_ENDPOINT_URL,
    LISTEN_PORT,
    STATIC_DIR,
)
from . import write as write_svc
from . import photos as photos_svc
from .exif import extract_exif
from .write import (
    BlockCreate,
    BlockFields,
    BlockMove,
    BlockOrder,
    CrewAdd,
    CrewPatch,
    DayCreate,
    DayPatch,
    FeaturesPatch,
    FeaturesPut,
    LocationsPatch,
    LocationsPut,
    PracticalPut,
    SectionCreate,
    SectionPatch,
    TodoAdd,
    TodoToggle,
    TricountConnect,
    TripCreate,
    TripPatch,
    WriteError,
)
from .maps import resolve_places, route_legs
from .here import get_here_token, route_leg_v8
from .places import place_details, search_place, photo_by_name as place_photo_bytes
from .graph.client import SHOWCASE_LIMIT_DEFAULT, GraphWriteError, clamp_showcase_limit
from .graph.convert import GraphNotFound
from .media import (
    RangeNotSatisfiable,
    UnsupportedUpload,
    UploadTooLarge,
    content_addressed_key,
    get_media_store,
    is_valid_media_name,
    is_valid_media_path,
    is_video_name,
    key_from_digest,
    media_content_type,
    normalize_upload,
    object_key_for,
    parse_byte_range,
    poster_name_for,
    require_upload_kind,
    resolve_media_urls,
    stream_upload,
    to_jpeg,
    upload_kind,
    upload_limit,
)
from .models import Trip
from .ratelimit import allow
from .pdf import render_booklet_pdf
from .tricount import TriCountError, fetch_snapshot
from .store import get_trip_by_id as get_trip_by_id_store
from .store import get_graph_client
from .store import list_showcase_trips
from .store import list_trips_for_user

app = FastAPI(title="Kiseki", version="0.1.0")


class _RawPathTraversalGuard:
    """Reject encoded traversal before routing (pre-existing test failures).

    Starlette decodes ``%2F`` into a real ``/`` BEFORE route matching, so
    ``/media/<uuid>/..%2F..%2Fsecret.jpg`` arrives at the SPA catch-all as
    ``media/<uuid>/../../secret.jpg`` and the catch-all answers with the
    index shell (200). ``request.url.path`` is already decoded by then, so
    no in-handler check can see the attack — the guard must run on the raw
    ASGI ``scope["raw_path"]`` (bytes, still encoded), ahead of routing.
    Pure ASGI (not BaseHTTPMiddleware) so nothing re-decodes the path.
    """

    # Raw (still-encoded) markers that never appear in a legitimate request
    # under these prefixes: encoded slash / backslash / NUL.
    _ENCODED_MARKERS = (b"%2f", b"%5c", b"%00")

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            raw = bytes(scope.get("raw_path", b"") or b"").lower()
            if raw.startswith((b"/media", b"/inbox", b"/api/maps/static")) and any(
                m in raw for m in self._ENCODED_MARKERS
            ):
                response = JSONResponse({"detail": "Not Found"}, status_code=404)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(_RawPathTraversalGuard)

# One render at a time per trip (booklet.pdf). Two concurrent renders double
# the SwiftShader/WebGL memory and the loser comes out with grey maps.
_PDF_RENDER_LOCKS: dict[str, asyncio.Lock] = {}

# The per-trip lock above collapses double-clicks on ONE trip; it does nothing
# about two DIFFERENT trips rendering at once, which is the case that OOMs the
# pod (~2GiB each). Since #64 a public trip's booklet is reachable anonymously,
# so that case is now reachable without an account: cap concurrent renders
# globally at one and let the rest queue behind it.
_PDF_RENDER_SLOT = asyncio.Semaphore(1)

# Route results, keyed on (trip_id, places, loop) -> (expiry, legs). Every# map view would otherwise be one HERE call per leg, on every mount.
_route_cache: dict[tuple, tuple[float, list[dict]]] = {}
_ROUTE_TTL = 300.0

# HERE OAuth2 bearer token, minted once and reused (valid ~24 h; refreshed
# lazily when under 15 minutes remain). RFC 5849 client_credentials — the
# token endpoint rejects Basic/body auth, see app/here.get_here_token.
_here_bearer_cache: tuple[str, float] | None = None


def here_bearer_token() -> str | None:
    """Return a valid HERE bearer token, minting/refreshing as needed.

    None when HERE is not configured or the token could not be minted — the
    caller then serves straight dashed lines (maps simply don't render).
    """
    global _here_bearer_cache
    if not (HERE_ACCESS_KEY_ID and HERE_ACCESS_KEY_SECRET):
        return None
    now = time.monotonic()
    if _here_bearer_cache and _here_bearer_cache[1] - now > 900:
        return _here_bearer_cache[0]
    status, data = get_here_token(
        HERE_ACCESS_KEY_ID, HERE_ACCESS_KEY_SECRET, HERE_TOKEN_ENDPOINT_URL
    )
    if status != 200 or not data.get("access_token"):
        _here_bearer_cache = None
        return None
    ttl = min(int(data.get("expires_in", 86_400)), 86_400)
    _here_bearer_cache = (data["access_token"], now + ttl)
    return _here_bearer_cache[0]


def _crew_initials(name: str) -> str:
    """Initials for one crew name (#196 phase B): first + last token's first
    letter, uppercased ("Niko Raes" → "NR"); one token → its first letter;
    empty → "?". Never blank, so existing renderers stay safe."""
    tokens = (name or "").split()
    if not tokens:
        return "?"
    if len(tokens) == 1:
        return tokens[0][0].upper()
    return (tokens[0][0] + tokens[-1][0]).upper()


def _redact_crew_for_outsider(crew: list, viewer_sub: str | None) -> list:
    """#196 phase B initials rule: on a DISCOVERABLE trip, a viewer with no
    crew role sees every crew member (other than themselves) as initials —
    unless that member opted in (`User.publicName`). Redacted entries keep
    `id`/`role`/`claimed` but lose the trip-relative `note` and `contact`
    (which may carry an email), and gain `initials` + `redactedName: True` so
    the frontend can render an avatar/initials chip and tell it apart."""
    client = get_graph_client()
    ids = [m.get("id") for m in crew if isinstance(m, dict) and m.get("id")]
    profiles = client.get_user_profiles(ids) if client is not None else {}
    out = []
    for member in crew:
        if not isinstance(member, dict):
            out.append(member)
            continue
        if viewer_sub and member.get("id") == viewer_sub:
            out.append(member)  # the viewer's own entry always keeps its name
            continue
        if profiles.get(member.get("id") or "", {}).get("publicName") is True:
            out.append(member)  # opted in — real name, unchanged
            continue
        redacted = dict(member)
        initials = _crew_initials(str(redacted.get("name") or ""))
        redacted["name"] = initials
        redacted["initials"] = initials
        redacted["redactedName"] = True
        redacted.pop("note", None)
        redacted.pop("contact", None)
        out.append(redacted)
    return out


def _viewer_sub(authorization: str | None) -> str | None:
    """Best-effort viewer sub for the initials exemption (#196 phase B).

    Returns the token's own sub, or None for anonymous/invalid tokens (an
    invalid token on a public trip reads as anonymous — same rule as
    ``authorize_trip_path``). Never raises: identity here only decides whose
    crew entry keeps its real name, never access.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    try:
        user = get_current_user(authorization)
    except Exception:
        # Broad on purpose: this read-path identity only decides whose crew
        # entry keeps its real name — a JWKS/network hiccup (not an
        # HTTPException) must degrade to anonymous, never 500 a public page.
        return None
    sub = user.get("sub")
    return sub if isinstance(sub, str) and sub else None


# Crew roles (#196): everyone else — followers included — counts as an
# outsider for field-visibility purposes. A follower reads the trip; they do
# not get the crew's own surfaces (tricount registry, and whatever comes next).
CREW_ROLES = ("viewer", "editor", "owner")
# Dot paths of fields ONLY the crew may see (#196/#197). Registered rather
# than inlined so tests/test_follow_197.py can walk the whole tuple: a
# crew-only field added inline is a leak no test can enumerate, which is why
# the assertion is written against this registry. Add the field HERE.
CREW_ONLY_FIELDS: tuple[tuple[str, ...], ...] = (("practical", "tricount"),)


def _drop_path(data: dict, path: tuple[str, ...]) -> None:
    """Delete a nested key when every step exists (no-op otherwise)."""
    cursor: dict | None = data
    for step in path[:-1]:
        nxt = cursor.get(step)
        cursor = nxt if isinstance(nxt, dict) else None
        if cursor is None:
            return
    cursor.pop(path[-1], None)


def _public_trip(
    trip: Trip,
    my_role: str | None = None,
    viewer_sub: str | None = None,
    redact_crew: bool = True,
) -> dict:
    """Serialize a trip for API responses.

    ``claimToken`` is a SECRET (issue #6) — it is stripped from every trip
    document response, including anonymous/public ones. The join link is only
    obtainable via the owner-only ``/join-link`` endpoint. ``my_role`` (the
    caller's crew role on this trip) is attached for authenticated responses.

    ``practical.tricount`` (#111) is stripped for non-crew readers: the
    registry key in a public trip document would hand anonymous visitors and
    followers the sharing key and, with it, the crew's expense registry in
    the Tricount app. Crew roles (viewer/editor/owner) keep it — the snapshot
    endpoint re-checks the role server-side.

    ``crew`` on a DISCOVERABLE trip (#196 phase B) renders as initials for a
    viewer with no crew role (``my_role`` None) — see
    ``_redact_crew_for_outsider``. A trip that is not ``discoverable`` renders
    exactly as before (public-by-link behaviour unchanged).

    ``redact_crew=False`` switches that rule off for the INVITE and CREW-VIEW
    callers (``by-claim``, ``/api/claims``, ``/api/claims/follow``). The rule
    governs surfaces where an outsider browses a LISTED trip; it does not apply
    to the claim link (its documented trust model is possession of the secret
    invite, and the join page must show the crew so the invitee can pick "This
    is me" — redacting there would silently regress #198's join flow) nor to a
    response rendered to a caller who is crew/follower the moment it returns
    (crew see crew names — pre-#196 behaviour for exactly these three routes).

    Media fields are stored as BARE filenames in the data (trip.json / graph);
    the API canonicalizes them to ``/media/<trip.$dtId>/<file>`` so consumers
    only ever see full URLs, namespaced by the trip's durable id — never the
    repo-folder slug (#47 follow-up).

    Unset optionals are OMITTED rather than sent as ``null`` (#220): an unset
    field costs bytes on every trip document without carrying meaning. On a
    live trip this removes ~25% of the serialized document, almost all of it
    ``Block`` properties that only apply to one of the ten block kinds.
    Consumers must therefore read absent and ``null`` identically; the SPA
    already does (``??`` / ``!= null`` throughout). Empty LISTS and STRINGS
    are still sent (``[]`` / ``""``) — they are deliberate values, and the
    blunt ``exclude_defaults=True`` would also drop ``0`` / ``False``
    (``lat: 0.0``, ``order: 0``), silently corrupting real data.
    """
    data = trip.model_dump(by_alias=True, exclude_none=True)
    # Both link secrets are write-only as far as the API is concerned: they
    # leave only through their dedicated, owner-gated endpoints (join-link
    # #6, follow-link #197).
    data.pop("claimToken", None)
    data.pop("followToken", None)
    # Crew-only fields, from the registry above — a follower/anonymous caller
    # gets the trip without the crew's own surfaces (#196).
    if my_role not in CREW_ROLES:
        for path in CREW_ONLY_FIELDS:
            _drop_path(data, path)
    resolve_media_urls(data, trip.id)
    if my_role:
        data["myRole"] = my_role
    if redact_crew and trip.discoverable and not my_role and isinstance(data.get("crew"), list):
        data["crew"] = _redact_crew_for_outsider(data["crew"], viewer_sub)
    return data


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(user: dict = Depends(get_current_user)) -> dict:
    """Who am I — identity from a validated Auth0 access token.

    `sub` is the RESOLVED actor sub (acl.resolve_actor_sub): for the
    sanctioned agent M2M client with act-as configured, the act-as user (the
    identity writes carry); for any other token, the token's own sub. Profile
    claims (email/name/picture) are only included when the token carries them
    — by default they live in the ID token; the access token always has `sub`.
    """
    return {
        "sub": resolve_actor_sub(user),
        **{
            k: user[k]
            for k in ("email", "name", "picture", "email_verified")
            if k in user
        },
    }


@app.get("/api/trips")
def my_trips(user: dict = Depends(get_current_user)) -> dict:
    """The caller's trips (issue #7 — logged-in landing).

    Requires a valid Auth0 token; returns the trips the RESOLVED actor has a
    crew role on (via ``hasCrew``), with that role. The resolution follows
    acl.resolve_actor_sub: the sanctioned agent M2M client with act-as
    configured lists the act-as user's trips (their real crew edges) — never
    the client's own (empty) listing (#142).
    Registered before the ``{trip_id}`` route so the bare path is never
    captured by it. Summary covers are stored as bare filenames in the graph;
    canonicalize them to ``/media/<trip.$dtId>/<file>`` like full trip
    documents.
    """
    trips = list_trips_for_user(resolve_actor_sub(user))
    for row in trips:
        if isinstance(row, dict) and row.get("dtId"):
            resolve_media_urls(row, row["dtId"])
    return {"trips": trips}


@app.get("/api/showcase")
def showcase(
    response: Response,
    limit: int = Query(default=SHOWCASE_LIMIT_DEFAULT),
) -> dict:
    """Public, discoverable trips for the signed-out landing page (#249).

    Anonymous on purpose, and not a new disclosure: ``/api/trips/{id}`` already
    serves a ``visibility == "public"`` trip to a caller with no token, so
    listing them tells a visitor nothing they could not open one at a time. The
    rule is deliberately narrower than that route — public AND ``discoverable``
    (#196), the owner's listing opt-in — so a public trip that opted out of
    being listed stays off the front door, and a private one never matches.

    Cards, not documents: no crew, no claim/follow token, no ``practical``.
    Cached for 60 s, because the front door is the one surface hit by people who
    will never sign in and a trip published a minute ago appearing a minute
    later is fine.
    """
    response.headers["Cache-Control"] = "public, max-age=60"
    trips = list_showcase_trips(limit)
    for row in trips:
        if row.get("dtId"):
            resolve_media_urls(row, row["dtId"])
    return {"trips": trips}


@app.get("/api/feed")
def get_feed(
    response: Response,
    limit: int = Query(default=FEED_LIMIT_DEFAULT),
    before: str | None = Query(default=None),
    x_act_as_sub: str | None = Header(default=None),
    user: dict = Depends(get_current_user),
) -> dict:
    """The caller's OWN activity feed (issue #199).

    Both streams — the actor's trips and the DISCOVERABLE trips of the people
    they follow — newest write first, capped and cursor-paged. Identity comes
    from ``resolve_request_actor_sub`` like every other read, so a sanctioned
    agent token with act-as sees the acting user's own feed; there is
    deliberately no ``?sub=``, so nobody can ask for a third party's view
    (#195 §6).

    The times are the graph's own ``$metadata.$lastUpdateTime`` and each read is
    cached 60 s, so this is "recent", not "live" — live is #12's job.

    ``no-store``: a feed is per-user and has no business in a proxy cache.
    """
    actor_sub = resolve_request_actor_sub(user, x_act_as_sub)
    if before is not None and not is_iso_timestamp(before):
        raise HTTPException(
            status_code=422, detail="before must be an ISO-8601 timestamp"
        )
    response.headers["Cache-Control"] = "no-store"
    return build_feed(actor_sub, limit=limit, before=before)


@app.post("/api/trips", status_code=201)
def post_trip(
    body: TripCreate,
    x_act_as_sub: str | None = Header(default=None),
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Create an empty trip (issue #9 / M4) — the chat agent spawns it, then
    fills it via the existing write API.

    Identity follows the chat relay (``acl.resolve_request_actor_sub``): the
    end user's own token (mode 1) or the sanctioned agent M2M token + a
    request-scoped act-as sub (mode 2). A bare M2M token is rejected — the
    trip is created FOR the resolved actor, who becomes ``owner``. Returns
    the public-trip shape so the SPA can navigate straight to ``/t/<id>``.
    """
    actor_sub = resolve_request_actor_sub(session.user, x_act_as_sub)
    # The token claims may carry email/name when userinfo is unavailable —
    # userinfo (fresher) wins over claims.
    profile = {
        **{k: session.user[k] for k in ("email", "name") if session.user.get(k)},
        **(session.profile or {}),
    }
    trip = _write(
        write_svc.create_trip,
        actor_sub=actor_sub,
        token_sub=session.user.get("sub", ""),
        profile=profile,
        payload=body,
    )
    return _public_trip(trip, my_role="owner")


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
    # The invite itself is not a listed surface: the token-holder is meant to
    # see the crew (that is how they pick their row), so no initials rule here.
    return _public_trip(trip, redact_crew=False)


class ClaimRequest(BaseModel):
    claimToken: str
    personId: str


class FollowRequest(BaseModel):
    """POST /api/claims/follow body — the join link (#65) or the follow link (#197).

    Exactly one credential: ``claimToken`` (join link, claim-capable) or
    ``followToken`` (follow link, read+follow only). The two are never
    interchangeable, so the caller must state which link it holds — a follow
    link submitted as a claim token is just an unknown invite.
    """

    claimToken: str | None = None
    followToken: str | None = None


@app.post("/api/claims")
def create_claim(
    body: ClaimRequest,
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Claim a crew identity on a trip (issue #6).

    Requires a valid Auth0 token AND the trip's claim token. The claim token
    is what makes this an *invite*: the read link alone can never grant an
    identity. Only a real end-user token may claim — an M2M client token
    (which has no user sub) is refused (acl.require_user_token).
    """
    require_user_token(session.user)
    try:
        trip = claim_identity(
            body.claimToken,
            body.personId,
            session.user["sub"],
            session.profile,
        )
    except ClaimError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    # The caller is crew (claim) / follower (follow) the moment this returns,
    # so the response is the crew view — not an outsider's listing.
    return _public_trip(trip, redact_crew=False)


@app.post("/api/claims/follow")
def follow_claim(
    body: FollowRequest,
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Follow a trip via its claimToken (#65).

    Non-crew followers get a `hasCrew` edge with `role=follower`.
    Private trips require the invite; public trips can be followed
    optionally (read already works anonymously). Idempotent if already
    on the crew — returns the trip without error. Like claiming, this
    provisions a graph identity, so only a real end-user token may follow
    (acl.require_user_token).
    """
    require_user_token(session.user)
    if body.followToken is not None:
        if body.claimToken is not None:
            raise HTTPException(
                status_code=400,
                detail="Provide exactly one of claimToken (join link) or followToken (follow link)",
            )
        token_holder = ("follow", body.followToken)
    elif body.claimToken is not None:
        token_holder = ("claim", body.claimToken)
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide exactly one of claimToken (join link) or followToken (follow link)",
        )
    try:
        if token_holder[0] == "follow":
            trip = follow_via_follow_token(token_holder[1], session.user["sub"], session.profile)
        else:
            trip = follow_via_claim(token_holder[1], session.user["sub"], session.profile)
    except ClaimError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    # The caller is crew (claim) / follower (follow) the moment this returns,
    # so the response is the crew view — not an outsider's listing.
    return _public_trip(trip, redact_crew=False)


@app.post("/api/me/ensure")
def ensure_my_twin(
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Ensure the caller's User twin exists (issue #196).

    An account can exist WITHOUT having claimed a crew identity — a logged-in
    user gets their twin (and is therefore reachable at a profile) on first
    call. Idempotent: calling twice provisions nothing new.

    This PROVISIONS graph identity, so it follows the claim/follow rule
    (``acl.require_user_token``): only a real end-user token may provision —
    an M2M client token is refused (403), and act-as is never used to
    provision a twin on someone else's behalf. When the token carries no
    usable email, nothing is created and the response reports
    ``ensured: false`` (the SPA keeps working); a graph failure, by contrast,
    is a 503 — never disguised as a missing email.
    """
    require_user_token(session.user)
    actor_sub = session.user["sub"]
    # The token claims may carry email/name when userinfo is unavailable —
    # userinfo (fresher) wins over claims (mirrors post_trip).
    profile = {
        **{k: session.user[k] for k in ("email", "name") if session.user.get(k)},
        **(session.profile or {}),
    }
    client = get_graph_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Graph not configured")
    email = (profile.get("email") or "").strip()
    name = (profile.get("name") or "").strip() or (email.split("@")[0] if email else "")
    if not email:
        return {
            "sub": actor_sub,
            "ensured": False,
            "name": name,
            "email": email,
            "reason": "no verified email — sign in with an identity that carries one",
        }
    if not client.create_user_twin(actor_sub, profile):
        # A graph failure is NOT the no-email case above — never disguise one
        # as the other: the SPA treats "ensured: false" as "carry on".
        raise HTTPException(status_code=503, detail="Could not create your user identity")
    return {"sub": actor_sub, "ensured": True, "name": name, "email": email}


@app.post("/api/users/{sub}/follow")
def follow_user(
    sub: str,
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Follow a person (issue #196): one-directional, no approval.

    The actor is the token's OWN sub (never the path/body). This WRITES a
    graph edge, so it follows the claim/follow rule
    (``acl.require_user_token``): an M2M client token is refused (403) and
    act-as is never used to follow on someone else's behalf. Following grants
    NO trip access — visibility still gates every trip read. 400 on
    self-follow, 404 when the target twin does not exist, 200 (idempotent
    no-op) when already following.
    """
    require_user_token(session.user)
    actor_sub = session.user["sub"]
    if actor_sub == sub:
        raise HTTPException(status_code=400, detail="You cannot follow yourself")
    client = get_graph_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Graph not configured")
    if not client.user_twin_exists(sub):
        raise HTTPException(status_code=404, detail="Unknown user")
    if not client.follow_user(actor_sub, sub):
        raise HTTPException(status_code=503, detail="Could not follow user")
    return {"sub": sub, "following": True}


@app.delete("/api/users/{sub}/follow")
def unfollow_user(
    sub: str,
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Unfollow a person (issue #196). Idempotent: unfollowing someone not
    followed is a 200 no-op. The actor is the token's OWN sub; like follow,
    an M2M client token is refused (403)."""
    require_user_token(session.user)
    actor_sub = session.user["sub"]
    if actor_sub == sub:
        raise HTTPException(status_code=400, detail="You cannot follow yourself")
    client = get_graph_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Graph not configured")
    if not client.user_twin_exists(sub):
        raise HTTPException(status_code=404, detail="Unknown user")
    if not client.unfollow_user(actor_sub, sub):
        raise HTTPException(status_code=503, detail="Could not unfollow user")
    return {"sub": sub, "following": False}


class MeUpdate(BaseModel):
    """Self-service profile edit (issue #196 phase B) — exactly one knob.

    Strict: any field besides ``publicName`` is a 422, so this can never grow
    into a general twin editor by accident.
    """

    model_config = {"extra": "forbid"}

    publicName: bool


@app.put("/api/me")
def update_me(
    body: MeUpdate,
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Flip the caller's own ``User.publicName`` opt-in (issue #196).

    Self-service: writes the caller's OWN twin only (404 when it does not
    exist — the client calls ``ensure`` first). Like ``ensure``/claims/follow
    this provisions graph identity, so it is user-token-only
    (``acl.require_user_token``): an M2M token is refused 403. Returns the
    ``ensure`` shape plus the new ``publicName`` value. A graph write failure
    is 503 (``GraphWriteError``): a missing twin stays the only 404, because
    "call ``ensure`` first" is only the right advice when it is really gone.
    """
    require_user_token(session.user)
    actor_sub = session.user["sub"]
    client = get_graph_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Graph not configured")
    try:
        updated = client.set_user_public_name(actor_sub, body.publicName)
    except GraphWriteError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="No user identity — call /api/me/ensure first")
    name = (updated.get("displayName") or updated.get("name") or "").strip()
    email = (updated.get("email") or "").strip()
    return {
        "sub": actor_sub,
        "ensured": True,
        "name": name,
        "email": email,
        "publicName": bool(updated.get("publicName", False)),
    }


@app.delete("/api/me")
def delete_me(
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Erase the caller's account (issue #196 phase C, GDPR art. 17).

    IRREVERSIBLE. Reverts every crew entry to an unclaimed placeholder
    (same trip-relative name, role and note — the trip renders identically
    for everyone else), removes ``follows`` edges in both directions, and
    deletes the ``User`` twin last. Refused with 409 while the caller still
    owns a trip (the response names the blocking trips — delete or hand them
    over first; shared trips are never silently destroyed). A second call
    finds no twin and answers 404.

    Like every self-mutating identity route this is user-token-only
    (``acl.require_user_token``): an M2M token is refused 403.
    """
    require_user_token(session.user)
    try:
        summary = erase_account(session.user["sub"])
    except ErasureError as exc:
        if exc.status == 409 and exc.extra:
            raise HTTPException(
                status_code=exc.status,
                detail={"message": exc.detail, **exc.extra},
            ) from exc
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return {"deleted": summary}


@app.get("/api/me/export")
def export_me(
    session: AuthSession = Depends(get_current_session),
) -> Response:
    """Export the caller's own data (issue #196 phase C, GDPR art. 20).

    One complete JSON document, always: twin props, full documents of owned
    trips (the same shape ``GET /api/trips/{id}`` returns), the caller's crew
    rows on other trips, and the social graph (peers' public-ish fields only
    — never another user's email or trip-relative note). No query knobs.
    Served as a file download (``Content-Disposition: attachment``).

    User-token-only (``acl.require_user_token``): an M2M token is refused
    403. 404 when the caller has no twin (call ``ensure`` first).
    """
    require_user_token(session.user)
    try:
        doc = export_account(session.user["sub"])
    except ErasureError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    owned = [_public_trip(trip, my_role="owner") for trip in doc["ownedTrips"]]
    body = {**doc, "ownedTrips": owned}
    return JSONResponse(
        body,
        headers={"Content-Disposition": 'attachment; filename="kiseki-export.json"'},
    )


def _profile_trips(client, target_sub: str, viewer_sub: str) -> list[dict]:
    """Trip summaries for a profile (issue #196 phase B trip-list rule).

    A trip is listed when EITHER it is ``discoverable`` OR the viewer already
    has a role on it (crew/follower/editor/owner) — a private trip the viewer
    was invited to still shows for them. Nothing else is ever listed: a
    `private` trip the viewer is not on is absent, and a `public`
    (non-discoverable) trip is listed nowhere — `public` keeps its exact
    meaning (readable by whoever holds the id link).

    Two round-trips total (the target's trips + the viewer's trips for the
    role map), however many trips either side has. Summary shape reuses the
    ``_Q_TRIPS_FOR_USER`` fields plus ``discoverable`` and the viewer's own
    ``myRole`` (absent when they have none).
    """
    viewer_roles = {
        s.get("dtId"): s.get("role") for s in client.list_trips_for_user(viewer_sub)
    }
    out = []
    for s in client.list_trips_for_user(target_sub):
        dtid = s.get("dtId")
        discoverable = bool(s.get("discoverable", False))
        my_role = viewer_roles.get(dtid)
        if not (discoverable or my_role):
            continue
        row = {
            key: s.get(key)
            for key in ("dtId", "title", "subtitle", "stage", "startDate",
                        "endDate", "cover", "visibility")
        }
        resolve_media_urls(row, dtid)
        row["discoverable"] = discoverable
        if my_role:
            row["myRole"] = my_role
        out.append(row)
    return out


def _profile_people(client, subs: list[str], viewer_sub: str, cap: int = 200) -> list[dict]:
    """Drill-in people entries (followers/following): ``sub`` + ``name`` (+
    ``avatar`` when the twin carries one, ``isSelf`` only for the viewer).

    The name resolves from the twin's ``displayName`` (falling back to
    ``name``); dangling ids (edge without a twin) are skipped, never
    fabricated.
    """
    profiles = client.get_user_profiles(subs[:cap])
    out = []
    for sid in subs[:cap]:
        node = profiles.get(sid)
        if node is None:
            continue
        entry: dict = {
            "sub": sid,
            "name": node.get("displayName") or node.get("name") or "",
        }
        avatar = node.get("avatar") or node.get("picture")
        if isinstance(avatar, str) and avatar:
            entry["avatar"] = avatar
        if sid == viewer_sub:
            entry["isSelf"] = True
        out.append(entry)
    return out


@app.get("/api/users/{sub}")
def get_user_profile(sub: str, user: dict = Depends(get_current_user)) -> dict:
    """The profile document (issue #196 phase B).

    Public-ish read: any valid token works, for any user. 404 when that `sub`
    has no `User` twin. `email` and `publicName` are self-only (omitted for
    everyone else — no key at all); `avatar` rides along only when the twin
    carries one. `trips` follows the discoverable-only list rule
    (``_profile_trips``); counts come from the single-hop follow queries
    (``followers_of`` / ``following_of``) — no per-follower node walk.
    """
    viewer_sub = user["sub"]
    client = get_graph_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Graph not configured")
    node = client.get_user_profile(sub)
    if node is None:
        raise HTTPException(status_code=404, detail="Unknown user")
    is_self = viewer_sub == sub
    followers = client.followers_of(sub)
    following = client.following_of(sub)
    trips = _profile_trips(client, sub, viewer_sub)
    body: dict = {
        "sub": sub,
        "name": node.get("displayName") or node.get("name") or "",
    }
    avatar = node.get("avatar") or node.get("picture")
    if isinstance(avatar, str) and avatar:
        body["avatar"] = avatar
    if is_self:
        email = node.get("email")
        if isinstance(email, str) and email:
            body["email"] = email
        body["publicName"] = bool(node.get("publicName", False))
    body["counts"] = {
        "followers": len(followers),
        "following": len(following),
        "trips": len(trips),
    }
    body["viewer"] = {"isSelf": is_self, "following": viewer_sub in followers}
    body["trips"] = trips
    return body


@app.get("/api/users/{sub}/followers")
def list_user_followers(sub: str, user: dict = Depends(get_current_user)) -> dict:
    """Who follows this person (issue #196 phase B). Public-ish read, same
    404 as the profile when the target has no twin. Capped at 200 entries;
    ``count`` is the TRUE total (the id list arrives whole from one scoped
    query — resolving names is what caps, not counting). No email, ever."""
    client = get_graph_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Graph not configured")
    if client.get_user_profile(sub) is None:
        raise HTTPException(status_code=404, detail="Unknown user")
    ids = client.followers_of(sub)
    return {"count": len(ids), "people": _profile_people(client, ids, user["sub"])}


@app.get("/api/users/{sub}/following")
def list_user_following(sub: str, user: dict = Depends(get_current_user)) -> dict:
    """Who this person follows (issue #196 phase B). Same contract as the
    followers drill-in: 200-entry cap, true-total ``count``, no email."""
    client = get_graph_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Graph not configured")
    if client.get_user_profile(sub) is None:
        raise HTTPException(status_code=404, detail="Unknown user")
    ids = client.following_of(sub)
    return {"count": len(ids), "people": _profile_people(client, ids, user["sub"])}


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


@app.get("/api/trips/{trip_id}/follow-link")
def trip_follow_link(
    trip_id: str,
    _: None = Depends(require_trip_role("owner")),
) -> dict:
    """Owner-only: the trip's FOLLOW link (#197).

    A SECOND link, separately revocable: whoever holds it can read the trip
    and follow it, and can never claim a crew identity. Like the claim token
    the secret never appears in a trip document — this endpoint and its POST
    sibling are the only ways it leaves the API.
    """
    trip = get_trip_by_id_store(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    if not trip.followToken:
        raise HTTPException(status_code=404, detail="No follow link for this trip")
    return {"followUrl": f"/join/{trip.followToken}", "linkKind": "follow"}


@app.post("/api/trips/{trip_id}/follow-link", status_code=201)
def create_trip_follow_link(
    trip_id: str,
    actor: dict = Depends(require_trip_role("owner")),
) -> dict:
    """Owner-only: mint or rotate the follow link (#197).

    Minting twice ROTATES: the lookup cache is retired by token value, so the
    previous follow link stops resolving immediately — a leaked follow link
    can be killed without touching the crew invite (and vice versa).
    """
    token = write_svc.mint_follow_link(trip_id.lower(), actor)
    return {"followUrl": f"/join/{token}", "linkKind": "follow"}


@app.delete("/api/trips/{trip_id}/join-link", status_code=204)
def delete_trip_join_link(
    trip_id: str,
    actor: dict = Depends(require_trip_role("owner")),
) -> Response:
    """Owner-only: disable the crew invite (#197) — clears the claim token.

    Kills claiming (and following) through the join link. Existing crew keep
    their roles, followers keep following, and the follow link keeps working.
    """
    _write(write_svc.revoke_claim_invite, trip_dtid=trip_id.lower(), actor=actor)
    return Response(status_code=204)


@app.post("/api/trips/{trip_id}/follow")
def follow_public_trip_route(
    trip_id: str,
    session: AuthSession = Depends(get_current_session),
) -> dict:
    """Follow a PUBLIC trip with no invite at all (#197).

    ``visibility: public`` is the invitation on this path; a private trip
    answers 403 ("can only be followed with an invite link") instead of
    silently granting or silently ignoring. Idempotent, and it provisions a
    graph identity (role=follower), so an M2M token without a user sub is
    refused (acl.require_user_token).
    """
    require_user_token(session.user)
    trip = get_trip_by_id_store(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    try:
        followed = follow_trip_by_id(trip.id, session.user["sub"], session.profile)
    except ClaimError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    # The caller is a follower the moment this returns: the crew-only fields
    # stay out, but they do see the trip (not an outsider's teaser).
    return _public_trip(followed, my_role="follower")


@app.get("/api/trips/by-follow/{follow_token}")
def trip_by_follow(follow_token: str) -> dict:
    """Follow-link read (#197): the trip behind a follow token.

    Same trust model as the claim link (possession of the secret) but the
    link is read+follow only. Crew names are redacted (the holder is not
    crew) and ``linkKind: follow`` tells the SPA never to offer "This is me"
    here — the credential it holds cannot claim anything.
    """
    trip = trip_by_follow_token(follow_token)
    if trip is None:
        raise HTTPException(status_code=404, detail="Unknown follow link")
    data = _public_trip(trip, redact_crew=True)
    data["linkKind"] = "follow"
    return data


@app.get("/api/trips/{trip_id}")
def get_trip(
    trip_id: str,
    my_role: str | None = Depends(authorize_trip_path),
    authorization: str | None = Header(default=None),
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
    return _public_trip(trip, my_role=my_role, viewer_sub=_viewer_sub(authorization))


# ------------------------------------------------------------------ write path (#46)
# Role-gated content writes to the graph (the ONLY store). ``require_trip_role``
# gates the route AND returns the validated actor {sub, role}: sub is forwarded
# as x-user-id so edits are attributable ($lastUpdatedBy), role drives the
# owner-only checks (visibility, stage backward/archive, crew roles). Every
# handler returns the canonical trip document so clients converge in one round
# trip. ``claimToken`` is not accepted by any payload model and never returned.

def _write(fn, **kwargs):
    """Run a write-service call, mapping WriteError to HTTP.

    TriCountError is mapped too: the tricount connect path (#111) validates
    the registry key inside the write service, and a bad key must surface as
    its HTTP status (404/502/503), never a 500.
    ``GraphNotFound`` is mapped to 404 as well: a bundle whose Trip twin is
    gone means the trip vanished mid-call (issue #171) — e.g. ``toggle_todo``
    rebuilds the document before the twin guard runs — and must never
    surface as a 500."""
    try:
        return fn(**kwargs)
    except (WriteError, TriCountError) as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    except GraphNotFound as exc:
        raise HTTPException(status_code=404, detail="Trip not found") from exc


@app.put("/api/trips/{trip_id}")
def put_trip(
    trip_id: str,
    body: TripPatch,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.update_trip, trip_dtid=trip_id.lower(), actor=actor, patch=body)
    return _public_trip(trip, my_role=actor["role"])


@app.delete("/api/trips/{trip_id}", status_code=204)
def delete_trip_route(
    trip_id: str,
    actor: dict = Depends(require_trip_owner),
) -> Response:
    """Delete a trip and everything scoped to it (issue #163) — owner-only.

    The terminal affordance for a botched half-create: the trip twin, its
    days/sections/blocks/features and its crew edges all go (edges-first —
    the graph does not cascade deletes), claimed User twins survive as global
    identities. Answers 204 with no body — there is no trip document left to
    return; a second delete is a 404 (the ACL gate checks existence first),
    which is the caller's cleanup-loop termination condition.
    """
    _write(write_svc.delete_trip, trip_dtid=trip_id.lower(), actor=actor)
    return Response(status_code=204)


@app.put("/api/trips/{trip_id}/practical")
def put_practical(
    trip_id: str,
    body: PracticalPut,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.put_practical, trip_dtid=trip_id.lower(), actor=actor, body=body)
    return _public_trip(trip, my_role=actor["role"])


@app.post("/api/trips/{trip_id}/practical/todos")
def add_todo(
    trip_id: str,
    body: TodoAdd,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.add_todo, trip_dtid=trip_id.lower(), actor=actor, body=body)
    return _public_trip(trip, my_role=actor["role"])


@app.post("/api/trips/{trip_id}/practical/todos/{index}/toggle")
def toggle_todo(
    trip_id: str,
    index: int,
    body: TodoToggle,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.toggle_todo, trip_dtid=trip_id.lower(), actor=actor,
                  index=index, body=body)
    return _public_trip(trip, my_role=actor["role"])


# ------------------------------------------------------------------ tricount (#111)
# CREW-only expense integration: read requires viewer+ (crew = viewer/editor/
# owner; followers are non-crew by design #65 and never see the money picture).
# Connect/disconnect are owner-only (same gate as visibility and crew roles).
# The graph never stores a snapshot — reads fetch live with a short in-process TTL.

@app.get("/api/trips/{trip_id}/practical/tricount")
def get_tricount_snapshot(
    trip_id: str,
    refresh: bool = Query(default=False, description="Bypass the snapshot cache"),
    actor: dict = Depends(require_trip_role("viewer")),
) -> dict:
    trip = get_trip_by_id_store(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    if trip.practical.tricount is None:
        raise HTTPException(status_code=404, detail="This trip has no Tricount connection")
    try:
        snapshot = fetch_snapshot(trip.practical.tricount.registryKey, refresh=refresh)
    except TriCountError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return snapshot.model_dump()


@app.post("/api/trips/{trip_id}/practical/tricount/connect")
def connect_tricount(
    trip_id: str,
    body: TricountConnect,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.connect_tricount, trip_dtid=trip_id.lower(), actor=actor, body=body)
    return _public_trip(trip, my_role=actor["role"])


@app.delete("/api/trips/{trip_id}/practical/tricount")
def disconnect_tricount(
    trip_id: str,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.disconnect_tricount, trip_dtid=trip_id.lower(), actor=actor)
    return _public_trip(trip, my_role=actor["role"])


@app.post("/api/trips/{trip_id}/days", status_code=201)
def post_day(
    trip_id: str,
    body: DayCreate,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Insert a new day at ``index`` (default = append). The trip's hasDay
    edges are re-indexed around the insert and every section range that spans
    or sits after the insertion index shifts +1, so the same days stay covered
    and the new day joins the chapter it lands in."""
    trip = _write(write_svc.create_day, trip_dtid=trip_id.lower(), actor=actor, payload=body)
    return _public_trip(trip, my_role=actor["role"])


@app.put("/api/trips/{trip_id}/days/{day_id}")
def put_day(
    trip_id: str,
    day_id: str,
    body: DayPatch,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.update_day, trip_dtid=trip_id.lower(), actor=actor,
                  day_id=day_id.lower(), patch=body)
    return _public_trip(trip, my_role=actor["role"])


@app.delete("/api/trips/{trip_id}/days/{day_id}")
def delete_day(
    trip_id: str,
    day_id: str,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Remove a day (the complement of POST /days). The day's blocks go with
    it, the trip's hasDay edges re-index around the gap and every section
    range that spans or sits after the removed index shrinks/shifts, so the
    tiling invariant — every remaining day under exactly one section —
    survives the delete. The last remaining day cannot be deleted."""
    trip = _write(write_svc.delete_day, trip_dtid=trip_id.lower(), actor=actor,
                  day_id=day_id.lower())
    return _public_trip(trip, my_role=actor["role"])


@app.put("/api/trips/{trip_id}/sections/{section_id}")
def put_section(
    trip_id: str,
    section_id: str,
    body: SectionPatch,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.update_section, trip_dtid=trip_id.lower(), actor=actor,
                  section_id=section_id.lower(), patch=body)
    return _public_trip(trip, my_role=actor["role"])


@app.post("/api/trips/{trip_id}/sections", status_code=201)
def post_section(
    trip_id: str,
    body: SectionCreate,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Create a new section chapter (issue #89) — title + optional days range +
    locationRefs. Days must stay in trip bounds and must not overlap another
    section; locationRefs must be registry locations."""
    trip = _write(write_svc.create_section, trip_dtid=trip_id.lower(), actor=actor, payload=body)
    return _public_trip(trip, my_role=actor["role"])


@app.post("/api/trips/{trip_id}/blocks", status_code=201)
def post_block(
    trip_id: str,
    body: BlockCreate,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.create_block, trip_dtid=trip_id.lower(), actor=actor, payload=body)
    return _public_trip(trip, my_role=actor["role"])


@app.put("/api/trips/{trip_id}/blocks/{block_id}")
def put_block(
    trip_id: str,
    block_id: str,
    body: BlockFields,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.update_block, trip_dtid=trip_id.lower(), actor=actor,
                  block_id=block_id.lower(), payload=body)
    return _public_trip(trip, my_role=actor["role"])


@app.delete("/api/trips/{trip_id}/blocks/{block_id}")
def delete_block(
    trip_id: str,
    block_id: str,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.delete_block, trip_dtid=trip_id.lower(), actor=actor,
                  block_id=block_id.lower())
    return _public_trip(trip, my_role=actor["role"])


@app.post("/api/trips/{trip_id}/blocks/{block_id}/move")
def move_block(
    trip_id: str,
    block_id: str,
    body: BlockMove,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.move_block, trip_dtid=trip_id.lower(), actor=actor,
                  block_id=block_id.lower(), payload=body)
    return _public_trip(trip, my_role=actor["role"])


@app.put("/api/trips/{trip_id}/containers/{container_id}/block-order")
def put_block_order(
    trip_id: str,
    container_id: str,
    body: BlockOrder,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.order_container_blocks, trip_dtid=trip_id.lower(), actor=actor,
                  container_id=container_id.lower(), body=body)
    return _public_trip(trip, my_role=actor["role"])


@app.patch("/api/trips/{trip_id}/crew/{person_id}")
def patch_crew(
    trip_id: str,
    person_id: str,
    body: CrewPatch,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.patch_crew, trip_dtid=trip_id.lower(), actor=actor,
                  person_id=person_id.lower(), patch=body)
    return _public_trip(trip, my_role=actor["role"])


@app.post("/api/trips/{trip_id}/crew", status_code=201)
def post_crew(
    trip_id: str,
    body: CrewAdd,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Add a crew member (editor+).

    Two modes, both in ``CrewAdd``: a placeholder Person they claim later via
    the invite (default), or an account that already exists on Kiseki — pass
    its ``sub`` to attach the crew entry to that account directly (#198
    follow-up: "add someone I follow" — no fake person, no join link). The
    account path grants access the moment it lands, so it is OWNER-only and
    only accepts an account the caller already follows (both enforced in the
    write service, 403).
    """
    trip = _write(write_svc.add_crew, trip_dtid=trip_id.lower(), actor=actor, body=body)
    return _public_trip(trip, my_role=actor["role"])


@app.delete("/api/trips/{trip_id}/crew/{person_id}")
def delete_crew(
    trip_id: str,
    person_id: str,
    actor: dict = Depends(require_trip_role("owner")),
) -> dict:
    trip = _write(write_svc.remove_crew, trip_dtid=trip_id.lower(), actor=actor,
                  person_id=person_id.lower())
    return _public_trip(trip, my_role=actor["role"])


@app.put("/api/trips/{trip_id}/locations")
def put_locations(
    trip_id: str,
    body: LocationsPut,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    trip = _write(write_svc.put_locations, trip_dtid=trip_id.lower(), actor=actor, body=body)
    return _public_trip(trip, my_role=actor["role"])


@app.patch("/api/trips/{trip_id}/locations")
def patch_locations(
    trip_id: str,
    body: LocationsPatch,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Incremental location edits — named upserts only (never a replace).

    Each entry matches by ``id`` when supplied, otherwise by ``name``; only
    the supplied fields are patched and unmentioned locations are untouched,
    so a partial payload can never delete a location the way PUT does. New
    names are appended to the registry in payload order. Duplicate names in
    the payload are a 409; an unknown ``id`` is a 404.
    """
    trip = _write(write_svc.patch_locations, trip_dtid=trip_id.lower(), actor=actor, body=body)
    return _public_trip(trip, my_role=actor["role"])


@app.put("/api/trips/{trip_id}/features")
def put_features(
    trip_id: str,
    body: FeaturesPut,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Full-array replace of the trip's editorial overview cards (issue #178).

    Diff by title: kept features are patched, gone ones deleted, new ones
    created; card order = list position (hasFeature edge index). Duplicated
    titles are a 422. Mirrors PUT /locations.
    """
    trip = _write(write_svc.put_features, trip_dtid=trip_id.lower(), actor=actor, body=body)
    return _public_trip(trip, my_role=actor["role"])


@app.patch("/api/trips/{trip_id}/features")
def patch_features(
    trip_id: str,
    body: FeaturesPatch,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Incremental feature edits — upserts by `id` else `title` (issue #178).

    Only the supplied fields are patched and unmentioned features are
    untouched, so a partial payload can never delete a card the way PUT does.
    New titles are appended to the card order. Duplicate titles (or ids) in
    the payload are a 409; an unknown `id` is a 404.
    """
    trip = _write(write_svc.patch_features, trip_dtid=trip_id.lower(), actor=actor, body=body)
    return _public_trip(trip, my_role=actor["role"])


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
# needs a provider (HERE Routing v8, #15), served server-side so the HERE token
# never leaves the backend. Static Maps proxy is GONE (#37): the booklet
# renders the SAME MapLibre map live via Playwright (Chromium + SwiftShader),
# so screen and paper share basemap / marker numbering / route colours. #27
# removed the
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
    """Gone (#27) — the routing token is server-side only now.

    Kept as an explicit 404 rather than deleted: without it the SPA catch-all
    would answer this path with a 200 and the index shell, which reads like the
    endpoint still exists.
    """
    raise HTTPException(status_code=404, detail="Removed — the Maps key is server-side only")


@app.get("/api/maps/static/{rest:path}", include_in_schema=False)
def maps_static_gone(rest: str) -> Response:
    """Gone (#37) — the static Maps proxy was replaced by live MapLibre renders.

    Kept as an explicit 404 (mirroring ``/api/maps/key`` above) so the SPA
    catch-all never answers the path with a 200 + the index shell, which reads
    like the deleted endpoint is still here. The path param exists only so
    ``/api/maps/static/anything`` matches this route before the SPA catch-all.
    """
    raise HTTPException(status_code=404, detail="Removed — the static Maps proxy is gone")


@app.get("/api/maps/route/{trip_id}")
def maps_route(
    request: Request,
    trip_id: str,
    places: str = Query(..., description="comma-separated place names"),
    modes: str = Query("", description="comma-separated transport mode per leg (drive/train/flight/ferry)"),
    loop: int = Query(0, description="1 = close the loop back to the start"),
) -> dict:
    """Real driving route as GeoJSON — what the MapLibre map draws (#18).

    One leg per consecutive pair (the loop closes back to the start), exactly
    the shape the frontend expects. `duration` is the HERE live (time-aware)
    value behind the drive-time chip; a leg with no road
    route comes back `road: false` with a straight line for the client to dash.

    `modes` (optional, parallel to `places`) names the declared transport per
    leg — a `flight`/`ferry` leg skips the HERE query entirely and returns
    straight `road: false` geometry, so an SCL→CUZ flight never renders as a
    drive down the Pan-American Highway. Modes shorter than the resolved
    place list simply don't cover the tail legs.
    """
    _rate_limit(request, "route", 60)
    trip = _trip_for_map(trip_id)
    token = here_bearer_token()
    if not token:
        raise HTTPException(status_code=404, detail="Maps not configured")
    mode_list = [m.strip() for m in modes.split(",") if m.strip()] if modes else []
    resolved = resolve_places(trip, [p for p in places.split(",") if p.strip()])
    if len(resolved) < 2:
        raise HTTPException(status_code=404, detail="Need at least two resolvable places")
    cache_key = (trip.id, tuple(resolved), bool(loop), tuple(mode_list))
    hit = _route_cache.get(cache_key)
    now = time.monotonic()
    if hit and hit[0] > now:
        return {"legs": hit[1]}
    legs = route_legs(resolved, token, loop=bool(loop), modes=mode_list)
    if len(_route_cache) > 512:
        _route_cache.clear()
    # Short TTL: the geometry is stable but `duration` is live traffic, and a
    # chip labelled "live" should not be quarter-hour-old.
    _route_cache[cache_key] = (now + _ROUTE_TTL, legs)
    return {"legs": legs}


# Live drive time for drive cards (card polish): HERE-backed, key server-side.
# The browser never sees the HERE key — it passes a lat/lng pair (the
# frontend already holds registry coordinates) and gets back formatted
# summary text in the same strings the map legs serve. Short-TTL cache;
# any HERE error/timeout answers {"available": false} (HTTP 200) so the
# card silently keeps its static values.
_directions_cache: dict[tuple[float, float, float, float], tuple[float, dict]] = {}
_DIRECTIONS_TTL = 600.0


@app.get("/api/maps/directions")
def maps_directions(
    request: Request,
    from_lat: float = Query(..., ge=-90.0, le=90.0, alias="fromLat"),
    from_lng: float = Query(..., ge=-180.0, le=180.0, alias="fromLng"),
    to_lat: float = Query(..., ge=-90.0, le=90.0, alias="toLat"),
    to_lng: float = Query(..., ge=-180.0, le=180.0, alias="toLng"),
) -> dict:
    """Live drive time + distance between two coordinates (#live-drive-time).

    Thin wrapper over one HERE Routing v8 leg (``route_leg_v8``) — same
    bearer-token plumbing and same duration/distance strings as
    ``/api/maps/route``. Trip-agnostic on purpose: the caller already
    resolved its places to coordinates, so no trip lookup is needed.
    """
    _rate_limit(request, "directions", 60)
    key = (round(from_lat, 5), round(from_lng, 5), round(to_lat, 5), round(to_lng, 5))
    now = time.monotonic()
    hit = _directions_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    token = here_bearer_token()
    if token:
        try:
            leg = route_leg_v8(("from", from_lat, from_lng), ("to", to_lat, to_lng), token, timeout=5)
        except Exception:
            leg = None
        if leg and (leg.get("duration") or leg.get("distance")):
            body: dict = {"available": True}
            if leg.get("duration"):
                body["durationText"] = leg["duration"]
            if leg.get("distance"):
                body["distanceText"] = leg["distance"]
            if len(_directions_cache) > 512:
                _directions_cache.clear()
            _directions_cache[key] = (now + _DIRECTIONS_TTL, body)
            return body
    return {"available": False}


# Live place overlay (rating / review snippets / photos, issue #95) —
# Google Places API (New) behind server-side proxies, same trust pattern as
# the HERE routes above: the key never leaves the backend, results are
# short-TTL display caches (never persisted — #15/#95 storage rule), and any
# Google failure answers {"available": false} (HTTP 200) so cards render
# nothing instead of breaking. place_details() enforces the field mask and
# prunes review/photo payloads to the attribution-carrying shape the UI
# renders.
@app.get("/api/places/details/{place_id}")
def places_details_endpoint(request: Request, place_id: str) -> dict:
    _rate_limit(request, "places-details", 60)
    # place_details() returns None when the key is absent or Google fails —
    # both are the same quiet {"available": false} to the caller.
    details = place_details(place_id)
    return details if details else {"available": False}


@app.get("/api/places/search")
def places_search_endpoint(
    request: Request,
    q: str = Query(..., min_length=2),
    lat: float | None = Query(None, ge=-90, le=90),
    lng: float | None = Query(None, ge=-180, le=180),
    radius: int | None = Query(None, ge=1000, le=500_000, description="metres"),
) -> dict:
    """Resolve a venue NAME to its ``place_id`` + exact coordinates (#187).

    The content agent's resolution step: it knows the venue ("Shinjuku Gyoen",
    "Hotel Gracery Shinjuku") and needs the durable key + real coordinates,
    instead of anchoring an activity to the city and shipping a generic
    ``maps/search?api=1&query=Tokyo`` link.

    ``lat``/``lng``/``radius`` bias the ranking toward a point the caller trusts
    (normally the trip's other locations). Place names repeat across countries —
    "Hotel Presidente" is a Madrid hotel and a San José hotel — so without a bias
    a trip can acquire a venue on the wrong continent with nothing in the
    response to show it (#255). The bias is a Google ranking hint, not a filter.
    Both coordinates are required for it to apply; either one alone is ignored.

    Same contract as the sibling proxies: the Google key stays server-side, a
    short-TTL in-process cache absorbs repeat lookups, and an unconfigured key /
    Google failure / no match all answer ``{"available": false}`` with HTTP 200
    so a caller can treat every miss the same way. Nothing Google-derived is
    persisted here — the documented storable field is ``placeId`` (#15/#95).
    """
    _rate_limit(request, "places-search", 60)
    near = (lat, lng) if lat is not None and lng is not None else None
    found = search_place(q, near=near, radius_m=radius)
    return found if found else {"available": False}


@app.get("/api/places/photo")
def places_photo_endpoint(request: Request, ref: str = Query(..., min_length=1)) -> Response:
    """Proxy one Google place photo as image bytes.

    ``ref`` is the photo resource name the details payload handed the browser
    (``places/<id>/photos/<photo>`` — shape-validated in the client, so this
    is not an open proxy; the resolve step yields an ephemeral keyless media
    URL). Bytes are cached 15 min in-process (transient display cache —
    nothing is stored, #95 decision).
    """
    _rate_limit(request, "places-photo", 120)
    got = place_photo_bytes(ref)
    if not got:
        raise HTTPException(status_code=404, detail="Photo unavailable")
    raw, content_type = got
    return Response(
        content=raw,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=900"},
    )


# Trip media (covers, gallery images) — referenced as /media/<trip_id>/<file>.
# Issue #47: objects live in the Garage S3 bucket (private) and are streamed
# through this proxy. The trip segment is the trip's $dtId (dashed UUID) — the
# durable identity, NOT the repo-folder slug (which is organizational and can
# collide). Data stores bare filenames; the serializer (_public_trip) prefixes
# them into this URL shape, so frontend / PDF / graph are unchanged. When no
# media store is configured (dev / CI without bucket AND no baked assets),
# the route serves 404 as-is rather than mounting a non-existent directory.
def _serve_stored_media(request: Request, key: str, file_name: str) -> Response:
    """Stream one stored media object, honouring a single byte range (#250).

    A video needs this to be usable at all: without ``Content-Length`` and
    ``Accept-Ranges`` a ``<video>`` element cannot seek — it cannot even learn
    how long the file is — and without a 206 the browser has to pull the whole
    clip before it shows a frame. Ranges are answered from the store with an
    OFFSET (never by reading the object and slicing it), so seeking in a 1 GB
    video costs the bytes asked for instead of the whole file.

    An unsatisfiable range answers 416 with ``Content-Range: bytes */<size>`` —
    the truth a player probing past the end needs; a malformed one is ignored
    and the whole object is served (RFC 9110).
    """
    store = get_media_store()
    if store is None:
        raise HTTPException(404, "Not Found")
    size = store.stat(key)
    if size is None:
        raise HTTPException(404, "Not Found")
    headers = {
        "Cache-Control": "public, max-age=86400, immutable",
        "Accept-Ranges": "bytes",
    }
    try:
        window = parse_byte_range(request.headers.get("range"), size)
    except RangeNotSatisfiable:
        return Response(
            status_code=416,
            headers={**headers, "Content-Range": f"bytes */{size}"},
        )
    if window is None:
        chunks = store.get(key)
        if chunks is None:
            raise HTTPException(404, "Not Found")
        headers["Content-Length"] = str(size)
        return StreamingResponse(
            chunks, media_type=media_content_type(file_name), headers=headers
        )
    start, end = window
    chunks = store.get(key, start=start, length=end - start)
    if chunks is None:
        raise HTTPException(404, "Not Found")
    headers["Content-Range"] = f"bytes {start}-{end - 1}/{size}"
    headers["Content-Length"] = str(end - start)
    return StreamingResponse(
        chunks,
        status_code=206,
        media_type=media_content_type(file_name),
        headers=headers,
    )


@app.get("/media/{trip_id}/{file_name}", include_in_schema=False)
def media_file(trip_id: str, file_name: str, request: Request) -> Response:
    """Stream a trip media object from the configured store.

    The first path segment is the trip's ``$dtId`` (dashed UUID) — the durable
    identity — never the repo-folder slug. It is structurally validated first
    (as is the flat file name): a ``..`` or encoded-slash traversal lands here
    as a 404 with no filesystem/bucket lookup. When valid, the store is asked
    for the bytes; a miss is a 404 (not a 500). This is the single seam where
    a future crew-level media ACL (#64) will plug in.

    Byte ranges (#250) — a video in a block, a gallery or a chat bubble is the
    same object as any photo here, served with the headers that let a player
    seek it.
    """
    if not is_valid_media_path(trip_id, file_name):
        raise HTTPException(404, "Not Found")
    return _serve_stored_media(request, object_key_for(trip_id, file_name), file_name)


@app.get("/inbox/{file_name}", include_in_schema=False)
def inbox_file(file_name: str, request: Request) -> Response:
    """Stream a staged inbox file (landing-chat upload, #9 / M4).

    Inbox keys are content-addressed (sha256[:32]) — the flat name is the
    unguessable capability, exactly like trip media above. The name is
    structurally validated the same way (``..`` / separators → 404, no
    filesystem/bucket lookup). This route exists so the agent can fetch the
    bytes over plain HTTPS before a trip exists; once the file is promoted
    into a trip it is served from the canonical ``/media`` route instead.

    Videos are staged and served the same way, byte ranges included (#250) —
    an attached clip has to be playable before the trip that will hold it even
    exists.
    """
    if not is_valid_media_name(file_name):
        raise HTTPException(404, "Not Found")
    return _serve_stored_media(request, f"inbox/{file_name}", file_name)


# ------------------------------------------------------------- chat relay (#9 / M3)
# The SPA's chat panel talks to the kiseki content agent through these routes.
# Identity is bearer-first (Niko's rule): a real end-user token IS the actor
# (mode 1); the sanctioned agent M2M token needs a request-scoped
# X-Act-As-Sub header (mode 2) — see acl.resolve_request_actor_sub. Files land
# in the trip's Garage media namespace and come back as /media URLs the agent
# can consume (the Hermes api server accepts inline image URLs but no uploads).
#
# Since #217 a turn is a SERVER-side object: POST /api/chat starts it — or
# attaches to it — GET /api/chat/turn asks how it is doing, POST /api/chat/stop
# ends it. The browser connection is only a viewer: closing it (tab switch,
# tunnel, proxy idle timeout) no longer cancels the agent's work, and the SPA
# reconnects by attaching at the frame cursor it has already rendered.


@app.post("/api/chat")
async def post_chat(
    body: ChatRequest,
    x_act_as_sub: str | None = Header(default=None),
    user: dict = Depends(get_current_user),
) -> StreamingResponse:
    """Start — or re-attach to — a chat turn; stream its frames (SSE v1, #217).

    Resolves the acting sub (bearer → mode 1/2), optionally gates the named
    trip like any read (follower+), then streams the turn's UI-message-stream
    v1 frames (text-start/text-delta/text-end/finish, terminated by
    ``data: [DONE]``) with ``x-vercel-ai-ui-message-stream: v1``. Conversation
    history lives on the Hermes side, scoped per acting user (and trip) — only
    the new user message is forwarded each turn.

    Resumability: with a ``turnKey`` the turn is submitted ONCE (a repeat is
    an upstream idempotency replay of the same run), and every later request
    for that key — the reconnect after a dropped connection above all — only
    ATTACHES, replaying from ``cursor``. A request without a ``turnKey``
    (older SPA bundle) behaves like the old wire but is still relay-owned: the
    turn keeps running even if its caller goes away.

    The turn is registered against its CONVERSATION too, so ``/api/chat/turn``
    can answer for it when asked with only a ``threadId`` (#217).
    """
    actor_sub = resolve_request_actor_sub(user, x_act_as_sub)
    if body.tripId:
        require_actor_trip_access(actor_sub, body.tripId, min_role="follower")
    turn_key = (body.turnKey or "").strip() or new_turn_key()
    key = turn_key_for(
        actor_sub,
        trip_id=body.tripId,
        thread_id=body.threadId,
        turn_key=turn_key,
    )
    scope = thread_scope(actor_sub, trip_id=body.tripId, thread_id=body.threadId)
    known = get_turn(key)
    # The submitted body is built (validated) BEFORE the stream starts: a
    # request with no user message must still fail as a 400, not as an
    # in-stream error on an already-accepted connection.
    upstream = None
    if known is None:
        upstream = build_run_body(
            body.messages,
            actor_sub=actor_sub,
            trip_id=body.tripId,
            thread_id=body.threadId,
        )

    async def _stream():
        turn = known
        cursor = max(0, body.cursor or 0)
        if turn is None:
            assert upstream is not None  # built above when the turn is new
            cursor = 0  # a new turn has a new buffer — attach from its start
            try:
                turn = await start_turn(
                    key,
                    body=upstream,
                    session_key=actor_sub,
                    client_turn_key=turn_key,
                    scope=scope,
                )
            except HTTPException as exc:
                # Headers are already sent — the status can't change, so signal
                # the failure in-stream (upstream 502/503 surfaces here).
                yield sse_data(error_chunk(str(exc.detail)))
                yield SSE_DONE
                return
        try:
            async for frame in attach_turn_stream(turn, cursor=cursor):
                yield frame
        except HTTPException as exc:
            yield sse_data(error_chunk(str(exc.detail)))
            yield SSE_DONE

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "x-vercel-ai-ui-message-stream": "v1",
        },
    )


@app.get("/api/chat/turn")
async def get_chat_turn(
    turn_key: str | None = Query(default=None, alias="turnKey"),
    trip_id: str | None = Query(default=None, alias="tripId"),
    thread_id: str | None = Query(default=None, alias="threadId"),
    x_act_as_sub: str | None = Header(default=None),
    user: dict = Depends(get_current_user),
) -> dict:
    """Is this turn still running, settled, and how much output does it have?

    The SPA asks this after a dropped connection (and when opening a thread) to
    choose between attaching to the remaining frames and rendering the turn as
    settled. It never starts work, so polling it is always safe (#217).

    Two ways to name the turn: the ``turnKey`` the caller minted, or — for a
    client that opens the thread without one (cleared storage, another tab) —
    the ``threadId`` alone, which resolves to the conversation's most recent
    turn and answers with its ``turnKey`` so the caller can adopt it and
    attach. The reply carries the turn key either way.
    """
    actor_sub = resolve_request_actor_sub(user, x_act_as_sub)
    if trip_id:
        require_actor_trip_access(actor_sub, trip_id, min_role="follower")
    if turn_key:
        turn = get_turn(
            turn_key_for(
                actor_sub,
                trip_id=trip_id,
                thread_id=thread_id,
                turn_key=turn_key,
            )
        )
    elif thread_id:
        turn = latest_turn_for_thread(
            actor_sub, trip_id=trip_id, thread_id=thread_id
        )
    else:
        raise HTTPException(
            status_code=400, detail="turnKey or threadId is required."
        )
    if turn is None:
        return {"known": False}
    return {
        "known": True,
        "turnKey": turn.turn_key,
        "runId": turn.run_id,
        **turn_status_payload(turn),
    }


@app.post("/api/chat/stop")
async def post_chat_stop(
    body: TurnRequest,
    x_act_as_sub: str | None = Header(default=None),
    user: dict = Depends(get_current_user),
) -> dict:
    """Interrupt a running turn upstream — the SPA's Stop control (#217).

    Now that closing the connection no longer ends a turn, this is the only
    way to end one early. A turn the relay doesn't know about is a no-op
    rather than an error: the caller's intent (stop) already holds.
    """
    actor_sub = resolve_request_actor_sub(user, x_act_as_sub)
    if body.tripId:
        require_actor_trip_access(actor_sub, body.tripId, min_role="follower")
    key = turn_key_for(
        actor_sub,
        trip_id=body.tripId,
        thread_id=body.threadId,
        turn_key=body.turnKey,
    )
    turn = get_turn(key)
    if turn is None:
        raise HTTPException(status_code=404, detail="Unknown chat turn")
    if not turn.done:
        try:
            await stop_chat_run(turn.run_id, session_key=actor_sub)
        except RunGone:
            pass  # already gone upstream — nothing left to interrupt
    return {"stopped": True, "runId": turn.run_id, **turn_status_payload(turn)}


@app.post("/api/files")
async def post_files(
    trip_id: str | None = Form(default=None),
    trip_id_camel: str | None = Form(default=None, alias="tripId"),
    poster_of: str | None = Form(default=None),
    poster_of_camel: str | None = Form(default=None, alias="posterOf"),
    file: UploadFile = File(...),
    x_act_as_sub: str | None = Header(default=None),
    user: dict = Depends(get_current_user),
) -> dict:
    """Upload a file for the agent to use — into a trip, or the user's inbox.

    With ``trip_id``: requires editor+ on the trip (files attach to trip
    content) and stores the bytes under the trip's own media key. Without it
    (the landing chat, before any trip exists): any authenticated user may
    stage a file into the shared inbox namespace ``inbox/<name>`` — the name
    is content-addressed (sha256[:32]), so the returned URL is an unguessable
    capability exactly like trip media. The agent promotes inbox files into a
    trip via ``POST /api/files/promote`` once the trip exists. Bytes are
    content-addressed in both cases; the returned URL is what the SPA drops
    into the next chat message as an ``image_url`` part (or text link).

    What is stored is always renderable (#251): a HEIC/HEIF photo (iPhone
    default) is transcoded to JPEG with its EXIF intact — browsers cannot
    display HEIC, and one was previously stored as-is, served as
    ``application/octet-stream`` and silently invisible. A file that cannot be
    stored in a displayable form is refused with a 422 naming it, never
    accepted and then dropped.

    Types are a curated set (#250): exactly what the composer's picker offers
    (`UPLOAD_KINDS` in ``app/media.py`` mirrors its ``accept``). Anything else —
    a zip, a raw camera format, a container no browser plays — is a 422 naming
    the file, because accepting bytes that no surface renders is how a video
    used to vanish silently. Videos additionally stream to a spool file with
    their family's cap enforced on the way (#250: ``await file.read()`` put a
    whole clip in the API process, and the container is sized for the app).

    ``poster_of`` (#250) makes this request the SECOND half of a video attach:
    the SPA sends the frame it grabbed from the clip and names the video it
    belongs to, and the bytes are stored as that video's poster
    (``<stem>_poster.jpg`` — the convention every render surface derives from
    the video URL alone, so no model field and no second reference to keep in
    sync). The client cannot choose the name: it names the VIDEO, the server
    derives the poster's, so this adds no way to write an arbitrary key.
    """
    actor_sub = resolve_request_actor_sub(user, x_act_as_sub)
    file_name = file.filename or ""
    # FastAPI matches form field names literally, and the SPA had shipped these
    # as camelCase (`tripId`) while the route documents the snake_case names —
    # so every upload from a trip chat landed in the inbox namespace instead of
    # the trip's. Both spellings are accepted (#250); the SPA now sends the
    # documented ones.
    trip_id = trip_id or trip_id_camel
    poster_of = poster_of or poster_of_camel
    if poster_of is not None:
        return await _store_poster_frame(poster_of, file, trip_id, actor_sub)
    try:
        kind = require_upload_kind(file_name, file_name)
    except UnsupportedUpload as exc:
        raise HTTPException(422, str(exc)) from exc
    if trip_id is not None:
        require_actor_trip_access(actor_sub, trip_id, min_role="editor")
    # Authorization decides before configuration does (#250): a caller who may
    # not write to this trip gets a 403 whether or not the bucket is set up —
    # the reverse order turned a missing bucket into a reply about permissions.
    store = get_media_store()
    if store is None:
        raise HTTPException(503, "Media storage is not configured")
    # Spool the body to disk while hashing it (#250): nothing large is ever
    # held in this process, and the cap is enforced before the bytes are.
    with tempfile.TemporaryDirectory() as spool_dir:
        spool = Path(spool_dir) / "upload"
        try:
            with spool.open("wb") as sink:
                size, digest = await asyncio.to_thread(
                    stream_upload, file.file, sink, upload_limit(kind), file_name
                )
        except UploadTooLarge as exc:
            raise HTTPException(413, str(exc)) from exc
        except UnsupportedUpload as exc:
            raise HTTPException(422, str(exc)) from exc
        if size == 0:
            raise HTTPException(422, "Empty file")
        by_reference = kind == "video"  # stored from the spool file, never bytes
        raw = spool.read_bytes() if not by_reference else b""
        # HEIC → JPEG at ingest (#251): an iPhone photo stored as-is was served
        # as `application/octet-stream` and rendered nowhere. A file that cannot
        # be stored in a displayable form is refused HERE, per file, with the
        # reason — never accepted and then dropped from the reply.
        converted = False
        if by_reference:
            ext = Path(file_name).suffix.lower()
        else:
            try:
                raw, ext, converted = normalize_upload(raw, file_name)
            except UnsupportedUpload as exc:
                raise HTTPException(422, str(exc)) from exc
        name = key_from_digest(digest, ext) if by_reference else content_addressed_key(raw, ext)
        content_type = media_content_type(name)
        # Photo ingest (#190): the capture timestamp + GPS travel with the
        # response so the client can place the batch without re-reading bytes.
        # Read from the STORED bytes — the transcode carries EXIF across, so a
        # HEIC photo reports the same capture metadata a JPEG would.
        # Additive — the `url` contract is unchanged. A video has no EXIF to
        # read (and reading a 1 GB clip to look for none is not a trade worth
        # making), so it reports the empty mapping.
        sha = digest if by_reference else hashlib.sha256(raw).hexdigest()
        exif = {} if by_reference else extract_exif(raw)
        if trip_id is None:
            # Inbox staging (landing chat). Content-addressed name = capability.
            key = f"inbox/{name}"
            if by_reference:
                store.put_file(key, spool, content_type)
            else:
                store.put(key, raw, content_type)
            return {
                "url": f"/inbox/{name}",
                "sha256": sha,
                "exif": exif,
                "name": name,
                "contentType": content_type,
                "converted": converted,
            }
        key = object_key_for(trip_id.lower(), name)
        if by_reference:
            store.put_file(key, spool, content_type)
        else:
            store.put(key, raw, content_type)
        return {
            "url": f"/media/{trip_id.lower()}/{name}",
            "sha256": sha,
            "exif": exif,
            "name": name,
            "contentType": content_type,
            "converted": converted,
        }


async def _store_poster_frame(
    video_name: str, file: UploadFile, trip_id: str | None, actor_sub: str
) -> dict:
    """Store the poster frame of a just-uploaded video (#250).

    The clip is already stored (the SPA sends its frame only after the video
    upload answered), so this only has to prove the video exists in the same
    namespace — a poster for a clip that is not there is a dangling key nobody
    will ever read, and refusing it keeps ``<stem>_poster.jpg`` meaningful.
    """
    label = file.filename or "poster"
    if not is_valid_media_name(video_name) or not is_video_name(video_name):
        raise HTTPException(422, "poster_of must name an uploaded video")
    if trip_id is None:
        video_key = f"inbox/{video_name}"
    else:
        # Same order as post_files: the role gate decides before the bucket
        # does, so a follower gets a 403 and never a hint about our config.
        require_actor_trip_access(actor_sub, trip_id, min_role="editor")
        video_key = object_key_for(trip_id.lower(), video_name)
    store = get_media_store()
    if store is None:
        raise HTTPException(503, "Media storage is not configured")
    if store.stat(video_key) is None:
        raise HTTPException(404, "Video not found")
    # Spooled and capped like any other upload: the frame is an image, but it
    # arrives over the same POST body, so it must not be the one path that
    # reads an unbounded body into this process.
    with tempfile.TemporaryDirectory() as spool_dir:
        spool = Path(spool_dir) / "poster"
        try:
            with spool.open("wb") as sink:
                size, _digest = await asyncio.to_thread(
                    stream_upload, file.file, sink, upload_limit("image"), label
                )
        except UploadTooLarge as exc:
            raise HTTPException(413, str(exc)) from exc
        except UnsupportedUpload as exc:
            raise HTTPException(422, str(exc)) from exc
        if size == 0:
            raise HTTPException(422, "Empty file")
        raw = spool.read_bytes()  # bounded by the image cap enforced above
    try:
        jpeg = to_jpeg(raw, label)
    except UnsupportedUpload as exc:
        raise HTTPException(422, str(exc)) from exc
    name = poster_name_for(video_name)
    content_type = media_content_type(name)
    if trip_id is None:
        store.put(f"inbox/{name}", jpeg, content_type)
        url = f"/inbox/{name}"
    else:
        store.put(object_key_for(trip_id.lower(), name), jpeg, content_type)
        url = f"/media/{trip_id.lower()}/{name}"
    return {"url": url, "name": name, "contentType": content_type, "posterOf": video_name}


class PromoteBody(BaseModel):
    """Move one staged inbox file into a trip's media namespace (#9 / M4)."""

    trip_id: str
    file_name: str


@app.post("/api/files/promote", status_code=200)
async def promote_file(
    body: PromoteBody,
    x_act_as_sub: str | None = Header(default=None),
    user: dict = Depends(get_current_user),
) -> dict:
    """Move an inbox file into a trip's media namespace (editor+ on the trip).

    The landing chat stages uploads into the user's inbox (no trip yet); once
    the agent has created a trip from that conversation it calls this route so
    the bytes live under the trip's own media key and the canonical
    ``/media/<trip>/<name>`` URL (what ``resolve_media_urls`` emits). Returns
    the trip URL; the inbox copy is deleted (a move, not a copy).

    A store-side copy (#250): this used to join every chunk in memory, which
    for a video is the exact failure the streaming upload exists to avoid.
    A poster frame follows its video for free — ``<stem>_poster.jpg`` is
    promoted by the SPA alongside the clip it belongs to.
    """
    actor_sub = resolve_request_actor_sub(user, x_act_as_sub)
    trip_id = body.trip_id.lower()
    require_actor_trip_access(actor_sub, trip_id, min_role="editor")
    if not is_valid_media_name(body.file_name):
        raise HTTPException(404, "Not Found")
    store = get_media_store()
    if store is None:
        raise HTTPException(503, "Media storage is not configured")
    inbox_key = f"inbox/{body.file_name}"
    if store.stat(inbox_key) is None:
        raise HTTPException(404, "Inbox file not found")
    store.copy(inbox_key, object_key_for(trip_id, body.file_name))
    store.delete(inbox_key)
    return {"url": f"/media/{trip_id}/{body.file_name}"}


@app.post("/api/trips/{trip_id}/photos/propose")
def propose_photos_route(
    trip_id: str,
    body: photos_svc.ProposeBody,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Placement proposal for an uploaded photo batch (issue #190) — READ-ONLY.

    Converts each photo's capture timestamp to the trip's timezone (#42)
    and returns ``{placements, undated}`` for the human to confirm. Writes
    NOTHING; the confirmed write is ``POST …/photos/confirm``. Identity
    scoping rides the neighboring write-route gate (editor+).
    """
    _ = actor  # role verified by the dependency; the proposal itself is a pure read
    return _write(photos_svc.propose_photos, trip_dtid=trip_id.lower(), body=body)


@app.post("/api/trips/{trip_id}/photos/confirm")
def confirm_photos_route(
    trip_id: str,
    body: photos_svc.ConfirmBody,
    actor: dict = Depends(require_trip_role("editor")),
) -> dict:
    """Apply human-confirmed photo placements (issue #190).

    Block-targeted photos append to ``Block.images`` (render decision A,
    #191); day-level photos append to (or create) a ``gallery`` block at
    the chronologically correct position (decision B). Idempotent —
    re-importing the same batch reports ``skipped`` instead of duplicating.
    """
    trip, written, skipped = _write(
        photos_svc.confirm_placements,
        trip_dtid=trip_id.lower(),
        actor=actor,
        body=body,
    )
    return {**_public_trip(trip, my_role=actor["role"]), "written": written, "skipped": skipped}


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
        # History-mode fallback ONLY for real SPA routes (App.tsx: "/" +
        # "/join/:claimToken" + "/t/:tripId/*" + "/u/:sub" + "/me"). Anything else
        # — a normalized "/media/../pic.jpg" (-> "/pic.jpg"), a decoded traversal
        # that missed the media route, a deleted endpoint — must 404, never the
        # index shell (a 200 shell reads like the path exists and masks 404s).
        # NB: adding a route to App.tsx means adding it here too, or the deep
        # link / reload 404s while in-app navigation still works.
        is_spa_route = (
            full_path == ""
            or full_path == "t"
            or full_path.startswith("t/")
            or full_path == "join"
            or full_path.startswith("join/")
            or full_path == "me"
            or full_path == "feed"
            or full_path == "u"
            or full_path.startswith("u/")
        )
        if not is_spa_route:
            raise HTTPException(status_code=404, detail="Not Found")
        # SPA shell — trip routes get a noindex robots meta + header (private links),
        # and so does /feed: it is per-viewer and never a public document.
        is_trip = full_path.startswith("t/") or full_path == "t"
        headers = {}
        if is_trip or full_path == "feed":
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
