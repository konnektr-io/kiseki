"""Tricount integration tests (issue #111).

Two layers:

1. Pure mapping tests — the library's Tricount/Transaction/Amount dataclasses
   → TricountSnapshot (sign normalization, balances, category fallback) with
   NO network.
2. HTTP endpoint tests — FakeGraph + real ACL chain, with the tricount
   service monkeypatched (validate_registry_key / fetch_snapshot), so the
   role matrix and the write path are proven without hitting bunq.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.main import app
from app.ratelimit import reset as reset_rate_limits
from app.tricount import TriCountError, fetch_snapshot, reset_cache
from app.models import TricountSnapshot

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
CANADA_KEY = "twOQZFDbXxZzipcjXG"


# ---------------------------------------------------------------- fixtures
@pytest.fixture(autouse=True)
def _fresh_rate_limits_and_cache():
    reset_rate_limits()
    reset_cache()
    yield
    reset_rate_limits()
    reset_cache()


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    return TestClient(app)


@pytest.fixture
def graph(monkeypatch: pytest.MonkeyPatch):
    """Factory: stage a FakeGraph + give the test user a crew role on it."""
    made: list[FakeGraph] = []

    def _make(role: str = "owner", fixture: str = "canada-2027.graph.anon.json",
              sub: str = SUB) -> FakeGraph:
        g = FakeGraph(fixture)
        g.add_user_role(g.root, sub, role)
        monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
        made.append(g)
        return g

    yield _make
    for g in made:
        store_mod._reset_store_cache()


def _token_of(rsa_keypair, **overrides: object) -> str:
    return _sign(rsa_keypair, _claims(**overrides))


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _connect(g: FakeGraph, key: str = CANADA_KEY) -> None:
    """Wire a tricount key onto the fake trip's practical twin property."""
    twin = g.twin(g.root)
    practical = twin.get("practical") or {}
    practical["tricount"] = {"registryKey": key}
    twin["practical"] = practical


# ----------------------------------------------------- pure mapping layer
def _lib_tricount(balances_case: str = "canada") -> Any:
    """Build the library's Tricount dataclass without any network."""
    from tricount import (
        Allocation,
        Amount,
        Member,
        Transaction,
        TransactionType,
    )

    members = [
        Member(id=1, uuid="uuid-niko", display_name="Niko"),
        Member(id=2, uuid="uuid-nick", display_name="Nick"),
        Member(id=3, uuid="uuid-stefan", display_name="Stefan"),
    ]
    txs = []
    if balances_case == "canada":
        # Vluchten: Niko paid 3017.43, split equally 3 ways (1005.81 each)
        txs.append(Transaction(
            id=1, uuid="tx-1", description="Vluchten",
            amount=Amount("-3017.43", "EUR"),
            membership_uuid_owner="uuid-niko",
            allocations=[
                Allocation(membership_uuid="uuid-niko", amount=Amount("-1005.81", "EUR")),
                Allocation(membership_uuid="uuid-nick", amount=Amount("-1005.81", "EUR")),
                Allocation(membership_uuid="uuid-stefan", amount=Amount("-1005.81", "EUR")),
            ],
            date="2026-08-28 10:00:00.000000",
            transaction_type=TransactionType.NORMAL,
            category="UNCATEGORIZED",
        ))
        txs.append(Transaction(
            id=2, uuid="tx-2", description="Ikon pass",
            amount=Amount("-2457.91", "EUR"),
            membership_uuid_owner="uuid-niko",
            allocations=[
                Allocation(membership_uuid="uuid-niko", amount=Amount("-819.30", "EUR")),
                Allocation(membership_uuid="uuid-nick", amount=Amount("-819.30", "EUR")),
                Allocation(membership_uuid="uuid-stefan", amount=Amount("-819.31", "EUR")),
            ],
            date="2026-09-06 16:56:30.835000",
            transaction_type=TransactionType.NORMAL,
            category="UNCATEGORIZED",
        ))
    elif balances_case == "settlement":
        # Append a reimbursement (BALANCE) on top of the Canada base: Nick
        # pays Niko back 1000 (Niko's balance goes DOWN by 1000 — he received
        # money; Nick's goes UP — he paid). Same formula as expenses: the API
        # stores reimbursements POSITIVE and expenses NEGATIVE, but balances
        # always flow payer += total / allocated -= share.
        base = _lib_tricount("canada")
        base.transactions.append(Transaction(
            id=3, uuid="tx-3", description="Terugbetaling",
            amount=Amount("1000.00", "EUR"),
            membership_uuid_owner="uuid-nick",
            allocations=[
                Allocation(membership_uuid="uuid-niko", amount=Amount("1000.00", "EUR")),
            ],
            date="2026-09-07 09:00:00.000000",
            transaction_type=TransactionType.BALANCE,
            category="UNCATEGORIZED",
        ))
        return base
    return _lib_tricount_object(members, txs)


