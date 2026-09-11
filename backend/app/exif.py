"""EXIF capture metadata for photo ingest (issue #190).

A photo that arrives without a date cannot be filed, so the upload path
reads the capture timestamp (and GPS, when present) straight from the
bytes with Pillow:

- ``DateTimeOriginal`` (0x9003) + ``OffsetTimeOriginal`` (0x9010);
  fallback ``DateTimeDigitized``/CreateDate (0x9004), then Image ``DateTime``
  (0x0132) — the tags phone cameras and WhatsApp survivors actually carry.
- GPS ``GPSInfo`` IFD (0x8825) → decimal ``lat``/``lng``.

The contract is honest, never crashing: anything unreadable (non-image
bytes, stripped metadata — screenshots and re-sent WhatsApp images are the
normal undated case) returns ``has_exif: False`` with every field None.
Callers (propose/confirm) treat a missing ``taken_at`` as undated — never
a guess.

``taken_at`` is ISO-8601: aware (``…+HH:MM``) when the file carries an
offset, otherwise naive wall time (``YYYY-MM-DDTHH:MM:SS``) — the propose
step interprets naive wall time as trip-local (the camera was set to local
time) and converts aware timestamps into the trip's timezone (#42).
"""

from __future__ import annotations

import datetime as _dt
import io
import re
from typing import Any, Optional

# EXIF tag ids (ExifTags names in comments — ids are stable, names are not
# imported so a Pillow upgrade cannot break the lookup).
_TAG_DATETIME_ORIGINAL = 0x9003  # DateTimeOriginal
_TAG_OFFSET_ORIGINAL = 0x9010  # OffsetTimeOriginal
_TAG_DATETIME_DIGITIZED = 0x9004  # DateTimeDigitized (exiftool "CreateDate")
_TAG_DATETIME_IMAGE = 0x0132  # DateTime (file-level fallback)
_TAG_GPS_INFO = 0x8825  # GPSInfo IFD

_EXIF_DATETIME_RE = re.compile(r"^(\d{4}):(\d{2}):(\d{2})[ ](\d{2}):(\d{2}):(\d{2})")
_OFFSET_RE = re.compile(r"^([+-])(\d{2}):?(\d{2})(?::?\d{2})?$")


def _parse_exif_datetime(value: Any) -> Optional[_dt.datetime]:
    """``YYYY:MM:DD HH:MM:SS`` → naive datetime; None when unparseable."""
    if not isinstance(value, str):
        return None
    m = _EXIF_DATETIME_RE.match(value.strip())
    if not m:
        return None
    try:
        return _dt.datetime(*map(int, m.groups()))
    except ValueError:
        return None


def _parse_offset(value: Any) -> Optional[_dt.timezone]:
    """``+HH:MM`` → timezone; None when absent/unparseable."""
    if not isinstance(value, str):
        return None
    m = _OFFSET_RE.match(value.strip())
    if not m:
        return None
    sign, hh, mm = m.group(1), int(m.group(2)), int(m.group(3))
    delta = _dt.timedelta(hours=hh, minutes=mm)
    return _dt.timezone(-delta if sign == "-" else delta)


def _rational(value: Any) -> Optional[float]:
    """One EXIF rational (IFDRational, (num, den), or plain number) → float."""
    try:
        if isinstance(value, (tuple, list)) and len(value) == 2:
            num, den = value
            return float(num) / float(den) if float(den) else None
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _gps_to_degrees(values: Any, ref: Any) -> Optional[float]:
    """GPS ``((d,1),(m,1),(s,1))`` + ``N/S/E/W`` ref → signed decimal degrees."""
    if not isinstance(values, (tuple, list)) or len(values) != 3:
        return None
    parts = [_rational(v) for v in values]
    if any(p is None for p in parts):
        return None
    deg = parts[0] + parts[1] / 60.0 + parts[2] / 3600.0  # type: ignore[operator]
    if isinstance(ref, str) and ref.strip().upper() in ("S", "W"):
        deg = -deg
    return deg


def extract_exif(raw: bytes) -> dict[str, Any]:
    """Capture metadata from image bytes (never raises on bad input)."""
    empty: dict[str, Any] = {
        "taken_at": None,
        "offset": None,
        "lat": None,
        "lng": None,
        "has_exif": False,
    }
    try:
        from PIL import Image
    except ImportError:
        return empty
    try:
        with Image.open(io.BytesIO(raw)) as img:
            exif = img.getexif()
    except Exception:
        return empty
    if not exif:
        return empty

    taken: Optional[_dt.datetime] = None
    for tag in (_TAG_DATETIME_ORIGINAL, _TAG_DATETIME_DIGITIZED, _TAG_DATETIME_IMAGE):
        taken = _parse_exif_datetime(exif.get(tag))
        if taken is not None:
            break
    if taken is None:
        return empty

    offset_raw = exif.get(_TAG_OFFSET_ORIGINAL)
    tz = _parse_offset(offset_raw)
    offset: Optional[str] = None
    if tz is not None:
        taken = taken.replace(tzinfo=tz)
        offset = offset_raw.strip() if isinstance(offset_raw, str) else None

    lat = lng = None
    try:
        gps = exif.get_ifd(_TAG_GPS_INFO)
    except Exception:
        gps = {}
    if gps:
        lat = _gps_to_degrees(gps.get(0x0002), gps.get(0x0001))
        lng = _gps_to_degrees(gps.get(0x0004), gps.get(0x0003))

    return {
        "taken_at": taken.isoformat(),
        "offset": offset,
        "lat": lat,
        "lng": lng,
        "has_exif": True,
    }
