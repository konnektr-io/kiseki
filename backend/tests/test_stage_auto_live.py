"""Auto-live / auto-archive derivation — issues #362, #396.

``effective_stage()`` is pure (``today`` injectable), so these tests pin the
contract without touching the clock: the Albany week that motivated #362 is
the first case, and the same week read AFTER it ended is what motivated #396.
"""

from app.stage import archive_is_due, effective_stage, trip_local_today


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
    # Past the end date a `booked` trip now auto-archives (#396) — the case
    # that used to read "booked" forever, presenting a finished trip as an
    # upcoming plan.
    assert effective_stage("booked", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-26") == "archive"
    # A `live` trip whose window has passed also retires (#396): this is the
    # real Albany case — stored live since the trip ran, never cleared.
    assert effective_stage("live", "2026-09-21", "2026-09-25", "America/New_York", today="2026-10-01") == "archive"


def test_a_live_trip_marked_early_does_not_archive_before_it_starts():
    # A future-dated trip someone flipped to `live` in advance must read
    # `live` until its end date actually passes — the derivation is about the
    # calendar, not about second-guessing an early manual flip.
    assert effective_stage("live", "2027-02-15", "2027-03-02", "America/New_York", today="2026-09-29") == "live"
    assert effective_stage("live", "2027-02-15", "2027-03-02", "America/New_York", today="2027-03-03") == "archive"


def test_early_stages_never_auto_archive():
    # A passed date on an idea is a stale plan, not a finished trip: archiving
    # it would shelve an itinerary the owner is still choosing between.
    for stage in ("idea", "options", "shortlist"):
        assert effective_stage(stage, "2026-09-21", "2026-09-25", "America/New_York", today="2026-10-01") == stage


def test_archive_is_terminal_in_both_directions():
    # Never derived away from: an archived trip stays archived even if its
    # dates are extended into the future (a re-planned archive must be an
    # explicit un-archive, not a side effect of moving a date).
    assert effective_stage("archive", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-23") == "archive"
    assert effective_stage("archive", "2027-01-01", "2027-01-10", "America/New_York", today="2027-01-05") == "archive"


def test_end_date_is_inclusive():
    # The last day of the trip is still live — it archives the day AFTER.
    assert effective_stage("booked", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-25") == "live"
    assert effective_stage("booked", "2026-09-21", "2026-09-25", "America/New_York", today="2026-09-26") == "archive"


def test_auto_archive_is_trip_local_not_utc():
    # 2026-09-26 03:30 UTC is still Sep 25 in New York (EDT, UTC-4): the
    # trip is on its LAST DAY there, so it must still read live.
    import datetime as dt

    instant = dt.datetime(2026, 9, 26, 3, 30, tzinfo=dt.timezone.utc)
    # Same instant expressed as the trip-local day the server would resolve.
    assert effective_stage("live", "2026-09-21", "2026-09-25", "America/New_York", today=trip_local_today("America/New_York", now=instant)) == "live"
    # One hour later New York has rolled over, and it archives.
    later = dt.datetime(2026, 9, 26, 5, 30, tzinfo=dt.timezone.utc)
    assert effective_stage("live", "2026-09-21", "2026-09-25", "America/New_York", today=trip_local_today("America/New_York", now=later)) == "archive"


def test_undated_never_derives():
    assert effective_stage("live", None, None, "America/New_York", today="2026-10-01") == "live"
    assert effective_stage("live", "2026-09-21", None, "America/New_York", today="2026-10-01") == "live"
    assert effective_stage("booked", None, None, "America/New_York", today="2026-10-01") == "booked"


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


def test_archive_is_due_matches_the_derived_archive_exactly():
    """The write-back predicate and the derivation must never disagree.

    They are two functions over the same inputs, so a divergence would write
    an `archive` the read path then contradicts (or skip one it promised). This
    pins them as one rule across a sweep, not just the cases above.
    """
    stages = ("idea", "options", "shortlist", "planned", "booked", "live", "archive", None)
    dates = (
        ("2026-09-21", "2026-09-25"),
        ("2026-09-25", "2026-09-25"),
        ("2027-02-15", "2027-03-02"),
        ("2020-01-01", "2020-01-05"),
        (None, "2026-09-25"),
        ("2026-09-21", None),
        ("not-a-date", "2026-09-25"),
    )
    days = ("2026-09-20", "2026-09-21", "2026-09-25", "2026-09-26", "2027-03-03")
    for stored in stages:
        for start, end in dates:
            for day in days:
                derived = effective_stage(stored, start, end, "UTC", today=day)
                due = archive_is_due(stored, start, end, "UTC", today=day)
                assert due == (derived == "archive" and stored != "archive"), (
                    f"stored={stored} {start}..{end} today={day}: "
                    f"derived={derived} but due={due}"
                )


def test_archive_is_due_is_one_directional():
    # Never due while the trip is running or still ahead — a live trip in
    # range owes nothing, and the auto-LIVE promotion is never a write.
    assert archive_is_due("live", "2026-09-21", "2026-09-25", "UTC", today="2026-09-23") is False
    assert archive_is_due("booked", "2026-09-21", "2026-09-25", "UTC", today="2026-09-23") is False
    assert archive_is_due("booked", "2027-02-15", "2027-03-02", "UTC", today="2026-09-23") is False
    # Never due for an early stage, an archive, or an undated trip.
    assert archive_is_due("idea", "2026-09-21", "2026-09-25", "UTC", today="2026-10-01") is False
    assert archive_is_due("archive", "2026-09-21", "2026-09-25", "UTC", today="2026-10-01") is False
    assert archive_is_due("live", None, None, "UTC", today="2026-10-01") is False


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
