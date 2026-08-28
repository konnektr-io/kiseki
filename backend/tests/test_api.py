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
    t = trips[0]
    r = client.get(f"/api/trips/{t.token}")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == t.slug
    assert body["stage"] in {"idea", "options", "shortlist", "planned", "booked", "live", "archive"}


def test_unknown_token_404() -> None:
    r = client.get("/api/trips/definitely-not-a-real-token")
    assert r.status_code == 404


def test_spa_fallback() -> None:
    if not (STATIC_DIR / "index.html").is_file():
        pytest.skip("frontend not built (copy frontend/dist → backend/app/static)")
    r = client.get("/t/some-token/itinerary")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
