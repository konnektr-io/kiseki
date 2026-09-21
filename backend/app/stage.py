"""Derived trip stage — the calendar's vote on what a trip is (issue #362).

``stage`` on the Trip twin is authorial intent: it changes only through an
explicit owner/editor write. ``effective_stage()`` is the read-path
derivation layered on top: a trip whose stored stage is ``planned``/``booked``
and whose *trip-local* today falls inside ``[startDate, endDate]`` reads as
``live`` without any write having happened.

One rule, no per-trip knob (defaults ON):

- ``archive`` is terminal — never derived away from, never derived into.
  Freezing a trip (and its final booklet) stays a deliberate manual act.
- ``idea`` / ``options`` / ``shortlist`` never auto-live: a half-baked plan
  that happens to carry dates must not present as happening now.
- Undated trips never auto-live.
- Past the end date the trip reads as its stored stage — auto-archive would
  freeze behind the owner's back (see the ``archive`` rule above).
- "Today" is the trip's own calendar date (the ``timezone`` IANA field),
  falling back to UTC when the field is absent or invalid — the same rule
  the frontend's ``tripTodayIso()`` applies (``frontend/src/lib/dates.ts``).

``effectiveStage`` is a read-path value only: it is injected at
serialization (``main._public_trip``) and list mappings, never persisted to
the twin and never part of the DTDL model — so this module touches no
migration, no query shape, and no write path.
"""

from __future__ import annotations

import datetime as _dt
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import time as _clock

# Stored stages the calendar is allowed to promote. Everything else reads
# exactly as stored — the ladder below is documentation, not logic.
_AUTO_LIVE_FROM = ("planned", "booked")


def trip_local_today(
    tz: str | None,
    now: _dt.datetime | None = None,
) -> str:
    """Trip-local "today" as ``YYYY-MM-DD``.

    ``now`` is an injectable aware-or-naive UTC instant (tests); when omitted
    the clock seam (``app.time.utcnow``, monkeypatchable) is the source.
    An absent, blank, or invalid ``tz`` falls back to UTC — never raises,
    because a home/list read must not 500 on a typo'd timezone.
    """
    instant = now
    if instant is None:
        instant = _clock.utcnow().replace(tzinfo=_dt.timezone.utc)
    elif instant.tzinfo is None:
        instant = instant.replace(tzinfo=_dt.timezone.utc)
    zone_name = (tz or "").strip()
    if zone_name:
        try:
            return instant.astimezone(ZoneInfo(zone_name)).date().isoformat()
        except (ZoneInfoNotFoundError, ValueError, OSError):
            pass
    return instant.date().isoformat()


def effective_stage(
    stored: str | None,
    start: str | None,
    end: str | None,
    tz: str | None = None,
    today: str | None = None,
) -> str:
    """The stage a trip reads as: stored intent, possibly promoted to live.

    ``today`` is an injectable trip-local ``YYYY-MM-DD`` (tests / sweeps);
    when omitted it is resolved via :func:`trip_local_today`. ISO ``YYYY-MM-DD``
    strings compare lexicographically, so no date parsing is needed — and a
    malformed date simply never matches, failing closed to the stored stage.
    """
    current = stored or "idea"
    if current not in _AUTO_LIVE_FROM:
        return current
    if not start or not end:
        return current
    day = today if today is not None else trip_local_today(tz)
    if start <= day <= end:
        return "live"
    return current
