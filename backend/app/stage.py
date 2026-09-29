"""Derived trip stage — the calendar's vote on what a trip is (#362, #396).

``stage`` on the Trip twin is authorial intent: it changes only through an
explicit owner/editor write, or through the ONE write-back ``reconcile_stage``
in this module. ``effective_stage()`` is the read-path derivation layered on
top, and it is symmetric — the calendar can move a trip up into ``live`` and
back down to ``archive``:

- stored ``planned``/``booked`` and trip-local today inside
  ``[startDate, endDate]`` → reads ``live`` (auto-live, #362).
- stored ``live`` and trip-local today past ``endDate`` → reads ``archive``
  (auto-archive, #396).

One rule, no per-trip knob (defaults ON):

- ``archive`` is terminal — never derived away from, never derived into.
  Freezing a trip (and its final booklet) stays a deliberate manual act.
- ``idea`` / ``options`` / ``shortlist`` never auto-live: a half-baked plan
  that happens to carry dates must not present as happening now. They also
  never auto-archive — a passed date on an idea is not a finished trip.
- Undated trips never auto-live and never auto-archive.
- Auto-archive fires only for a trip the calendar actually placed in ``live``:
  that is, a trip whose stored stage is ``live``/``planned``/``booked``. A
  ``live`` trip with a date range entirely in the future stays ``live`` (see
  ``_AUTO_ARCHIVE_FROM``).
- "Today" is the trip's own calendar date (the ``timezone`` IANA field),
  falling back to UTC when the field is absent or invalid — the same rule
  the frontend's ``tripTodayIso()`` applies (``frontend/src/lib/dates.ts``).

``effectiveStage`` is a read-path value: it is injected at serialization
(``main._public_trip``) and list mappings, never part of the DTDL model — so
this module touches no migration and no query shape.

The ONE exception to "read-only" is :func:`reconcile_stage`, the
owner-authorized write-back that persists the derived ``archive`` so a
finished trip's badge, follow-feed entry and stage facet stop reading live.
It is deliberately one-directional (see :func:`reconcile_stage`).
"""

from __future__ import annotations

import datetime as _dt
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import time as _clock

# Stored stages the calendar is allowed to promote. Everything else reads
# exactly as stored — the ladder below is documentation, not logic.
_AUTO_LIVE_FROM = ("planned", "booked")

# Stored stages the calendar is allowed to RETIRE into ``archive`` once the
# trip's own end date has passed. This is the calendar's complement of
# ``_AUTO_LIVE_FROM``: a trip the calendar was willing to call "happening" is
# a trip whose finish is a fact, not an opinion. The early stages are absent
# on purpose — a passed date on an ``idea`` is a stale plan, not a completed
# trip, and archiving it would silently shelve a half-formed itinerary the
# owner is still choosing between.
_AUTO_ARCHIVE_FROM = ("live", "planned", "booked")


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
    """The stage a trip reads as: stored intent, possibly derived both ways.

    Two derivations, in order, and they never fight:

    1. **Auto-archive (#396).** The trip was one the calendar would have
       called live, and its end date has passed trip-local → ``archive``.
       Checked FIRST, because a stored ``planned``/``booked`` trip that ended
       last month would otherwise fall through to "not in range, so read
       stored" and keep presenting as an upcoming plan forever.
    2. **Auto-live (#362).** A stored ``planned``/``booked`` trip in range →
       ``live``.

    ``today`` is an injectable trip-local ``YYYY-MM-DD`` (tests / sweeps);
    when omitted it is resolved via :func:`trip_local_today`. ISO ``YYYY-MM-DD``
    strings compare lexicographically, so no date parsing is needed — and a
    malformed date simply never matches, failing closed to the stored stage.
    """
    current = stored or "idea"
    if not start or not end:
        return current
    if current in ("idea", "options", "shortlist", "archive"):
        # Early stages never move, and ``archive`` is terminal in both
        # directions (see the module docstring).
        return current
    day = today if today is not None else trip_local_today(tz)
    if current in _AUTO_ARCHIVE_FROM and day > end:
        return "archive"
    if current in _AUTO_LIVE_FROM and start <= day <= end:
        return "live"
    return current


def archive_is_due(
    stored: str | None,
    start: str | None,
    end: str | None,
    tz: str | None = None,
    today: str | None = None,
) -> bool:
    """True when the calendar says this trip is FINISHED and owes a write.

    The one-directional twin of :func:`effective_stage` — this is the
    predicate the owner-authorized write-back gates on, so that persisting the
    derived ``archive`` stays a decision this module owns rather than a
    ``derived != stored`` comparison scattered across each call site.
    """
    current = stored or "idea"
    if current not in _AUTO_ARCHIVE_FROM or not start or not end:
        return False
    day = today if today is not None else trip_local_today(tz)
    return day > end
