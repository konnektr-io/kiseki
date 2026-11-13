"""The derived journey on the wire (#457): trip read, standalone route, ACL.

``GET /api/trips/{id}`` carries ``journey`` and a ``surface`` per day (so the
map, the day view and the booklet need one round trip), the standalone
``GET /api/trips/{id}/journey`` serves the shape alone for agents and the
follow-up validation endpoint, and both use the trip read's own ACL.

The ACL cases are deliberately the SAME shape as ``test_acl.py``'s, because the
requirement is "identical to the trip read": 401 without credentials, 403 below
``follower``, 200 for every crew role. If the two ever diverge, one of these
tests fails.
"""

from __future__ import annotations

import pytest
from collections.abc import Iterator

from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app.auth import Auth0JWTValidator
from app.main import _public_trip, app
from app.models import Trip
from app.ratelimit import reset as reset_rate_limits
from app.store import load_trips

from conftest import CLIENT_ID, TENANT, _claims, _sign


def _public() -> Trip:
    for trip in load_trips():
        if trip.visibility == "public":
            return trip
    raise AssertionError("no public trip in fixtures")


def _private_id() -> str:
    for trip in load_trips():
        if trip.visibility == "private":
            return trip.id
    raise AssertionError("no private trip in fixtures")


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    reset_rate_limits()
    yield TestClient(app)
    reset_rate_limits()


@pytest.fixture
def role(monkeypatch: pytest.MonkeyPatch):
    def _set(value: str | None) -> None:
        monkeypatch.setattr(acl_module, "get_trip_role_for_user", lambda *a, **k: value)

    return _set


def _token(rsa_keypair) -> str:
    return _sign(rsa_keypair, _claims())


# --------------------------------------------------------------- trip read


def test_a_public_trip_read_carries_the_journey_and_a_surface_per_day(client: TestClient) -> None:
    trip = _public()
    body = client.get(f"/api/trips/{trip.id}").json()
    journey = body["journey"]
    assert journey["chain"], "every fixture trip has a chain"
    assert journey["stops"]
    assert len(journey["visits"]) == len(journey["chain"])
    assert len(journey["legs"]) == max(0, len(journey["chain"]) - 1)
    # A surface per day, aligned to the days array.
    assert len(body["days"]) == len(trip.days)
    for day in body["days"]:
        assert "surface" in day
        assert {"markers", "legs", "endpoints", "tracks"} == set(day["surface"])


def test_every_write_response_carries_the_journey_too() -> None:
    """Writes return the canonical document, so the client never refetches.

    ``_public_trip`` is the one serializer behind every trip-shaped write, so
    this single assertion is what makes "refetch after a write" free.
    """
    body = _public_trip(_public(), my_role="editor")
    assert "journey" in body
    assert all("surface" in day for day in body["days"])


# ------------------------------------------------------------ standalone


def test_the_standalone_route_serves_exactly_what_the_read_carries(client: TestClient) -> None:
    trip = _public()
    read = client.get(f"/api/trips/{trip.id}").json()
    standalone = client.get(f"/api/trips/{trip.id}/journey").json()
    assert standalone["journey"] == read["journey"]
    assert standalone["days"] == [day.get("surface") for day in read["days"]]


def test_an_unknown_trip_has_no_journey(client: TestClient) -> None:
    assert client.get("/api/trips/00000000-0000-4000-8000-000000000000/journey").status_code == 404


# ------------------------------------------------------------------- ACL


def test_a_private_trip_journey_needs_a_token(client: TestClient) -> None:
    assert client.get(f"/api/trips/{_private_id()}/journey").status_code == 401


def test_a_private_trip_journey_is_forbidden_without_a_role(
    client: TestClient, rsa_keypair, role
) -> None:
    role(None)
    r = client.get(
        f"/api/trips/{_private_id()}/journey", headers={"Authorization": f"Bearer {_token(rsa_keypair)}"}
    )
    assert r.status_code == 403


@pytest.mark.parametrize("crew_role", ["follower", "viewer", "editor", "owner"])
def test_every_crew_role_reads_the_journey(client: TestClient, rsa_keypair, role, crew_role: str) -> None:
    """``follower`` is the read floor (#65) — the journey is not more secret
    than the trip it describes, so it follows the same ladder."""
    role(crew_role)
    r = client.get(
        f"/api/trips/{_private_id()}/journey", headers={"Authorization": f"Bearer {_token(rsa_keypair)}"}
    )
    assert r.status_code == 200
    assert r.json()["journey"]["chain"]


def test_the_journey_is_identical_for_a_stranger_and_the_owner(
    client: TestClient, rsa_keypair, role
) -> None:
    """It is derived from the FULL document, before redaction.

    Redaction strips booking blocks and costs, and a booking block that names a
    place attributes a day — deriving after redaction would hand strangers a
    different chain than the crew sees (#249 + #457).
    """
    trip = _public()
    anonymous = client.get(f"/api/trips/{trip.id}").json()
    role("owner")
    owned = client.get(
        f"/api/trips/{trip.id}", headers={"Authorization": f"Bearer {_token(rsa_keypair)}"}
    ).json()
    assert anonymous["journey"] == owned["journey"]
    assert anonymous["days"] and [d.get("surface") for d in anonymous["days"]] == [
        d.get("surface") for d in owned["days"]
    ]