def _lib_tricount_object(members: list, txs: list) -> Any:
    from tricount import Tricount

    return Tricount(
        id=47790603,
        uuid="reg-uuid",
        title="Canada 2027",
        description="",
        currency="EUR",
        public_identifier_token=CANADA_KEY,
        members=members,
        transactions=txs,
    )


def test_mapping_canada_balances_and_signs() -> None:
    """The probe's ground truth: Niko +3650.23, Nick -1825.11, Stefan -1825.12;
    expense amounts positive; shares per member positive."""
    from app.tricount import _to_snapshot

    snap = _to_snapshot(_lib_tricount(), CANADA_KEY)
    assert snap.title == "Canada 2027"
    assert snap.currency == "EUR"
    assert snap.members == ["Niko", "Nick", "Stefan"]
    bal = {b.member: b.amount for b in snap.balances}
    assert bal["Niko"] == pytest.approx(3650.23)
    assert bal["Nick"] == pytest.approx(-1825.11)
    assert bal["Stefan"] == pytest.approx(-1825.12)
    assert all(b.currency == "EUR" for b in snap.balances)

    assert [e.description for e in snap.expenses] == ["Vluchten", "Ikon pass"]
    e1 = snap.expenses[0]
    assert e1.whoPaid == "Niko"
    assert e1.amount == pytest.approx(3017.43)  # stored negative, served positive
    assert e1.involved == ["Nick", "Niko", "Stefan"]
    assert all(v > 0 for v in e1.shareFor.values())
    assert e1.shareFor["Stefan"] == pytest.approx(1005.81)
    assert e1.type == "NORMAL"
    assert e1.date == "2026-08-28"


def test_mapping_balance_reimbursement() -> None:
    """BALANCE transactions settle debt on top of the Canada base
    (Niko +3650.23 / Nick -1825.11): Nick reimburses Niko 1000 →
    Niko 2650.23, Nick -825.11. Balances flow payer += total /
    allocated -= share regardless of the stored sign."""
    from app.tricount import _to_snapshot

    snap = _to_snapshot(_lib_tricount("settlement"), CANADA_KEY)
    bal = {b.member: b.amount for b in snap.balances}
    assert bal["Niko"] == pytest.approx(2650.23)
    assert bal["Nick"] == pytest.approx(-825.11)
    reimbursement = next(e for e in snap.expenses if e.type == "BALANCE")
    assert reimbursement.amount == pytest.approx(1000.0)
    assert reimbursement.whoPaid == "Nick"
    assert reimbursement.involved == ["Niko"]
    assert reimbursement.shareFor["Niko"] == pytest.approx(1000.0)


def test_mapping_inactive_member_ignored() -> None:
    from app.tricount import _to_snapshot
    from tricount import Member

    t = _lib_tricount()
    t.members.append(Member(id=9, uuid="uuid-ghost", display_name="Ghost", status="DELETED"))
    snap = _to_snapshot(t, CANADA_KEY)
    assert "Ghost" not in snap.members
    assert all(b.member != "Ghost" for b in snap.balances)


def test_fetch_snapshot_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    """Second call within the TTL is served from cache (client not re-created)."""
    calls = {"n": 0}

    class FakeClient:
        def get_tricount(self, key: str):
            calls["n"] += 1
            return _lib_tricount()

    monkeypatch.setattr("app.tricount._client", lambda: FakeClient())
    a = fetch_snapshot(CANADA_KEY)
    b = fetch_snapshot(CANADA_KEY)
    assert calls["n"] == 1
    assert a.registryKey == b.registryKey == CANADA_KEY

    r = fetch_snapshot(CANADA_KEY, refresh=True)
    assert calls["n"] == 2
    assert r.title == "Canada 2027"


