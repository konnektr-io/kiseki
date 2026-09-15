"""Trip media storage (issue #47) — Garage object storage with a local fallback.

Media moved OUT of the repo into the S3-compatible Garage bucket (private,
never exposed). The app serves it at ``GET /media/<trip_id>/<file>``, where
``trip_id`` is the trip's ``$dtId`` (the opaque GUID from ``trip.json``'s ``id``
field) — NOT the repo-folder slug, which is organizational and can collide.
The bucket layout mirrors the URL: ``media/<trip_id>/<file>``.

The data model never stores a media *path*: media-bearing fields in
``trip.json`` (and the graph twins seeded from it) hold **bare filenames**
(e.g. ``c383ce57….jpg``). The URL prefix is a rendering concern — this module
canonicalizes bare filenames (and any legacy ``/media/<slug>/…`` strings) into
``/media/<trip_id>/<file>`` at API serialization time, so the frontend, the
booklet PDF renderer and every other consumer only ever see full URLs and
never care about the storage backend.

* **S3MediaStore** (production): streams objects from the Garage bucket.
  Enabled when every ``KISEKI_S3_*`` env var is set (see config.py).
* **LocalMediaStore** (dev / tests): serves from ``backend/data/assets/`` when
  the S3 env is absent and the directory exists — repo ships no assets, so this
  only lights up for tmp test fixtures / legacy checkouts.

Privacy (decisions recorded on #47): object keys are UNGUESSABLE — each file is
stored under ``<32 hex chars of its sha256>.<ext>``, NOT its original filename
— and the bucket itself is private (only this proxy holds credentials). The
proxy is the only reader; a future crew-level media ACL (#64) enforces at this
same seam. Keys are content-addressed (sha256 prefix), which makes migration
idempotent: re-running the upload for the same bytes writes the same key.
"""

from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Iterable, Optional, Protocol

from . import config

# Bucket objects live under media/<trip>/<file> — a shared bucket (future CNPG
# backups etc.) never collides with trip media at the bucket root.
KEY_PREFIX = "media/"

# Content types are decided by the extension on the URL — the object key keeps
# the extension exactly so the proxy never needs to ask the bucket for metadata.
MEDIA_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    # Video (#250): served like any other media object, but with byte ranges so
    # a <video> element can seek instead of only ever playing from the start
    # (see parse_byte_range). The browser needs the type to be honest about
    # this — served as application/octet-stream, a video is not playable.
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
}

# The ONE place that decides what a video IS: media content type, the upload
# policy, the poster-frame convention and the SPA's renderer all read this.
VIDEO_EXTS = (".mp4", ".m4v", ".mov", ".webm")

# Trip ids in media URLs are the trip's opaque $dtId (dashed UUID from
# trip.json `id`) — the durable identity. The repo-folder slug is NOT a valid
# media namespace (organizational; can collide).
_TRIP_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# Object file part: conservative ASCII whitelist. Covers both the migrated
# 32-hex.<ext> keys and legacy dev filenames. Path separators never match, so
# traversal is rejected structurally (Starlette decodes %2F into the param).
_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_FILE_MAX_LEN = 255

# A bare media filename as stored in trip.json / graph twins (no path, no
# scheme): name + a media extension. Content-addressed keys are 32-hex.<ext>;
# human names (e.g. during an image edit before the migrator runs) also match.
# Video extensions are here for the same reason as the image ones (#250): the
# data model keeps a BARE FILENAME, so an attached `…mp4` in a block's
# `images` (or a gallery item) has to canonicalize into its /media URL — as a
# bare name it was silently invisible on every surface.
_BARE_FILE_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp|gif|avif|svg|mp4|m4v|mov|webm)$",
    re.IGNORECASE,
)

# How many bytes per chunk when proxying an object (local or S3).
_CHUNK = 64 * 1024


def media_content_type(file_name: str) -> str:
    """Content type for a media file, from its extension."""
    return MEDIA_TYPES.get(Path(file_name).suffix.lower(), "application/octet-stream")


class RangeNotSatisfiable(ValueError):
    """A syntactically valid but unsatisfiable ``Range`` (→ 416)."""


