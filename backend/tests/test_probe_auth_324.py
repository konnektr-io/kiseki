"""The browser probe's credential handling (issue #324).

`probe_trip_page.py` used to require a minted M2M token — and Auth0 meters
every `client_credentials` grant tenant-wide, so probe loops are what burn the
monthly quota. It now prefers the admin API key. These tests pin the choice
plus the header it produces, both of which decide whether a probe run costs
quota or not.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "probe_trip_page.py"


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch):
    """The probe module, imported without touching the real environment."""
    for var in ("PROBE_API_KEY", "KISEKI_API_KEY", "PROBE_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    spec = importlib.util.spec_from_file_location("probe_trip_page", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["probe_trip_page"] = module
    spec.loader.exec_module(module)
    return module


def test_key_wins_over_token(probe, monkeypatch: pytest.MonkeyPatch) -> None:
    """An ambient key must never be shadowed by a stale PROBE_TOKEN."""
    monkeypatch.setenv("PROBE_API_KEY", "ksk_from_probe")
    monkeypatch.setenv("PROBE_TOKEN", "ey.stale.jwt")
    assert probe.credential() == ("key", "ksk_from_probe")


def test_falls_back_to_profile_env_key(probe, monkeypatch: pytest.MonkeyPatch) -> None:
    """KISEKI_API_KEY in the profile .env is enough — no per-run export."""
    monkeypatch.setenv("KISEKI_API_KEY", "ksk_from_env")
    assert probe.credential() == ("key", "ksk_from_env")


def test_token_still_supported_without_a_key(probe, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PROBE_TOKEN", "ey.jwt")
    assert probe.credential() == ("token", "ey.jwt")


def test_no_credential_is_a_usage_error(probe) -> None:
    with pytest.raises(SystemExit) as exc:
        probe.credential()
    assert exc.value.code == 2


def test_header_shape_per_credential(probe) -> None:
    """Key → X-API-Key, token → Authorization. Never both (bearer-first)."""
    assert probe.auth_header("key", "ksk_x") == {"X-API-Key": "ksk_x"}
    assert probe.auth_header("token", "ey.jwt") == {"Authorization": "Bearer ey.jwt"}
