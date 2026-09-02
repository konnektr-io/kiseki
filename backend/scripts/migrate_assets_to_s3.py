#!/usr/bin/env python3
"""Trip media pipeline — Garage S3, namespaced by trip $dtId (issue #47).

Media never lives in the repo/image. Data (trip.json, and the graph twins
seeded from it) stores BARE FILENAMES in media fields — the API canonicalizes
them to `/media/<trip_id>/<file>` at serialization time (app/media.py), where
``trip_id`` is the trip's opaque ``$dtId`` (``trip.json`` → ``id``). The
repo-folder slug is NOT a media namespace (organizational; can collide).

Object layout in the bucket: ``media/<trip_id>/<sha256[:32]>.<ext>``.

Modes (run from ``backend/`` with KISEKI_S3_* env set — see AGENTS.md):
  * default: upload new/updated images for a trip and canonicalize its
    trip.json media fields (bare filenames). Scratch dir for new images:
    ``backend/data/assets/<slug>/`` (gitignored; slug is just the local folder).
    Media fields may hold a human filename ("sths-hero-full.jpg") while the
    image is being added — this run uploads the file and rewrites the field to
    its content-addressed key. Idempotent: same bytes → same key.
  * --rekey-to-id: one-time migration of the OLD slug-namespaced bucket layout
    (``media/<slug>/<file>``) to ``media/<trip_id>/<file>`` (S3-side copy, old
    keys KEPT until you purge) + rewrite trip.json media refs to bare names.
  * --purge-slug-keys: delete the leftover ``media/<slug>/…`` objects (run only
    after the new layout is verified live).
  * --dry-run on any mode prints what would change without writing.

Env (mirrors config.py): KISEKI_S3_ENDPOINT/_BUCKET/_ACCESS_KEY/_SECRET_KEY
(/_REGION). TRIPS_DIR / ASSETS_DIR default to the repo paths.
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
from app.media import KEY_PREFIX, content_addressed_key, media_content_type  # noqa: E402

# Media-bearing JSON locations (mirrors app/media.py resolve_media_urls).
_MEDIA_KEYS = {"cover", "map", "image", "images"}


def _require_s3() -> None:
    if not (
        config.KISEKI_S3_ENDPOINT
        and config.KISEKI_S3_BUCKET
        and config.KISEKI_S3_ACCESS_KEY
        and config.KISEKI_S3_SECRET_KEY
    ):
        raise SystemExit(
            "[migrate] KISEKI_S3_* env vars are required. Set them from the\n"
            "      `garage-s3-key` k8s Secret (ns garage) — never commit them."
        )


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


def _copy_object(client, bucket: str, src: str, dst: str) -> None:
    """S3-side copy — minio 7.2 requires a CopySource wrapper (minio.api)."""
    from minio.api import CopySource

    client.copy_object(bucket, dst, CopySource(bucket, src))


def _bare_name(value: str) -> str:
    """Strip any /media/<segment>/ prefix → bare filename (else value as-is)."""
    if isinstance(value, str) and value.startswith("/media/"):
        rest = value[len("/media/") :]
        if "/" in rest:
            return rest.split("/", 1)[1]
    return value


def _strip_to_bare(obj) -> int:
    """Rewrite media fields in place to bare filenames; return change count.

    Walk is schema-aware like app/media.resolve_media_urls: cover/map/image/
    images fields anywhere, plus gallery-block items. Non-string or non-media
    values are untouched.
    """
    count = 0
    if isinstance(obj, dict):
        is_gallery = obj.get("kind") == "gallery"
        for key, value in list(obj.items()):
            if key in ("cover", "map", "image") and isinstance(value, str):
                bare = _bare_name(value)
                if bare != value:
                    obj[key] = bare
                    count += 1
            elif key == "images" and isinstance(value, list):
                for i, v in enumerate(value):
                    if isinstance(v, str):
                        bare = _bare_name(v)
                        if bare != v:
                            value[i] = bare
                            count += 1
            elif key == "items" and is_gallery and isinstance(value, list):
                for i, v in enumerate(value):
                    if isinstance(v, str):
                        bare = _bare_name(v)
                        if bare != v:
                            value[i] = bare
                            count += 1
            elif isinstance(value, (dict, list)):
                count += _strip_to_bare(value)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                count += _strip_to_bare(item)
    return count


def _replace_asset_names(obj, mapping: dict[str, str]) -> int:
    """Replace media-field values equal to a scratch asset's human name with
    its content-addressed key (the add/update-images step)."""
    count = 0
    if isinstance(obj, dict):
        is_gallery = obj.get("kind") == "gallery"
        for key, value in list(obj.items()):
            if key in ("cover", "map", "image") and isinstance(value, str):
                if value in mapping:
                    obj[key] = mapping[value]
                    count += 1
            elif key == "images" and isinstance(value, list):
                for i, v in enumerate(value):
                    if isinstance(v, str) and v in mapping:
                        value[i] = mapping[v]
                        count += 1
            elif key == "items" and is_gallery and isinstance(value, list):
                for i, v in enumerate(value):
                    if isinstance(v, str) and v in mapping:
                        value[i] = mapping[v]
                        count += 1
            elif isinstance(value, (dict, list)):
                count += _replace_asset_names(value, mapping)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                count += _replace_asset_names(item, mapping)
    return count


def _trip_doc(slug: str) -> dict:
    p = config.TRIPS_DIR / slug / "trip.json"
    if not p.is_file():
        raise SystemExit(f"[migrate] trip.json not found: {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def _write_trip(slug: str, doc: dict) -> None:
    p = config.TRIPS_DIR / slug / "trip.json"
    p.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def upload_trip_assets(slug: str, dry_run: bool) -> int:
    """Default mode — upload scratch assets under media/<trip_id>/ + rewrite."""
    assets = Path(config.ASSETS_DIR) / slug
    if not assets.is_dir():
        print(f"[migrate] {slug}: no scratch assets dir ({assets}) — skipping")
        return 0
    doc = _trip_doc(slug)
    trip_id = doc["id"]

    mapping: dict[str, str] = {}
    client = None if dry_run else _s3_client()
    files = sorted(p for p in assets.iterdir() if p.is_file())
    for asset in files:
        raw = asset.read_bytes()
        fname = content_addressed_key(raw, asset.suffix.lower())
        mapping[asset.name] = fname
        if dry_run:
            print(f"[migrate] {slug}: would upload {asset.name} → media/{trip_id}/{fname}")
            continue
        client.put_object(  # type: ignore[union-attr] — dry_run continues above
            config.KISEKI_S3_BUCKET,
            f"{KEY_PREFIX}{trip_id}/{fname}",
            data=BytesIO(raw),
            length=len(raw),
            content_type=media_content_type(fname),
        )
        print(f"[migrate] {slug}: uploaded {asset.name} → media/{trip_id}/{fname}")

    stripped = _strip_to_bare(doc)
    replaced = _replace_asset_names(doc, mapping)
    if dry_run:
        print(
            f"[migrate] {slug}: DRY-RUN — would rewrite trip.json "
            f"(strip {stripped}, map {replaced})"
        )
        return len(mapping)
    _write_trip(slug, doc)
    print(f"[migrate] {slug}: rewrote trip.json (strip {stripped}, map {replaced})")
    return len(mapping)


def rekey_to_id(slug: str, dry_run: bool) -> int:
    """One-time bucket + data migration: media/<slug>/… → media/<trip_id>/…."""
    doc = _trip_doc(slug)
    trip_id = doc["id"]
    client = _s3_client()  # listing is read-only; copies gated on dry_run below
    moved = 0
    for obj in client.list_objects(config.KISEKI_S3_BUCKET, prefix=f"{KEY_PREFIX}{slug}/", recursive=True):
        name = obj.object_name.rsplit("/", 1)[-1]
        dest = f"{KEY_PREFIX}{trip_id}/{name}"
        if dry_run:
            print(f"[rekey] {slug}: would copy {obj.object_name} → {dest}")
        else:
            _copy_object(client, config.KISEKI_S3_BUCKET, obj.object_name, dest)
            print(f"[rekey] {slug}: copied {obj.object_name} → {dest}")
        moved += 1
    stripped = _strip_to_bare(doc)
    if dry_run:
        print(f"[rekey] {slug}: DRY-RUN — would rewrite trip.json (strip {stripped})")
        return moved
    _write_trip(slug, doc)
    print(f"[rekey] {slug}: rewrote trip.json (strip {stripped}); old slug keys KEPT until --purge-slug-keys")
    return moved


def purge_slug_keys(dry_run: bool) -> int:
    client = _s3_client()
    removed = 0
    slugs = sorted(d.name for d in config.TRIPS_DIR.iterdir() if (d / "trip.json").is_file())
    for slug in slugs:
        doc = _trip_doc(slug)
        trip_id = doc["id"]
        if trip_id == slug:
            continue
        for obj in client.list_objects(config.KISEKI_S3_BUCKET, prefix=f"{KEY_PREFIX}{slug}/", recursive=True):
            if dry_run:
                print(f"[purge] would delete {obj.object_name}")
            else:
                client.remove_object(config.KISEKI_S3_BUCKET, obj.object_name)
                print(f"[purge] deleted {obj.object_name}")
            removed += 1
    return removed


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
    ap.add_argument("--rekey-to-id", action="store_true", help="migrate media/<slug>/ → media/<trip_id>/ + rewrite data")
    ap.add_argument("--purge-slug-keys", action="store_true", help="delete leftover media/<slug>/ objects (after switchover)")
    args = ap.parse_args()

    slugs = [args.trip_slug] if args.trip_slug else discover_slugs()
    total = 0
    _require_s3()  # every mode talks to the bucket
    if args.purge_slug_keys:
        total = purge_slug_keys(args.dry_run)
        print(f"[purge] done — {total} slug-keyed objects deleted" + (" (dry-run)" if args.dry_run else ""))
        return
    _require_s3()
    for slug in slugs:
        total += (rekey_to_id(slug, args.dry_run) if args.rekey_to_id else upload_trip_assets(slug, args.dry_run))
    verb = "rekeyed" if args.rekey_to_id else "uploaded"
    print(f"[migrate] done — {verb} {total} object(s) across {len(slugs)} trip(s)")


if __name__ == "__main__":
    main()