def parse_byte_range(header: Optional[str], size: int) -> Optional[tuple[int, int]]:
    """``(start, end_exclusive)`` for a single-range request, else None.

    Byte ranges are what make a served video usable at all (#250): without them
    a ``<video>`` element cannot seek — the browser has no way to ask for the
    middle of the file, and cannot even learn how long it is. Only the plain
    ``bytes=a-b`` / ``bytes=a-`` / ``bytes=-n`` forms are honoured; anything
    else (multiple ranges, an unknown unit, junk) returns None so the caller
    serves the whole object, which every client accepts.

    Raises ``RangeNotSatisfiable`` when the range is well-formed but past the
    end: a player probing past EOF has to be told the truth (416 +
    ``Content-Range: bytes */size``), not handed a 200.
    """
    if not header or size <= 0:
        return None
    spec = header.strip()
    if not spec.lower().startswith("bytes="):
        return None
    spec = spec[len("bytes=") :]
    if "," in spec:  # multi-range: serve the whole object rather than half of it
        return None
    first, _, last = spec.partition("-")
    first, last = first.strip(), last.strip()
    try:
        if not first:  # suffix range: "-n" → the last n bytes
            length = int(last)
            if length <= 0:
                raise RangeNotSatisfiable(f"unsatisfiable byte range {header!r}")
            return max(size - length, 0), size
        start = int(first)
        if start >= size:
            raise RangeNotSatisfiable(f"unsatisfiable byte range {header!r}")
        if not last:
            return start, size
        end = int(last) + 1  # inclusive in the header, exclusive here
        if end <= start:
            raise RangeNotSatisfiable(f"unsatisfiable byte range {header!r}")
        return start, min(end, size)
    except ValueError as exc:
        if isinstance(exc, RangeNotSatisfiable):
            raise
        return None  # malformed: ignore the header, as RFC 9110 allows


# --------------------------------------------------------------------------
# Upload normalization (#251)
#
# iPhone photos arrive as HEIC/HEIF. Nothing in the stack can display them:
# browsers do not decode HEIC, so a stored ``.heic`` was served as
# ``application/octet-stream``, matched by no media extension, survived
# ``canonicalize_media`` as a bare name — and a whole camera roll therefore
# "uploaded" into a trip and was never visible. We transcode HEIC to JPEG at
# ingest instead, so every stored object is something the SPA, the booklet
# renderer and the model can actually read. AVIF (also a HEIF container) IS
# renderable and passes through untouched.
HEIC_EXTS = (".heic", ".heif")

# ISO-BMFF major/compatible brands. The HEIC family is Apple's grid-encoded
# HEIF plus the generic ``mif1``/``msf1`` brands; ``avif``/``avis`` are the one
# HEIF flavour every current browser renders, so those are NOT touched.
_HEIC_BRANDS = frozenset(b"heic heix hevc hevx heim heis hevm hevs mif1 msf1".split())
_RENDERABLE_HEIF_BRANDS = frozenset(b"avif avis".split())

# JPEG quality for the transcode. Source is a phone photo already compressed
# at a comparable quality, so this is visually lossless in practice and keeps
# the stored object inside the same size envelope as a native JPEG upload.
_HEIC_JPEG_QUALITY = 88


class UnsupportedUpload(ValueError):
    """An upload this build refuses to store (``POST /api/files`` → 422).

    Raised for a file whose bytes cannot be stored in a renderable form — a
    HEIC with no decoder — for a type outside the curated upload set (#250),
    and for a poster frame that is not an image. The client shows the message
    per file, which is the point: the alternative used to be accepting the
    bytes and dropping them from every surface that renders media (#251).
    """


class UploadTooLarge(ValueError):
    """An upload past its family's size cap (``POST /api/files`` → 413)."""