def test_fetch_snapshot_unknown_registry(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        status_code = 404

    class FakeHTTPError(Exception):
        response = FakeResponse()

    class FakeClient:
        def get_tricount(self, key: str):
            raise FakeHTTPError("404")

    monkeypatch.setattr("app.tricount._client", lambda: FakeClient())
    with pytest.raises(TriCountError) as exc:
        fetch_snapshot("badkey")
    assert exc.value.status == 404


# ------------------------------------------------------ HTTP endpoint layer
def test_snapshot_requires_auth(client) -> None:
    r = client.get("/api/trips/00000000-0000-4000-8000-000000000000/practical/tricount")
    assert r.status_code == 401


def test_snapshot_unknown_trip_403(client, rsa_keypair, graph) -> None:
    """Unknown trip + valid token → 403: the ACL answers before the store
    (no crew edge = no existence leak; the write-API convention)."""
    graph(role="owner")
    r = client.get(
        "/api/trips/00000000-0000-4000-8000-000000000000/practical/tricount",
        headers=_auth(_token_of(rsa_keypair)),
    )
    assert r.status_code == 403


def test_snapshot_404_when_not_connected(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    r = client.get(
        f"/api/trips/{g.root}/practical/tricount",
        headers=_auth(_token_of(rsa_keypair)),
    )
    assert r.status_code == 404
    assert "no Tricount" in r.json()["detail"]


def test_snapshot_role_matrix(client, rsa_keypair, graph, monkeypatch) -> None:
    """CREW-only: viewer/editor/owner 200; follower 403; anonymous 401."""
    url = None
    for role, expected in (("follower", 403), ("viewer", 200), ("editor", 200), ("owner", 200)):
        sub = f"google-oauth2|{role}"
        g = graph(role=role, sub=sub)
        _connect(g)
        monkeypatch.setattr(
            "app.tricount._client",
            lambda: type("C", (), {"get_tricount": staticmethod(
                lambda key: _lib_tricount())})(),
        )
        url = f"/api/trips/{g.root}/practical/tricount"
        token = _token_of(rsa_keypair, sub=sub)
        r = client.get(url, headers=_auth(token))
        assert r.status_code == expected, role
        if expected == 200:
            body = r.json()
            assert body["registryKey"] == CANADA_KEY
            assert body["title"] == "Canada 2027"
            assert {b["member"]: b["amount"] for b in body["balances"]} == {
                "Niko": 3650.23, "Nick": -1825.11, "Stefan": -1825.12,
            }
    # same URL pattern, anonymous: 401 (no auth header)
    assert client.get(url).status_code == 401


def test_connect_owner_only_persists_key(client, rsa_keypair, graph, monkeypatch) -> None:
    """Owner connects with a pasted sharing URL; the trip doc comes back with
    practical.tricount set (persisted to the fake graph)."""
    g = graph(role="owner")
    monkeypatch.setattr(
        "app.tricount.validate_registry_key",
        lambda key: TricountSnapshot(
            registryKey=key, title="Canada 2027", currency="EUR",
            members=[], expenses=[], balances=[],
            fetchedAt="2026-09-07T00:00:00+00:00",
        ),
    )
    url = f"/api/trips/{g.root}/practical/tricount/connect"
    r = client.post(
        url,
        headers=_auth(_token_of(rsa_keypair)),
        json={"registryKey": f"https://tricount.com/t{CANADA_KEY}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["practical"]["tricount"]["registryKey"] == CANADA_KEY
    # persisted on the twin
    assert g.twin(g.root)["practical"]["tricount"]["registryKey"] == CANADA_KEY


def test_connect_rejects_non_owner(client, rsa_keypair, graph, monkeypatch) -> None:
    for role in ("editor", "viewer", "follower"):
        g = graph(role=role, sub=f"google-oauth2|{role}")
        token = _token_of(rsa_keypair, sub=f"google-oauth2|{role}")
        r = client.post(
            f"/api/trips/{g.root}/practical/tricount/connect",
            headers=_auth(token),
            json={"registryKey": CANADA_KEY},
        )
        assert r.status_code == 403, role


def test_connect_bad_key_never_persists(client, rsa_keypair, graph, monkeypatch) -> None:
    """Validation happens BEFORE the write — a bad key writes nothing."""
    def _boom(key: str):
        raise TriCountError(404, "No Tricount registry with that key")

    g = graph(role="owner")
    monkeypatch.setattr("app.tricount.validate_registry_key", _boom)
    r = client.post(
        f"/api/trips/{g.root}/practical/tricount/connect",
        headers=_auth(_token_of(rsa_keypair)),
        json={"registryKey": "nope"},
    )
    assert r.status_code == 404
    assert "tricount" not in (g.twin(g.root).get("practical") or {})


def test_disconnect_idempotent_owner_only(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    _connect(g)
    url = f"/api/trips/{g.root}/practical/tricount"
    r = client.delete(url, headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 200
    assert r.json()["practical"].get("tricount") is None
    assert "tricount" not in (g.twin(g.root).get("practical") or {})
    # second disconnect: still 200, no error
    r2 = client.delete(url, headers=_auth(_token_of(rsa_keypair)))
    assert r2.status_code == 200

    # viewer cannot disconnect
    graph(role="viewer", sub="google-oauth2|viewer2")
    token = _token_of(rsa_keypair, sub="google-oauth2|viewer2")
    assert client.delete(url, headers=_auth(token)).status_code == 403


def test_practical_put_preserves_tricount(client, rsa_keypair, graph) -> None:
    """A plain practical PUT must not clobber the connection (issue #111)."""
    g = graph(role="owner")
    _connect(g)
    r = client.put(
        f"/api/trips/{g.root}/practical",
        headers=_auth(_token_of(rsa_keypair)),
        json={"todos": [{"label": "x", "done": False}], "links": [], "contacts": []},
    )
    assert r.status_code == 200
    assert r.json()["practical"]["tricount"]["registryKey"] == CANADA_KEY
    assert g.twin(g.root)["practical"]["tricount"]["registryKey"] == CANADA_KEY
