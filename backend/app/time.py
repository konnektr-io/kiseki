"""Clock seam for time-dependent read logic (issue #15/#95).

``utcnow`` is a one-line wrapper around the system clock so tests can
monkeypatch a fixed ``now`` instead of waiting 30 days for a maturity rule
to bite. Call it from read-path code; never from write-path code (writes
stamp ``updated`` via ``write._today``).
"""

from __future__ import annotations

import datetime as _dt


def utcnow() -> _dt.datetime:
    """Current UTC time (naive). Monkeypatch in tests for a fixed now."""
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