# ------------------------------------------------------------------ upload policy
# Videos made the old "read the whole body into memory, store whatever arrives"
# path untenable (#250): one 1 GB clip meant holding 1 GB in the API process
# (a container sized for the app, not for a video), and a type that nothing
# renders was accepted and then invisible on every surface.
#
# So: ONE curated table — the composer's picker offers exactly this set
# (``accept`` in ``frontend/src/components/chat-panel.tsx``) and anything else
# is a per-file 422 naming the file. Bodies are streamed to a spool file, never
# into memory, and each family has one cap.
UPLOAD_KINDS: dict[str, str] = {
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".webp": "image",
    ".gif": "image",
    ".avif": "image",
    # SVG stays accepted because ``accept="image/*"`` has always offered it, and
    # MEDIA_TYPES serves it as image/svg+xml from our own origin. That is a
    # stored-XSS surface to close on its own merits — not by widening this change.
    ".svg": "image",
    ".heic": "image",
    ".heif": "image",
    ".mp4": "video",
    ".m4v": "video",
    ".mov": "video",
    ".webm": "video",
    # Documents the picker offers: the AGENT reads these; nothing renders them.
    ".pdf": "document",
    ".doc": "document",
    ".docx": "document",
    ".txt": "document",
    ".md": "document",
}

_MB = 1024 * 1024

# Per-family caps. A video is the only kind legitimately measured in hundreds of
# MB; images and documents are still normalized in memory (HEIC → JPEG), so
# their cap is what keeps that allocation bounded.
UPLOAD_MAX_BYTES: dict[str, int] = {
    "image": 64 * _MB,
    "video": 1024 * _MB,
    "document": 32 * _MB,
}

# How much of a request body is held at once while spooling an upload.
_UPLOAD_CHUNK = 1024 * 1024

# Where a video's poster frame lives, relative to the video's own name: every
# surface DERIVES it from the video URL, so the data model keeps one media
# reference per item and never a second poster field.
POSTER_SUFFIX = "_poster.jpg"


def upload_kind(file_name: str) -> Optional[str]:
    """``"image"`` / ``"video"`` / ``"document"`` for an accepted upload, else None."""
    return UPLOAD_KINDS.get(Path(file_name or "").suffix.lower())


def upload_limit(kind: str) -> int:
    """Size cap (bytes) for one upload family."""
    return UPLOAD_MAX_BYTES[kind]


def is_video_name(file_name: str) -> bool:
    """True when a stored media name is a video — decided by extension."""
    return Path(file_name or "").suffix.lower() in VIDEO_EXTS


def poster_name_for(video_name: str) -> str:
    """Store name of a video's poster frame: ``<stem>_poster.jpg``."""
    return f"{Path(video_name).stem}{POSTER_SUFFIX}"


def require_upload_kind(file_name: str, label: str) -> str:
    """The kind of an upload, or ``UnsupportedUpload`` naming the file.

    The message is rendered on that file's chip in the composer, so it says
    what IS accepted instead of only what was refused.
    """
    kind = upload_kind(file_name)
    if kind is None:
        ext = Path(file_name or "").suffix.lower()
        raise UnsupportedUpload(
            f"{label}: {ext or 'this file'} is not a file type this build "
            "stores — attach a photo, a video (mp4/mov/webm) or a document"
        )
    return kind


def stream_upload(source, sink, limit: int, label: str) -> tuple[int, str]:
    """Spool ``source`` into ``sink`` in chunks → ``(size, sha256 hex)``.

    Nothing is held in memory: the previous ``await file.read()`` put a whole
    video in the API process. The cap is enforced WHILE copying, so an
    oversized upload is refused without buffering it first, and the digest
    (the content-addressed name) costs no second pass.
    """
    import hashlib

    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(_UPLOAD_CHUNK):
        size += len(chunk)
        if size > limit:
            raise UploadTooLarge(
                f"{label}: larger than the {limit // _MB} MB limit for this "
                "kind of file"
            )
        digest.update(chunk)
        sink.write(chunk)
    return size, digest.hexdigest()


