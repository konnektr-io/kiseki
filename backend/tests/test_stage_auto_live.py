"""Auto-live derivation — issue #362.

``effective_stage()`` is pure (``today`` injectable), so these tests pin the
contract without touching the clock: the Albany week that motivated the issue
is the first case.
"""

from app.stage import effective_stage, trip_local_today


def test_albany_week_reads_live_while_stored_booked():
    # Albany — SUNY week: booked, 2026-09-21 → 2026-09-25, America/New_York.
    assert (
        effective_stage("booked", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-21")
        == "live"
    )
    assert (
        effective_stage("booked", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-25")
        == "live"
    )


def test_planned_promotes_like_booked():
    assert effective_stage("planned", "2027-07-17", "2027-08-02", "America/Santiago", today="2027-07-20") == "live"


def test_outside_window_reads_stored():
    assert effective_stage("booked", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-20") == "booked"
    assert effective_stage("booked", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-26") == "booked"
    # Past the end date the trip does NOT auto-archive — that stays manual.
    assert effective_stage("live", "2026-09-21", "2026-09-25", "America/New_York", today="2026-10-01") == "live"


def test_early_stages_never_auto_live():
    for stage in ("idea", "options", "shortlist"):
        assert effective_stage(stage, "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-23") == stage


def test_archive_is_terminal():
    assert effective_stage("archive", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-23") == "archive"


def test_undated_never_auto_live():
    assert effective_stage("booked", None, None, "America/New_York", today="2026-09-23") == "booked"
    assert effective_stage("booked", "2026-09-21", None, "America/New_York", today="2026-09-23") == "booked"


def test_malformed_dates_fail_closed():
    assert effective_stage("booked", "not-a-date", "2026-09-25", "America/New_York", today="2026-09-23") == "booked"


def test_trip_local_today_respects_iana_timezone():
    import datetime as dt

    # 2026-09-21 03:30 UTC is still Sep 20 in New York (EDT, UTC-4).
    instant = dt.datetime(2026, 9, 21, 3, 30, tzinfo=dt.timezone.utc)
    assert trip_local_today("America/New_York", now=instant) == "2026-09-20"
    assert trip_local_today("UTC", now=instant) == "2026-09-21"


def test_trip_local_today_falls_back_to_utc():
    import datetime as dt

    instant = dt.datetime(2026, 9, 21, 3, 30, tzinfo=dt.timezone.utc)
    assert trip_local_today(None, now=instant) == "2026-09-21"
    assert trip_local_today("", now=instant) == "2026-09-21"
    assert trip_local_today("Not/AZone", now=instant) == "2026-09-21"


def test_summary_mapping_derives_effective_stage():
    """``_trip_summary_from_list`` carries the derived stage (#362).

    The wide window keeps the assertion independent of the run date; the
    legacy 10-wide row (no timezone) derives on UTC.
    """
    from app.graph.client import GraphReadClient

    wide = ["tid", "private", "T", "S", "booked", "2020-01-01", "2030-12-31", "slug", "c.jpg", "owner"]
    s = GraphReadClient._trip_summary_from_list([*wide, True, "America/New_York"])
    assert s["stage"] == "booked"
    assert s["effectiveStage"] == "live"
    assert s["timezone"] == "America/New_York"

    legacy = GraphReadClient._trip_summary_from_list(wide)
    assert legacy["effectiveStage"] == "live"
    assert legacy["timezone"] is None

    idea = GraphReadClient._trip_summary_from_list([*wide[:4], "idea", *wide[5:], True, "America/New_York"])
    assert idea["effectiveStage"] == "idea"


def test_card_mapper_derives_effective_stage():
    from app.graph.client import GraphReadClient

    card = GraphReadClient._trip_card_from_row(
        {
            "dtId": "trip-1",
            "visibility": "public",
            "discoverable": True,
            "title": "A trip",
            "subtitle": "Somewhere",
            "stage": "booked",
            "startDate": "2020-01-01",
            "endDate": "2030-12-31",
            "cover": None,
            "timezone": "America/New_York",
        }
    )
    assert card is not None
    assert card["stage"] == "booked"
    assert card["effectiveStage"] == "live"
