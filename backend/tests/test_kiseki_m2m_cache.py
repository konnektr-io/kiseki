"""Tests for scripts/kiseki_m2m.py — the cached M2M token (quota fix).

The tenant charges every ``client_credentials`` grant against a monthly
M2M-token quota, so the helper must reuse a cached token until shortly before
it expires. No network here: the grant itself is monkeypatched and the cache
lives in tmp_path.
"""

from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import kiseki_m2m as m2m


def _jwt(exp: int) -> str:
    def seg(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    return f"{seg({'alg': 'none'})}.{seg({'exp': exp})}.sig"


@pytest.fixture()
def grants(tmp_path, monkeypatch):
    """Isolated cache + a counting stand-in for the real grant."""
    monkeypatch.setenv("KISEKI_TOKEN_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.delenv("KISEKI_TOKEN_NO_CACHE", raising=False)
    monkeypatch.delenv("KISEKI_TOKEN_SKEW", raising=False)
    monkeypatch.setattr(m2m, "CLIENT_ID", "client-abc")
    monkeypatch.setattr(m2m, "CLIENT_SECRET", "s3cret")
    calls: list[tuple[str, str]] = []

    def fake_grant(client_id: str, client_secret: str, audience: str) -> str:
        calls.append((client_id, audience))
        return _jwt(int(time.time()) + 3600)

    monkeypatch.setattr(m2m, "_grant", fake_grant)
    return calls


def test_repeated_calls_share_one_grant(grants):
    """The whole point: N API calls must not cost N tokens."""
    tokens = [m2m.m2m_token() for _ in range(5)]

    assert len(set(tokens)) == 1
    assert len(grants) == 1


def test_token_is_cached_on_disk_owner_only_and_keyed_by_client_and_audience(grants):
    token = m2m.m2m_token()
    path = m2m._cache_path(m2m.CLIENT_ID, m2m.AUDIENCE)

    entry = json.loads(path.read_text())
    assert entry["access_token"] == token
    assert entry["client_id"] == m2m.CLIENT_ID
    assert entry["audience"] == m2m.AUDIENCE
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.name.startswith("m2m-")


def test_expired_token_is_reminted(grants, tmp_path):
    path = m2m._cache_path(m2m.CLIENT_ID, m2m.AUDIENCE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"access_token": _jwt(int(time.time()) - 10)}))

    m2m.m2m_token()

    assert len(grants) == 1


def test_token_expiring_inside_the_skew_is_reminted(grants, monkeypatch):
    path = m2m._cache_path(m2m.CLIENT_ID, m2m.AUDIENCE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"access_token": _jwt(int(time.time()) + 60)}))

    m2m.m2m_token()

    assert len(grants) == 1


def test_no_cache_env_spends_a_grant_every_call(grants, monkeypatch):
    monkeypatch.setenv("KISEKI_TOKEN_NO_CACHE", "1")

    m2m.m2m_token()
    m2m.m2m_token()

    assert len(grants) == 2


def test_force_spends_a_grant(grants):
    m2m.m2m_token()
    m2m.m2m_token(force=True)

    assert len(grants) == 2


def test_unreadable_cache_falls_back_to_minting(grants, monkeypatch):
    """A broken cache is never allowed to break a scripted round."""
    monkeypatch.setattr(m2m, "_cache_path", lambda *_: Path("/proc/nope/m2m.json"))

    assert m2m.m2m_token()
    assert len(grants) == 1


def test_missing_credentials_raise(monkeypatch):
    monkeypatch.setattr(m2m, "CLIENT_ID", "")
    monkeypatch.setattr(m2m, "CLIENT_SECRET", "")

    with pytest.raises(RuntimeError):
        m2m.m2m_token()


def test_api_uses_the_cached_token(grants, monkeypatch):
    """api() must not mint per request — that was the quota burn."""
    seen: list[str] = []

    def fake_urlopen(req, **kwargs):  # noqa: ANN001
        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'{"trips": []}'

        seen.append(req.headers["Authorization"])
        return _Resp()

    monkeypatch.setattr(m2m.urllib.request, "urlopen", fake_urlopen)

    m2m.api("GET", "/api/trips")
    m2m.api("GET", "/api/trips")

    assert len(grants) == 1
    assert len(set(seen)) == 1