def to_jpeg(raw: bytes, label: str) -> bytes:
    """Re-encode an image as JPEG — the one stored form for poster frames.

    The convention is ``<stem>_poster.jpg``, so the poster is JPEG whatever the
    client captured: a PNG poster would need its own name rule and break the
    derivation from the video URL.

    Raises ``UnsupportedUpload`` when the bytes are not a decodable image — a
    refused poster is a missing thumbnail at worst, never a stored object
    nothing can render.
    """
    _register_heif_decoder()  # a HEIC source is legitimate here too
    try:
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as image:
            out = io.BytesIO()
            image.convert("RGB").save(out, format="JPEG", quality=_HEIC_JPEG_QUALITY)
    except Exception as exc:
        raise UnsupportedUpload(f"{label}: could not be decoded as an image ({exc})") from exc
    return out.getvalue()


def _ftyp_brands(raw: bytes) -> list[bytes]:
    """ISO-BMFF brands declared in a leading ``ftyp`` box ([] when absent)."""
    if len(raw) < 12 or raw[4:8] != b"ftyp":
        return []
    size = int.from_bytes(raw[0:4], "big")
    end = size if 8 <= size <= len(raw) else len(raw)
    # major_brand, minor_version, then 4-byte compatible brands.
    brands = [raw[8:12]]
    brands.extend(raw[i : i + 4] for i in range(16, end - 3, 4))
    return brands


def is_unrenderable_heif(raw: bytes) -> bool:
    """True for a HEIF file no browser can render (HEIC — but never AVIF).

    Decided on the bytes, not the name: a photo exported as ``IMG_1.jpg``
    whose content is HEIC is the same unrenderable file.
    """
    brands = _ftyp_brands(raw)
    if not brands:
        return False
    if any(brand in _RENDERABLE_HEIF_BRANDS for brand in brands):
        return False
    return any(brand in _HEIC_BRANDS for brand in brands)


_HEIF_DECODER: Optional[bool] = None


def _register_heif_decoder() -> bool:
    """Teach Pillow to open HEIC, once. False when the decoder is unavailable.

    ``pillow-heif`` is a declared dependency and bundles libheif, so this is
    True in the image and in CI. The guard exists so a stripped environment
    answers with a clear per-file error rather than storing an unreadable
    object.
    """
    global _HEIF_DECODER
    if _HEIF_DECODER is None:
        try:
            from pillow_heif import register_heif_opener

            register_heif_opener()
            _HEIF_DECODER = True
        except Exception:  # pragma: no cover - import/ABI failure
            _HEIF_DECODER = False
    return _HEIF_DECODER


def normalize_upload(raw: bytes, file_name: str) -> tuple[bytes, str, bool]:
    """Storage form for an upload: ``(bytes, extension, converted)``.

    HEIC/HEIF — recognised by extension or by content — becomes a JPEG so the
    stored object is renderable everywhere. Everything else is returned
    untouched (the common path allocates nothing).

    EXIF is carried across the transcode: the capture timestamp + GPS are what
    the photo ingest path (#190) places a batch by, so dropping them here would
    just be a different silent loss.

    Raises ``UnsupportedUpload`` when the bytes are HEIC and no decoder is
    available, or the image cannot be decoded at all.
    """
    ext = Path(file_name or "").suffix.lower()
    if ext not in HEIC_EXTS and not is_unrenderable_heif(raw):
        return raw, ext, False
    label = file_name or "photo"
    if not _register_heif_decoder():
        raise UnsupportedUpload(
            f"{label}: HEIC/HEIF needs a decoder this build does not have — "
            "export the photo as JPEG and attach it again"
        )
    try:
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as image:
            exif = image.info.get("exif")
            rgb = image.convert("RGB")
            out = io.BytesIO()
            rgb.save(
                out,
                format="JPEG",
                quality=_HEIC_JPEG_QUALITY,
                **({"exif": exif} if exif else {}),
            )
    except Exception as exc:
        raise UnsupportedUpload(f"{label}: could not be decoded as an image ({exc})") from exc
    return out.getvalue(), ".jpg", True


def is_valid_media_path(trip: str, file_name: str) -> bool:
    """True when (trip, file) may address a stored object.

    ``trip`` must be a dashed-UUID trip ``$dtId`` (not a slug), ``file_name`` a
    plain name with no separators. Anything else (``..``, encoded slashes,
    control chars, …) is rejected — the route answers 404 for it, never a
    filesystem or bucket lookup outside the trip's namespace.
    """
    if not _TRIP_ID_RE.match(trip):
        return False
    return is_valid_media_name(file_name)


