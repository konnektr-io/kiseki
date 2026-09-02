"""Trip media storage (issue #47) — Garage object storage with a local fallback.

Media moved OUT of the repo into the S3-compatible Garage bucket (private,
never exposed). The app keeps serving it under the same public path it always
had — ``GET /media/<trip>/<file>`` — so ``trip.json``, the graph twins, the
frontend and the PDF renderer never care where the bytes live. This module is
the seam that hides the backend:

* **S3MediaStore** (production): streams objects from the Garage bucket.
  Bucket layout: ``media/<trip>/<file>`` (a ``media/`` prefix keeps the bucket
  unambiguous next to future non-trip uses such as CNPG backups). Enabled when
  every ``KISEKI_S3_*`` env var is set (see config.py).
* **LocalMediaStore** (dev / tests / legacy checkouts): serves from
  ``backend/data/assets/<trip>/<file>`` when the S3 env is absent and the
  directory exists. Repo assets are gone; this only exists so an old checkout
  or a tmp test fixture can still exercise the route without a bucket.

Privacy (decision recorded on #47): object keys are UNGUESSABLE — each file is
stored under ``<32 hex chars of its sha256>.<ext>``, NOT its original filename
— and the bucket itself is private (only this proxy holds credentials), so a
leaked slug-based URL 404s after migration. The proxy is the only reader; a
future crew-level media ACL (#64) enforces at this same seam.

Keys are content-addressed (sha256 prefix), which makes migration idempotent:
re-running the upload for the same bytes writes the same key.
"""

from __future__ import annotations

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
}

# Trip slugs (repo folder names): lowercase words/digits joined by dashes.
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
# Object file part: conservative ASCII whitelist. Covers both the migrated
# 32-hex.<ext> keys and legacy dev filenames. Path separators never match, so
# traversal is rejected structurally (Starlette decodes %2F into the param).
_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_FILE_MAX_LEN = 255

# How many bytes per chunk when proxying an object (local or S3).
_CHUNK = 64 * 1024


def media_content_type(file_name: str) -> str:
    """Content type for a media file, from its extension."""
    return MEDIA_TYPES.get(Path(file_name).suffix.lower(), "application/octet-stream")


def is_valid_media_path(trip: str, file_name: str) -> bool:
    """True when (trip, file) may address a stored object.

    Both parts are whitelisted: ``trip`` is a slug shape, ``file_name`` is a
    plain name with no separators. Anything else (``..``, encoded slashes,
    control chars, …) is rejected — the route answers 404 for it, never a
    filesystem or bucket lookup outside the trip's namespace.
    """
    if not _SLUG_RE.match(trip):
        return False
    if not (1 <= len(file_name) <= _FILE_MAX_LEN):
        return False
    if file_name in (".", ".."):
        return False
    return bool(_FILE_RE.match(file_name))


class MediaStore(Protocol):
    """A source of trip-media bytes keyed by ``<trip>/<file>``."""

    def get(self, key: str) -> Optional[Iterable[bytes]]:
        """Iterable of raw bytes for ``key``, or None when it does not exist.

        Callers consume the iterable exactly once; implementations may open
        the underlying resource lazily inside the generator.
        """
        ...


class LocalMediaStore:
    """Serve media from a directory tree ``<root>/<trip>/<file>``.

    Dev/tests only — the repo no longer ships assets (issue #47), so this
    store only lights up when the directory actually exists (old checkout) or
    a test fixture points ASSETS_DIR at a tmp tree.
    """

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def get(self, key: str) -> Optional[Iterable[bytes]]:
        path = (self.root / key).resolve()
        if self.root not in path.parents or not path.is_file():
            return None

        def _chunks() -> Iterable[bytes]:
            with path.open("rb") as fh:
                while chunk := fh.read(_CHUNK):
                    yield chunk

        return _chunks()


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

    def get(self, key: str) -> Optional[Iterable[bytes]]:
        from minio.error import S3Error

        try:
            resp = self._client.get_object(self.bucket, KEY_PREFIX + key)
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

    digest = hashlib.sha256(raw).hexdigest()[:KEY_CHARS]
    return f"{digest}{ext.lower()}"
