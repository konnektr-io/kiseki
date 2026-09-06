"""A very small in-process rate limiter for the map proxies (#27).

Once routing credentials live only on the backend, `/api/maps/*` IS the key:
anyone holding a share link could otherwise pump our routing quota. Every
map endpoint is already scoped to a valid trip token; this bounds how hard a
holder of one can hit it.

Deliberately dependency-free and in-process — the limit is per pod, not per
cluster, so with N replicas the effective ceiling is N x `limit`. That is fine
for a bound whose job is to stop abuse, not to meter fairly. If this ever needs
to be exact, move it to Redis rather than growing this module.
"""

from __future__ import annotations

import threading
import time

_lock = threading.Lock()
_hits: dict[tuple[str, str], list[float]] = {}

# Keep the table from growing without bound when many distinct clients appear.
_MAX_KEYS = 10_000


def allow(bucket: str, client: str, *, limit: int, window: float = 60.0) -> bool:
    """True if `client` may make another `bucket` request inside `window` seconds.

    A sliding window over recent timestamps: precise enough at these volumes and
    it avoids the burst-at-the-boundary hole a fixed window has.
    """
    key = (bucket, client)
    now = time.monotonic()
    cutoff = now - window
    with _lock:
        if len(_hits) > _MAX_KEYS:
            # Cheap amnesty rather than an LRU — the alternative is unbounded
            # memory, and the worst case is one free window for everyone.
            _hits.clear()
        recent = [t for t in _hits.get(key, ()) if t > cutoff]
        if len(recent) >= limit:
            _hits[key] = recent
            return False
        recent.append(now)
        _hits[key] = recent
        return True


def reset() -> None:
    """Drop all counters (tests)."""
    with _lock:
        _hits.clear()