def is_valid_media_name(file_name: str) -> bool:
    """True when ``file_name`` is a safe flat media name (no separators)."""
    if not (1 <= len(file_name) <= _FILE_MAX_LEN):
        return False
    if file_name in (".", ".."):
        return False
    return bool(_FILE_RE.match(file_name))


def canonicalize_media(value: str, trip_id: str) -> str:
    """Turn one media-field value into the canonical public URL.

    Accepts a bare filename (the data model), a legacy ``/media/<slug>/<file>``
    path, or the canonical path itself; returns ``/media/<trip_id>/<file>``.
    Non-media values (external http(s) URLs, plain strings) pass through
    untouched, so the walker is safe to run over whole documents.
    """
    if not value or "://" in value:
        return value
    file_part: Optional[str] = None
    if value.startswith("/media/"):
        rest = value[len("/media/") :]
        if "/" in rest:
            _, file_part = rest.split("/", 1)
    elif _BARE_FILE_RE.match(value):
        file_part = value
    if file_part is None or "/" in file_part or file_part in (".", ".."):
        return value  # not a recognizable media reference — leave alone
    return f"/media/{trip_id}/{file_part}"


def resolve_media_urls(doc: dict | list, trip_id: str) -> dict | list:
    """Canonicalize every media reference inside a serialized trip document.

    Mutates and returns ``doc``. Walks the schema's media-bearing locations:
    ``cover`` / ``map`` / ``image`` / ``images`` fields wherever they appear
    (trip, day, feature, feature card, block), plus the ``items`` of a
    ``gallery`` block. Only string values that look like media (bare filename
    or an old ``/media/…`` path) are rewritten — external URLs and content
    strings are left alone. ``trip_id`` is the trip's ``$dtId`` that namespaces
    the URLs.
    """
    if isinstance(doc, dict):
        is_gallery = doc.get("kind") == "gallery"
        for key, value in list(doc.items()):
            if key in ("cover", "map", "image", "photo"):
                if isinstance(value, str):
                    doc[key] = canonicalize_media(value, trip_id)
            elif key == "images" and isinstance(value, list):
                doc[key] = [
                    canonicalize_media(v, trip_id) if isinstance(v, str) else v
                    for v in value
                ]
            elif key == "items" and is_gallery and isinstance(value, list):
                # gallery items are {"url": <bare name>} objects (todo shapes are
                # passed through); canonicalize just the url, leave the rest.
                doc[key] = [
                    {**item, "url": canonicalize_media(item["url"], trip_id)}
                    if isinstance(item, dict) and isinstance(item.get("url"), str)
                    else canonicalize_media(item, trip_id) if isinstance(item, str)
                    else item
                    for item in value
                ]
            elif isinstance(value, (dict, list)):
                resolve_media_urls(value, trip_id)
    elif isinstance(doc, list):
        for item in doc:
            if isinstance(item, (dict, list)):
                resolve_media_urls(item, trip_id)
    return doc


class MediaStore(Protocol):
    """A source of trip-media bytes keyed by ``<trip>/<file>``."""

    def get(
        self, key: str, start: Optional[int] = None, length: Optional[int] = None
    ) -> Optional[Iterable[bytes]]:
        """Iterable of raw bytes for ``key``, or None when it does not exist.

        ``start``/``length`` read a WINDOW of the object (#250). That is what
        the media route answers a ``Range`` request with, and it is the whole
        difference between a video that seeks and one that can only ever play
        from the beginning. Callers consume the iterable exactly once;
        implementations may open the underlying resource lazily inside the
        generator.
        """
        ...

    def stat(self, key: str) -> Optional[int]:
        """Byte size of ``key``, or None when it does not exist.

        Needed before a ranged read: ``Content-Length`` and ``Content-Range``
        are only correct against the real size, and a range past the end has to
        be refused rather than clamped into a silent short read.
        """
        ...

    def put(self, key: str, raw: bytes, content_type: str) -> None:
        """Store ``raw`` bytes at ``key`` (trip-media namespace)."""
        ...

    def put_file(self, key: str, path: Path, content_type: str) -> None:
        """Store the file at ``path`` as ``key``, without reading it into memory.

        The upload path for anything large (#250): a video is streamed from the
        spool file into the store (multipart, one part at a time) instead of
        being materialized as a single bytes object in the API process.
        """
        ...

    def copy(self, src: str, dst: str) -> None:
        """Copy ``src`` → ``dst`` in the store, without moving bytes through us.

        Used when a staged inbox upload is promoted into a trip (#250). That
        path used to join every chunk in memory — for a video, the very failure
        the streaming upload exists to avoid. Both stores keep the source's
        content type, and promotion never changes a file's name or extension.
        """
        ...

    def delete(self, key: str) -> None:
        """Delete the object at ``key``; a missing object is a no-op."""
        ...


