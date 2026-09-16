"""Recorded-track parsing for activity blocks (issues #279 / #193).

A shared/completed activity arrives as a GPX file exported from Slopes,
Strava, AllTrails, Komoot or Garmin — small XML, parsed here with STDLIB ONLY
(``xml.etree``; no new dependency per AGENTS.md). The parse produces the
polyline the day's map draws plus the summary the track card reads
(distance / time / ascent).

XXE safety: ``xml.etree.ElementTree.fromstring`` does NOT resolve external
entities or expand arbitrary entity graphs the way a validating parser does —
no DTD processing, no network fetch — so an untrusted GPX cannot exfiltrate
or loop here. Defense in depth on top: a size cap (the document family's
upload cap already bounds this) and a point cap with deterministic decimation
for the payload the map draws.

``.fit`` is deliberately NOT parsed: it needs a new binary runtime dependency
and AGENTS.md says ask before adding one. Slopes exports GPX too, so GPX
unblocks the need. A ``.fit`` upload is refused in ``media.require_upload_kind``
with guidance to export GPX instead.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional
from xml.etree import ElementTree as ET

# Namespaces GPX 1.0 / 1.1 use. A track file without any namespace (hand-rolled
# exporters do this) is accepted too — matching is done on the LOCAL name.
_GPX10_NS = "http://www.topografix.com/GPX/1/0"
_GPX11_NS = "http://www.topografix.com/GPX/1/1"

# Upper bound on points in one parsed track. A phone-recorded day is a few
# thousand points; beyond this the map draws a decimated subset (every n-th
# point, endpoints kept) so the payload stays small and the line identical.
MAX_POINTS = 5000

# Payload bound for the line the map draws: the response carries at most this
# many coordinates (endpoints always kept). A full-fidelity copy is never
# needed — a 4px body at trip zoom cannot resolve more.
RESPONSE_MAX_POINTS = 2000

# Refuse to parse beyond this many bytes even if the caller forgot the cap.
MAX_BYTES = 8 * 1024 * 1024


class GpxError(ValueError):
    """A GPX file that cannot become a track — the route turns this into a
    per-file 422 naming the file (the #251 contract: never accept-and-drop)."""


@dataclass
class GpxPoint:
    lat: float
    lng: float
    ele: Optional[float] = None
    time: Optional[str] = None


@dataclass
class GpxTrack:
    """A parsed track: the polyline + its summary."""

    points: list[GpxPoint] = field(default_factory=list)
    distance_m: float = 0.0
    ascent_m: float = 0.0
    start_time: Optional[str] = None
    end_time: Optional[str] = None

    @property
    def point_count(self) -> int:
        return len(self.points)

    @property
    def duration_s(self) -> Optional[int]:
        """Recorded wall-clock seconds, when both ends carry a timestamp."""
        if not (self.start_time and self.end_time):
            return None
        try:
            import datetime as _dt

            start = _dt.datetime.fromisoformat(self.start_time.replace("Z", "+00:00"))
            end = _dt.datetime.fromisoformat(self.end_time.replace("Z", "+00:00"))
            delta = (end - start).total_seconds()
            return int(delta) if delta >= 0 else None
        except ValueError:
            return None

    def coordinates(self, limit: int = RESPONSE_MAX_POINTS) -> list[list[float]]:
        """``[[lng, lat], …]`` GeoJSON positions, decimated to ``limit``."""
        pts = self.points
        if len(pts) > limit and limit >= 2:
            step = (len(pts) - 1) / (limit - 1)
            idx = {round(i * step) for i in range(limit)}
            idx.add(len(pts) - 1)
            pts = [p for i, p in enumerate(self.points) if i in idx]
        return [[p.lng, p.lat] for p in pts]

    def to_feature(self) -> dict:
        """GeoJSON Feature the day map draws + the card reads."""
        return {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": self.coordinates()},
            "properties": {
                "distanceM": round(self.distance_m, 1),
                "ascentM": round(self.ascent_m, 1),
                "startTime": self.start_time,
                "endTime": self.end_time,
                "durationS": self.duration_s,
                "pointCount": self.point_count,
            },
        }


def _local(tag: str) -> str:
    """Strip any ``{namespace}`` prefix — GPX 1.0, 1.1 or no namespace."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _haversine_m(a: GpxPoint, b: GpxPoint) -> float:
    """Great-circle metres between two points (WGS84 mean radius)."""
    r = 6371000.0
    d_lat = math.radians(b.lat - a.lat)
    d_lng = math.radians(b.lng - a.lng)
    s = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(a.lat))
        * math.cos(math.radians(b.lat))
        * math.sin(d_lng / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(s)))


def parse_gpx(raw: bytes, label: str) -> GpxTrack:
    """Parse GPX bytes into a track (polyline + summary).

    Reads every ``trkseg/trkpt`` in document order (multi-segment recordings
    concatenate — a paused watch writes several segments of one activity).
    Falls back to ``rtept``/``wpt`` when a file carries a planned route but no
    recorded track points, so an exported route still draws.

    Raises ``GpxError`` naming the file when the bytes are not XML, not GPX,
    or carry no usable points.
    """
    if len(raw) > MAX_BYTES:
        raise GpxError(f"{label}: GPX larger than {MAX_BYTES // (1024 * 1024)} MB is not a track")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise GpxError(f"{label}: not a readable GPX file ({exc})") from exc
    if _local(root.tag) != "gpx":
        raise GpxError(f"{label}: not a GPX file (root is <{_local(root.tag)}>)")

    points: list[GpxPoint] = []
    # Recorded track points first (the #193 shape of the day).
    for trkpt in root.iter():
        if _local(trkpt.tag) != "trkpt":
            continue
        try:
            lat = float(trkpt.get("lat", ""))
            lng = float(trkpt.get("lon", ""))
        except (TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue
        ele: Optional[float] = None
        time: Optional[str] = None
        for child in trkpt:
            name = _local(child.tag)
            if name == "ele" and ele is None:
                try:
                    ele = float((child.text or "").strip())
                except ValueError:
                    ele = None
            elif name == "time" and time is None and (child.text or "").strip():
                time = (child.text or "").strip()
        points.append(GpxPoint(lat=lat, lng=lng, ele=ele, time=time))
        if len(points) > MAX_POINTS:
            # Deterministic decimation while scanning: keep every other point
            # so an unbounded file cannot grow the list without bound.
            points = points[::2]

    # Planned-route fallback: rtept/wpt when no recorded points exist.
    if not points:
        for tag in ("rtept", "wpt"):
            for el in root.iter():
                if _local(el.tag) != tag:
                    continue
                try:
                    lat = float(el.get("lat", ""))
                    lng = float(el.get("lon", ""))
                except (TypeError, ValueError):
                    continue
                if -90 <= lat <= 90 and -180 <= lng <= 180:
                    points.append(GpxPoint(lat=lat, lng=lng))
            if points:
                break

    if not points:
        raise GpxError(f"{label}: no track points found (no trkpt/rtept/wpt with coordinates)")

    distance = sum(_haversine_m(a, b) for a, b in zip(points, points[1:]))
    ascent = 0.0
    for a, b in zip(points, points[1:]):
        if a.ele is not None and b.ele is not None and b.ele > a.ele:
            ascent += b.ele - a.ele
    times = [p.time for p in points if p.time]
    return GpxTrack(
        points=points,
        distance_m=distance,
        ascent_m=ascent,
        start_time=times[0] if times else None,
        end_time=times[-1] if times else None,
    )
