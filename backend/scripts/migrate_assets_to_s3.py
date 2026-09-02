#!/usr/bin/env python3
"""Migrate trip media from the repo's ``backend/data/assets/`` into Garage.

Issue #47 — one-time (but idempotent) migration:

1. Walk every trip under ``TRIPS_DIR`` that still has a matching assets dir.
2. For each asset file, upload it to the Garage bucket under
   ``media/<trip>/<sha256[:32]><ext>`` (content-addressed, unguessable,
   idempotent — same bytes → same key).
3. Rewrite that trip's ``trip.json`` in place: every ``/media/<trip>/<orig>``
   reference is rewritten to ``/media/<trip>/<sha32><ext>`` via a recursive
   walk of the JSON tree so nothing is missed.
4. (Audit only — not needed at runtime.) Write a
   ``backend/data/mocks/<slug>.media-map.json`` recording the old→new mapping.

Re-running is safe: identical bytes produce the same key (Garage ignores
duplicate puts), and a trip.json that is already migrated contains no
old-style URLs, so the rewrite is a no-op.

Env (mirrors config.py + seed_graph.py conventions):
  KISEKI_S3_ENDPOINT / KISEKI_S3_BUCKET / KISEKI_S3_ACCESS_KEY /
  KISEKI_S3_SECRET_KEY / KISEKI_S3_REGION
  TRIPS_DIR / ASSETS_DIR (defaults to the repo paths)
  --dry-run   : print what would change, write nothing
  --trip-slug : limit to one trip
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config  # noqa: E402
from app.media import KEY_CHARS, content_addressed_key, media_content_type, object_key_for  # noqa: E402

_MEDIA_URL_RE = re.compile(r"^(/media/)([^/]+)/(.+)$")


def _is_old_url(url: str, slug: str) -> bool:
    """True if url is an old-style ``/media/<slug>/<orig>`` reference.

    Already-migrated content-addressed keys are 32 hex chars + ext, so they
    are excluded — rewriting an already-migrated trip.json is a no-op.
    """
    m = _MEDIA_URL_RE.match(url)
    if not m:
        return False
    _, u_slug, file_part = m.groups()
    if u_slug != slug:
        return False
    name = Path(file_part).stem
    if len(name) == KEY_CHARS and all(c in "0123456789abcdefABCDEF" for c in name):
        return False
    return True


def _s3_client():
    from minio import Minio

    secure = config.KISEKI_S3_ENDPOINT.lower().startswith("https://")
    host = re.sub(r"^[a-z]+://", "", config.KISEKI_S3_ENDPOINT, flags=re.I).rstrip("/")
    return Minio(
        host,
        access_key=config.KISEKI_S3_ACCESS_KEY,
        secret_key=config.KISEKI_S3_SECRET_KEY,
        region=config.KISEKI_S3_REGION or "us-east-1",
        secure=secure,
    )


def _ensure_bucket(client, bucket: str) -> None:
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)
        print(f"[migrate] created bucket {bucket}")


def _rewrite_value(val: str, slug: str, mapping: dict[str, str]) -> str:
    """Rewrite one old media URL to its content-addressed key, if mapped."""
    m = _MEDIA_URL_RE.match(val)
    if m and m.group(2) == slug:
        old_file = m.group(3)
        if old_file in mapping:
            return f"/media/{slug}/{mapping[old_file]}"
    return val


def _rewrite_urls(obj, slug: str, mapping: dict[str, str]) -> int:
    """Mutate `obj` (dict/list) in place; return count of URLs rewritten."""
    count = 0
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str):
                new = _rewrite_value(v, slug, mapping)
                if new != v:
                    obj[k] = new
                    count += 1
            else:
                count += _rewrite_urls(v, slug, mapping)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                new = _rewrite_value(v, slug, mapping)
                if new != v:
                    obj[i] = new
                    count += 1
            else:
                count += _rewrite_urls(v, slug, mapping)
    return count


def migrate_trip(trip_slug: str, dry_run: bool) -> dict:
    assets = Path(config.ASSETS_DIR) / trip_slug
    trips_file = config.TRIPS_DIR / trip_slug / "trip.json"
    if not trips_file.is_file():
        raise SystemExit(f"[migrate] trip.json not found: {trips_file}")
    if not assets.is_dir():
        print(f"[migrate] {trip_slug}: no assets dir ({assets}) — skipping")
        return {}

    if not (
        config.KISEKI_S3_ENDPOINT
        and config.KISEKI_S3_BUCKET
        and config.KISEKI_S3_ACCESS_KEY
        and config.KISEKI_S3_SECRET_KEY
    ):
        raise SystemExit(
            "[migrate] KISEKI_S3_* env vars are required. Set them from the\n"
            "      `kiseki-s3` k8s Secret (home-k8s) or local .env for dev."
        )

    trip = json.loads(trips_file.read_text(encoding="utf-8"))

    # 1. build old→new filename map
    mapping: dict[str, str] = {}
    client = None if dry_run else _s3_client()
    if client:
        _ensure_bucket(client, config.KISEKI_S3_BUCKET)

    files = sorted(p for p in assets.iterdir() if p.is_file())
    for asset in files:
        raw = asset.read_bytes()
        fname = content_addressed_key(raw, asset.suffix.lower())
        mapping[asset.name] = fname
        if dry_run:
            print(f"[migrate] {trip_slug}: would upload {asset.name} → {fname}")
            continue
        obj_key = object_key_for(trip_slug, fname)
        assert client is not None  # dry-run branch `continue`s above
        client.put_object(
            config.KISEKI_S3_BUCKET,
            f"media/{obj_key}",
            data=BytesIO(raw),
            length=len(raw),
            content_type=media_content_type(fname),
        )
        print(f"[migrate] {trip_slug}: uploaded {asset.name} → media/{obj_key}")

    # 2. rewrite urls inside trip.json (mutates in place; report count)
    rewritten = _rewrite_urls(trip, trip_slug, mapping)

    if dry_run:
        print(f"[migrate] {trip_slug}: DRY-RUN — would write trip.json ({rewritten} URLs rewritten)")
        return mapping

    # 3. write back trip.json + audit map
    mock_dir = config.BACKEND_DIR / "data" / "mocks"
    mock_dir.mkdir(parents=True, exist_ok=True)
    (mock_dir / f"{trip_slug}.media-map.json").write_text(
        json.dumps(mapping, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    trips_file.write_text(
        json.dumps(trip, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"[migrate] {trip_slug}: rewrote trip.json ({rewritten} URLs), wrote media-map")
    return mapping


def discover_slugs() -> list[str]:
    return sorted(
        d.name
        for d in config.TRIPS_DIR.iterdir()
        if d.is_dir() and (d / "trip.json").is_file()
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--trip-slug", help="limit to one trip")
    args = ap.parse_args()

    slugs = [args.trip_slug] if args.trip_slug else discover_slugs()
    total = 0
    for slug in slugs:
        m = migrate_trip(slug, args.dry_run)
        total += len(m)
    print(f"[migrate] done — {total} assets across {len(slugs)} trip(s)")


if __name__ == "__main__":
    main()