class LocalMediaStore:
    """Serve media from a directory tree ``<root>/<trip>/<file>``.

    Dev/tests only — the repo no longer ships assets (issue #47), so this
    store only lights up when the directory actually exists (old checkout) or
    a test fixture points ASSETS_DIR at a tmp tree.
    """

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def _target(self, key: str) -> Path:
        """Resolved path for ``key``; raises when it escapes the store root."""
        target = (self.root / key).resolve()
        if self.root not in target.parents:
            raise ValueError(f"Media key escapes the store root: {key!r}")
        return target

    def get(
        self, key: str, start: Optional[int] = None, length: Optional[int] = None
    ) -> Optional[Iterable[bytes]]:
        try:
            path = self._target(key)
        except ValueError:
            return None  # an escaping key addresses nothing, as before
        if not path.is_file():
            return None

        def _chunks() -> Iterable[bytes]:
            remaining = length
            with path.open("rb") as fh:
                if start:
                    fh.seek(start)
                while remaining is None or remaining > 0:
                    chunk = fh.read(_CHUNK if remaining is None else min(_CHUNK, remaining))
                    if not chunk:
                        break
                    if remaining is not None:
                        remaining -= len(chunk)
                    yield chunk

        return _chunks()

    def stat(self, key: str) -> Optional[int]:
        try:
            path = self._target(key)
        except ValueError:
            return None
        return path.stat().st_size if path.is_file() else None

    def put(self, key: str, raw: bytes, content_type: str) -> None:
        target = self._target(key)
        # No traversal: the resolved path must stay under the store root.
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)

    def put_file(self, key: str, path: Path, content_type: str) -> None:
        from shutil import copyfile

        target = self._target(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        copyfile(path, target)

    def copy(self, src: str, dst: str) -> None:
        from shutil import copyfile

        target = self._target(dst)
        target.parent.mkdir(parents=True, exist_ok=True)
        copyfile(self._target(src), target)

    def delete(self, key: str) -> None:
        target = self._target(key)
        try:
            target.unlink()
        except FileNotFoundError:
            pass  # already gone — delete is idempotent


class S3MediaStore:
    """Stream objects from the S3-compatible Garage bucket (production)."""

    def __init__(
        self,
        endpoint: str,
        bucket: str,
        access_key: str,
        secret_key: str,
        region: str = "us-east-1",
    ) -> None:
        # minio wants a bare host[:port]; the scheme decides TLS. Keep the
        # endpoint config human-friendly (http://… / https://…) and strip it.
        from minio import Minio

        secure = endpoint.lower().startswith("https://")
        host = re.sub(r"^[a-z]+://", "", endpoint).rstrip("/")
        self.bucket = bucket
        self._client = Minio(
            host,
            access_key=access_key,
            secret_key=secret_key,
            region=region,
            secure=secure,
        )

    def get(
        self, key: str, start: Optional[int] = None, length: Optional[int] = None
    ) -> Optional[Iterable[bytes]]:
        from minio.error import S3Error

        window = {}
        if start is not None:
            window["offset"] = start
        if length is not None:
            window["length"] = length
        try:
            resp = self._client.get_object(self.bucket, KEY_PREFIX + key, **window)
        except S3Error as exc:
            # 404 (NoSuchKey / NoSuchBucket) → None; any other S3 failure
            # propagates so the app 500s loudly instead of silently serving
            # nothing (same no-silent-fallback stance as the trip store).
            if exc.code in ("NoSuchKey", "NoSuchBucket", "NotFound"):
                return None
            raise

        def _chunks() -> Iterable[bytes]:
            try:
                for chunk in resp.stream(_CHUNK):
                    yield chunk
            finally:
                resp.release_conn()

        return _chunks()

    def stat(self, key: str) -> Optional[int]:
        from minio.error import S3Error

        try:
            return self._client.stat_object(self.bucket, KEY_PREFIX + key).size
        except S3Error as exc:
            if exc.code in ("NoSuchKey", "NoSuchBucket", "NotFound"):
                return None
            raise

    def put(self, key: str, raw: bytes, content_type: str) -> None:
        from io import BytesIO

        self._client.put_object(
            self.bucket,
            KEY_PREFIX + key,
            data=BytesIO(raw),
            length=len(raw),
            content_type=content_type,
        )

    def put_file(self, key: str, path: Path, content_type: str) -> None:
        # minio reads the file from disk and switches to multipart on its own,
        # so a 1 GB video never lands in this process's memory.
        self._client.fput_object(
            self.bucket,
            KEY_PREFIX + key,
            str(path),
            content_type=content_type,
        )

    def copy(self, src: str, dst: str) -> None:
        from minio.commonconfig import CopySource

        self._client.copy_object(
            self.bucket,
            KEY_PREFIX + dst,
            CopySource(self.bucket, KEY_PREFIX + src),
        )

    def delete(self, key: str) -> None:
        from minio.error import S3Error

        try:
            self._client.remove_object(self.bucket, KEY_PREFIX + key)
        except S3Error as exc:
            # 404 (NoSuchKey / NoSuchBucket / NotFound) → already gone.
            if exc.code in ("NoSuchKey", "NoSuchBucket", "NotFound"):
                return
            raise


_STORE: Optional[MediaStore] = None
_STORE_READY = False


def get_media_store() -> Optional[MediaStore]:
    """The process-wide media store, chosen by config.

    S3 when fully configured; local assets dir when present (dev/legacy);
    None otherwise (route 404s — no bucket, no baked assets). Config is read
    at call time so tests can monkeypatch ``config`` module attributes.
    """
    global _STORE, _STORE_READY
    if _STORE_READY:
        return _STORE
    _STORE_READY = True

    s3 = (
        config.KISEKI_S3_ENDPOINT
        and config.KISEKI_S3_BUCKET
        and config.KISEKI_S3_ACCESS_KEY
        and config.KISEKI_S3_SECRET_KEY
    )
    if s3:
        _STORE = S3MediaStore(
            config.KISEKI_S3_ENDPOINT,
            config.KISEKI_S3_BUCKET,
            config.KISEKI_S3_ACCESS_KEY,
            config.KISEKI_S3_SECRET_KEY,
            config.KISEKI_S3_REGION,
        )
    elif config.ASSETS_DIR.is_dir():
        _STORE = LocalMediaStore(config.ASSETS_DIR)
    else:
        _STORE = None
    return _STORE


def clear_media_store() -> None:
    """Drop the cached store (tests switch backend by monkeypatching config)."""
    global _STORE, _STORE_READY
    _STORE = None
    _STORE_READY = False


def object_key_for(trip: str, file_name: str) -> str:
    """Logical store key for a URL path — ``<trip>/<file>`` (no media/ prefix)."""
    return f"{trip}/{file_name}"


# Re-exported for scripts/tests that compute content-addressed keys.
KEY_CHARS = 32


def content_addressed_key(raw: bytes, ext: str) -> str:
    """Unguessable, deterministic key for a media file: sha256[:32] + ext."""
    import hashlib

    return key_from_digest(hashlib.sha256(raw).hexdigest(), ext)


def key_from_digest(digest: str, ext: str) -> str:
    """Same key, from a digest already computed while streaming an upload.

    The streaming upload path (#250) digests as it spools, so the name is known
    without holding the bytes — which is the point for a video.
    """
    return f"{digest[:KEY_CHARS]}{ext.lower()}"
