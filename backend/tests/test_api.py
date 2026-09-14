"""API tests — run with: cd backend && uv run pytest"""

import pytest
from fastapi.testclient import TestClient

from app.config import STATIC_DIR
from app.main import app
from app.store import load_trips

client = TestClient(app)


def test_health() -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_trip_by_token() -> None:
    trips = load_trips()
    assert trips, "no trip data found under backend/data/trips/"
    # public trip is readable anonymously via id (#64)
    t = next(tr for tr in trips if tr.visibility == "public")
    r = client.get(f"/api/trips/{t.id}")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == t.slug
    assert body["stage"] in {"idea", "options", "shortlist", "planned", "booked", "live", "archive"}
    # Media fields are stored as bare filenames but serialized as full
    # /media/<trip.$dtId>/<file> URLs — never slug-namespaced (#47 follow-up).
    # Anonymized fixtures redact media to /media/REDACTED — skip bare-name check there.
    if t.cover and "REDACTED" not in t.cover:
        assert body["cover"] == f"/media/{t.id}/{t.cover}"
        assert "canada-2027" not in body["cover"]


def _null_leaves(node: object, path: str = "$") -> list[str]:
    """Every JSON path in ``node`` whose value is an explicit ``null``."""
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}"
            if value is None:
                found.append(child)
            else:
                found += _null_leaves(value, child)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            child = f"{path}[{i}]"
            if value is None:
                found.append(child)
            else:
                found += _null_leaves(value, child)
    return found


def test_trip_document_omits_unset_optionals() -> None:
    """#220: a trip document carries no ``null`` leaves.

    Unset optionals are OMITTED (``_public_trip`` → ``exclude_none=True``)
    rather than shipped as ``null``: on a live trip roughly half the scalar
    leaves were null, almost all of them ``Block`` properties that belong to
    one of the ten kinds. Absent and ``null`` must therefore mean the same
    thing to a consumer, which is how the SPA already reads them
    (``??`` / ``!= null``).
    """
    trips = load_trips()
    assert trips, "no trip data found under backend/data/trips/"
    t = next(tr for tr in trips if tr.visibility == "public")
    body = client.get(f"/api/trips/{t.id}").json()
    nulls = _null_leaves(body)
    assert nulls == [], f"explicit nulls still serialized into the payload: {nulls[:10]}"


def test_public_trip_keeps_deliberate_falsy_values() -> None:
    """#220: ``exclude_none`` ONLY — falsy values are data, not emptiness.

    The strip is deliberately limited to ``None``. ``exclude_defaults=True``
    (or any hand-rolled "drop if falsy") would also erase ``order: 0``,
    ``lat: 0.0``, ``cost: 0``, a deliberately emptied ``[]`` and an empty
    string — real values, silently corrupted.
    """
    from app.main import _public_trip
    from app.models import Block, Day, Trip

    trip = Trip(
        id="11111111-1111-4111-8111-111111111111",
        slug="payload-test",
        title="Payload test",
        days=[
            Day(
                id="22222222-2222-4222-8222-222222222222",
                date="2027-02-15",
                blocks=[
                    Block(
                        id="33333333-3333-4333-8333-333333333333",
                        kind="activity",
                        title="Zero valued",
                        order=0,          # 0 is a real position
                        cost=0.0,         # 0 is a real cost
                        bookingCode="",   # explicitly emptied
                        items=[],         # explicitly emptied list
                        # every other optional stays unset -> omitted
                    )
                ],
            )
        ],
    )

    block = _public_trip(trip)["days"][0]["blocks"][0]
    assert block["order"] == 0
    assert block["cost"] == 0.0
    assert block["bookingCode"] == ""
    assert block["items"] == []
    # unset optionals are absent, not null
    for unset in ("placeId", "route", "time", "description"):
        assert unset not in block, f"{unset} should be omitted, not serialized as null"
    # a non-optional empty string default still survives (it is not None)
    assert _public_trip(trip)["subtitle"] == ""


def test_unknown_token_404() -> None:
    r = client.get("/api/trips/00000000-0000-4000-8000-000000000000")
    assert r.status_code == 404


def test_spa_fallback() -> None:
    if not (STATIC_DIR / "index.html").is_file():
        pytest.skip("frontend not built (copy frontend/dist → backend/app/static)")
    r = client.get("/t/some-id/itinerary")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
