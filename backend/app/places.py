"""Google Places API (New) client — live web-only place overlay (#95).

The browser never talks to Google: /api/places/details and /api/places/photo
proxy everything through the backend so ``GOOGLE_MAPS_API_KEY`` stays
server-side (same pattern as the HERE proxies, issue #15).

Compliance frame (references/google-places-compliance.md, #15/#95 standing
decision): nothing Google-derived is ever persisted. Ratings, review snippets
and photo metadata live only in these short-TTL in-process caches; photo BYTES
are proxied per request with a short-TTL cache keyed by the *ephemeral* Google
media URL, never written to disk or S3. ``place_id`` remains the only
storable field. Every response that carries Google content also carries the
attribution the UI must render (``googleMapsUri`` per the display rules).

Graceful absence: any Google error/timeout/no-rating answers
``{"available": False}`` (HTTP 200) so cards silently render nothing — the
trip data itself is always complete without this overlay.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request

from .config import GOOGLE_MAPS_API_KEY, GOOGLE_PLACES_URL

# Short-TTL display caches (in-process, like the route/directions caches in
# main.py). Not storage: entries die with the process and the TTLs are
# minutes, not days. Details TTL covers a card-render burst (15 trip days ×
# N places load at once) without re-hitting Google per mount.
_DETAILS_TTL = 300.0  # 5 min — rating + review snippets + photo metadata
_PHOTO_TTL = 900.0  # 15 min — proxied photo bytes (issue #95 decision)
_SEARCH_TTL = 86400.0  # 24 h — venue name → place_id is effectively static
#: Default radius of the location bias `search_place` sends, in metres, when the
#: caller supplies a point but no radius: big enough to hold a country-scale
#: trip's spread, since Google treats the circle as a ranking hint (#255).
_BIAS_RADIUS_M = 200_000
_MAX_REVIEW_SNIPPETS = 3

_details_cache: dict[str, tuple[float, dict]] = {}
_photo_cache: dict[str, tuple[float, bytes, str]] = {}
_search_cache: dict[str, tuple[float, dict]] = {}


def places_configured() -> bool:
    """True when a Places API key is present (the overlay is optional)."""
    return bool(GOOGLE_MAPS_API_KEY)


def clear_caches() -> None:
    """Test isolation — drop every cache."""
    _details_cache.clear()
    _photo_cache.clear()
    _search_cache.clear()


def _request(url: str, *, method: str = "GET", field_mask: str | None = None, body: bytes | None = None) -> tuple[int, bytes]:
    """One Google API call. Returns (status, body). Never raises on HTTP errors.

    ``Content-Type`` must be set BEFORE the ``Request`` is built: urllib
    snapshots the header mapping, so adding it afterwards (harmless while every
    call was a GET) sends a POST body Google rejects as untyped.
    """
    headers = {"X-Goog-Api-Key": GOOGLE_MAPS_API_KEY}
    if field_mask:
        headers["X-Goog-FieldMask"] = field_mask
    if body:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception:
        return 0, b""


def place_details(place_id: str) -> dict | None:
    """Place Details (New) for a stored place_id — the live overlay payload.

    Field mask (unprefixed tokens for the v1 details endpoint): the rating,
    up to 3 review snippets with their author attribution, photo metadata and
    the mandatory ``googleMapsUri`` deep link. Returns None on any failure or
    when the key is absent — callers treat that as "no overlay".
    """
    if not places_configured() or not place_id:
        return None
    hit = _details_cache.get(place_id)
    now = time.monotonic()
    if hit and hit[0] > now:
        return hit[1]

    mask = ",".join(
        [
            "id",
            "rating",
            "userRatingCount",
            "googleMapsUri",
            "reviews",
            "photos",
        ]
    )
    status, raw = _request(
        f"{GOOGLE_PLACES_URL}/places/{place_id}",
        field_mask=mask,
    )
    if status != 200:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None

    out: dict = {"available": True, "placeId": place_id}
    if data.get("rating") is not None:
        out["rating"] = data["rating"]
    if data.get("userRatingCount") is not None:
        out["userRatingCount"] = data["userRatingCount"]
    if data.get("googleMapsUri"):
        out["googleMapsUri"] = data["googleMapsUri"]

    # Review snippets — up to N, each with its author attribution (the
    # display rules require author credit + a link to the review on Google;
    # the profile link doubles as that per-item deep link alongside
    # googleMapsUri).
    reviews = []
    for r in (data.get("reviews") or [])[:_MAX_REVIEW_SNIPPETS]:
        author = r.get("authorAttribution") or {}
        reviews.append(
            {
                "text": r.get("text", {}).get("text") if isinstance(r.get("text"), dict) else r.get("text"),
                "relativePublishTimeDescription": r.get("relativePublishTimeDescription"),
                "authorName": author.get("displayName"),
                "authorUri": author.get("uri"),
                "authorPhotoUrl": author.get("photoUri"),
                "googleMapsUri": r.get("googleMapsUri") or data.get("googleMapsUri"),
            }
        )
    if reviews:
        out["reviews"] = reviews

    # Photo metadata (never bytes): the frontend uses these to call
    # /api/places/photo. `name` is the media resource path; width/height let
    # the UI request a properly-sized crop.
    photos = []
    for p in (data.get("photos") or [])[:3]:
        attributions = []
        for a in p.get("authorAttributions") or []:
            entry: dict = {}
            if a.get("displayName"):
                entry["displayName"] = a["displayName"]
            if a.get("uri"):
                entry["uri"] = a["uri"]
            if entry:
                attributions.append(entry)
        photos.append(
            {
                "name": p.get("name"),
                "widthPx": p.get("widthPx"),
                "heightPx": p.get("heightPx"),
                "authorAttributions": attributions,
            }
        )
    if photos:
        out["photos"] = photos

    if len(_details_cache) > 512:
        _details_cache.clear()
    _details_cache[place_id] = (now + _DETAILS_TTL, out)
    return out


def search_place(
    query: str,
    *,
    near: tuple[float, float] | None = None,
    radius_m: int | None = None,
) -> dict | None:
    """Resolve a venue's TEXT query to its ``place_id`` + exact coordinates.

    The resolution step the content agent needs (issue #187): a venue name in,
    the durable key out. Previously nothing did this — the agent either
    hand-rolled a Places script (which died with the turn budget) or wrote
    city-level locations, which is how a trip ends up with a generic
    ``maps/search?api=1&query=Tokyo`` link on every activity.

    ``near``/``radius_m`` bias the candidate ranking toward a point the caller
    already trusts (the trip's own coordinates). Place names repeat across
    countries — "Hotel Presidente" is a Madrid hotel and a San José hotel — and
    the unbiased top result is whatever Google ranks first, so a trip silently
    acquires a venue on another continent. It is a bias, not a filter: a genuine
    far-away entry still resolves (the caller reports it instead, #255).

    Places API (New) ``places:searchText``. Compliance (#15/#95): this function
    returns Google content but persists nothing — the caller stores only
    ``placeId`` (indefinite) plus lat/lng (≤30 d) and its own editorial text.
    Ratings/reviews/photos are never stored.

    Returns ``None`` when the key is absent, the query is blank, Google fails,
    or nothing matched; callers treat all of those as "not resolvable".
    """
    text = (query or "").strip()
    if not places_configured() or not text:
        return None
    bias = None
    if near is not None and isinstance(near[0], (int, float)) and isinstance(near[1], (int, float)):
        bias = (round(float(near[0]), 5), round(float(near[1]), 5), int(radius_m or _BIAS_RADIUS_M))
    cache_key = text.lower() if bias is None else f"{text.lower()}|{bias}"
    hit = _search_cache.get(cache_key)
    now = time.monotonic()
    if hit and hit[0] > now:
        return hit[1]

    request: dict = {"textQuery": text, "maxResultCount": 1}
    if bias is not None:
        request["locationBias"] = {
            "circle": {
                "center": {"latitude": bias[0], "longitude": bias[1]},
                "radius": float(bias[2]),
            }
        }
    body = json.dumps(request).encode("utf-8")
    status, raw = _request(
        f"{GOOGLE_PLACES_URL}/places:searchText",
        method="POST",
        field_mask=(
            "places.id,places.displayName,places.formattedAddress,"
            "places.location,places.googleMapsUri,places.primaryType"
        ),
        body=body,
    )
    if status != 200:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    found = data.get("places") or []
    if not found:
        return None
    first = found[0]
    location = first.get("location") or {}
    out = {
        "available": True,
        "placeId": first.get("id"),
        "query": text,
        "name": (first.get("displayName") or {}).get("text"),
        "address": first.get("formattedAddress"),
        "lat": location.get("latitude"),
        "lng": location.get("longitude"),
        "googleMapsUri": first.get("googleMapsUri"),
        "primaryType": first.get("primaryType"),
    }
    if not out["placeId"]:
        return None
    if len(_search_cache) > 1024:
        _search_cache.clear()
    _search_cache[cache_key] = (now + _SEARCH_TTL, out)
    return out


def photo_media_url(name: str, *, max_height: int = 400) -> str | None:
    """Resolve a photo resource name to the ephemeral media URL.

    ``GET {GOOGLE_PLACES_URL}/{name}:media?maxHeightPx=…`` with the media
    field mask answers 200 + JSON {photoUri} (the ephemeral, keyless,
    maxheight-badged URL). No API key may ever appear in the returned URL —
    Google's media host would see it on the image fetch otherwise.
    """
    if not places_configured() or not name:
        return None
    status, raw = _request(
        f"{GOOGLE_PLACES_URL}/{name}/media?maxHeightPx={max_height}&skipHttpRedirect=true",
        field_mask="photoUri",
    )
    if status != 200:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    uri = data.get("photoUri")
    if not uri or "X-Goog-Api-Key" in uri or "key=" in uri:
        return None  # never propagate a keyed URL
    return uri


# A photo resource name is exactly what place_details() handed out —
# ``places/<place>/photos/<photo>``. Validating the shape before any fetch
# keeps the /api/places/photo proxy from being an open URL forwarder.
_PHOTO_NAME_RE = re.compile(r"^places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_-]+$")


def photo_by_name(name: str) -> tuple[bytes, str] | None:
    """Photo bytes for a photo resource name (resolve → fetch, both cached).

    The resolve step (name → ephemeral keyless URL) is cached for the photo
    TTL too — Google's media URLs outlive that comfortably and the details
    cache above re-refreshes names every 5 minutes anyway.
    """
    if not _PHOTO_NAME_RE.match(name or ""):
        return None
    uri = photo_media_url(name)
    if not uri:
        return None
    return photo_bytes(uri)


def photo_bytes(uri: str) -> tuple[bytes, str] | None:
    """Fetch image bytes for an ephemeral (already-keyless) media URL.

    Returns (bytes, content_type) or None. The browser only ever sends the
    opaque token we handed it; arbitrary URLs are never fetched.
    """
    hit = _photo_cache.get(uri)
    now = time.monotonic()
    if hit and hit[0] > now:
        return hit[1], hit[2]
    status, raw = _request(uri)
    if status != 200 or not raw:
        return None
    content_type = "image/jpeg"
    if raw[:3] == b"\x89PNG":
        content_type = "image/png"
    elif raw[:6].startswith(b"GIF"):
        content_type = "image/gif"
    elif raw[:12].lower().startswith(b"\xff\xd8"):
        content_type = "image/jpeg"
    elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        content_type = "image/webp"
    if len(_photo_cache) > 128:
        _photo_cache.clear()
    _photo_cache[uri] = (now + _PHOTO_TTL, raw, content_type)
    return raw, content_type
