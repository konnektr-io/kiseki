"""TriCount (bunq) expense integration — issue #111.

Read-only bridge between a trip's ``practical.tricount.registryKey`` and the
crew's shared Tricount registry. Built on the unofficial ``tricount-api``
client (MIT, reverse-engineered from the Android app) — the same flow the
probe validated against the live Canada 2027 registry before implementation:

    Credentials (app GUID + RSA *public* key — NOT secrets, the private key
    never leaves the generator) → POST session-registry-installation → token
    → GET registry by public_identifier_token.

Design rules:

- **Never persisted in the graph.** The snapshot is fetched on demand and
  cached in-process for ``KISEKI_TRICOUNT_TTL`` seconds (bunq is a third
  party; every extra call is a rate-limit and an outage risk). The graph
  stores only the registry key (public — same secrecy class as the trip id
  link), never a snapshot.
- **Structurally read-only.** No expense/member mutation helper is exposed
  here; the crew still adds expenses in the Tricount app (the live link is
  shown next to the panel).
- **Degrades gracefully.** Every failure maps to a TriCountError with an
  HTTP status + short human detail; the UI shows the error and keeps the
  Tricount app link working.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .config import KISEKI_TRICOUNT_CREDS_FILE, KISEKI_TRICOUNT_TTL
from .models import TricountBalance, TricountExpense, TricountSnapshot

# Imported lazily inside the factory so dev/CI without the package still run
# (same pattern as minio in app/media.py) — tricount is only touched when a
# trip actually connects a registry or serves a snapshot.
_TRICOUNT_MISSING = (
    "tricount-api package not installed — cannot reach Tricount "
    "(add `tricount-api` to backend dependencies)"
)


class TriCountError(Exception):
    """Expected Tricount failure; carries the HTTP status (mirrors WriteError)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ------------------------------------------------------------------ cache
# In-process snapshot cache: (expiry_epoch, TricountSnapshot). Per registry
# key. The graph is never involved; a pod restart just re-fetches.
_snapshot_cache: dict[str, tuple[float, TricountSnapshot]] = {}
_cache_lock = threading.Lock()


def reset_cache() -> None:
    """Test/ops helper — drop every cached snapshot."""
    with _cache_lock:
        _snapshot_cache.clear()


def _cached(key: str) -> TricountSnapshot | None:
    with _cache_lock:
        hit = _snapshot_cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        if hit:
            del _snapshot_cache[key]
    return None


def _store(key: str, snap: TricountSnapshot) -> TricountSnapshot:
    with _cache_lock:
        _snapshot_cache[key] = (time.monotonic() + max(KISEKI_TRICOUNT_TTL, 1), snap)
    return snap


# ------------------------------------------------------------ credentials
def _load_credentials():
    """Return a tricount Credentials object (pinned file or self-generated).

    The credentials are an anonymous app-installation identity, not user
    secrets: an app GUID plus an RSA public key. Self-generation per process
    is what the library itself does; a pinned file (k8s Secret mounted via
    KISEKI_TRICOUNT_CREDS_FILE) keeps the installation stable across pods.
    """
    try:
        from tricount import Credentials
    except ImportError as exc:  # pragma: no cover - depends on env
        raise TriCountError(503, _TRICOUNT_MISSING) from exc

    if KISEKI_TRICOUNT_CREDS_FILE:
        path = Path(KISEKI_TRICOUNT_CREDS_FILE)
        try:
            return Credentials.load(path)
        except Exception as exc:
            raise TriCountError(
                503, f"Tricount credentials file unreadable: {path.name}"
            ) from exc
    return Credentials.generate()


def _client():
    """An authenticated TricountAPI client (auth happens per call — the
    session token is short-lived and the auth round trip is one POST)."""
    try:
        from tricount import TricountAPI
    except ImportError as exc:  # pragma: no cover - depends on env
        raise TriCountError(503, _TRICOUNT_MISSING) from exc

    client = TricountAPI(_load_credentials())
    try:
        client.authenticate()
    except Exception as exc:
        raise TriCountError(502, "Tricount authentication failed") from exc
    return client


# ------------------------------------------------------------------ fetch
def fetch_snapshot(registry_key: str, *, refresh: bool = False) -> TricountSnapshot:
    """Live (or TTL-cached) read of a registry, as a TricountSnapshot.

    Raises TriCountError(404) for an unknown registry key, 502 for upstream
    failures, 503 when the tricount package is missing.
    """
    key = registry_key.strip()
    if not key:
        raise TriCountError(422, "Empty Tricount registry key")

    if not refresh:
        cached = _cached(key)
        if cached is not None:
            return cached

    client = _client()
    try:
        tricount = client.get_tricount(key)
    except Exception as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status == 404:
            raise TriCountError(404, "No Tricount registry with that key") from exc
        raise TriCountError(502, "Tricount fetch failed") from exc
    return _store(key, _to_snapshot(tricount, key))


def _to_snapshot(tricount, key: str) -> TricountSnapshot:
    """Map the library's Tricount dataclass to the API snapshot model.

    Sign convention: the API stores expenses NEGATIVE and reimbursements
    positive. Everything served here is normalized to human terms — expense
    amounts positive, balance positive = is owed money.
    """
    members = [m for m in tricount.members if (m.status or "ACTIVE") == "ACTIVE"]
    name_by_uuid = {m.uuid: m.display_name for m in members}

    expenses: list[TricountExpense] = []
    balances = {m.display_name: 0.0 for m in members}
    for tx in sorted(tricount.transactions, key=lambda t: (t.date, t.description or "")):
        payer = name_by_uuid.get(tx.membership_uuid_owner, "?")
        total = abs(tx.amount.as_float)
        shares: dict[str, float] = {}
        for alloc in tx.allocations:
            member = name_by_uuid.get(alloc.membership_uuid)
            value = abs(alloc.amount.as_float)
            if member is None or value < 1e-9:
                continue  # zero-amount allocations are display noise
            shares[member] = shares.get(member, 0.0) + value
            balances[member] = balances.get(member, 0.0) - value
        balances[payer] = balances.get(payer, 0.0) + total
        expenses.append(
            TricountExpense(
                id=str(tx.uuid),
                date=(tx.date or "")[:10] or None,
                whoPaid=payer,
                amount=total,
                currency=tx.amount.currency or tricount.currency or "EUR",
                description=tx.description or None,
                category=tx.category_custom or tx.category or None,
                involved=sorted(shares),
                shareFor={m: round(v, 2) for m, v in shares.items()},
                type=tx.transaction_type.value
                if hasattr(tx.transaction_type, "value")
                else str(tx.transaction_type),
            )
        )

    return TricountSnapshot(
        registryKey=key,
        title=tricount.title or None,
        currency=tricount.currency or "EUR",
        members=[m.display_name for m in members],
        expenses=expenses,
        balances=[
            TricountBalance(member=name, amount=round(amount, 2), currency=tricount.currency or "EUR")
            for name, amount in sorted(balances.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        fetchedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )


def validate_registry_key(registry_key: str) -> TricountSnapshot:
    """Owner-facing connect validation: fetch the registry once (uncached).

    Confirms the key resolves before anything is written to the graph; the
    returned snapshot is discarded (the connect response carries the trip).
    """
    return fetch_snapshot(registry_key.strip(), refresh=True)


# ------------------------------------------------------------------ write
def connect_ops(practical_dict: dict | None, registry_key: str) -> dict:
    """The ``practical`` value with ``tricount`` set — for write.py to patch.

    Kept as a pure function so the write path stays testable without network.
    """
    practical = dict(practical_dict or {})
    practical["tricount"] = {"registryKey": registry_key.strip()}
    return practical


def disconnect_ops(practical_dict: dict | None) -> dict:
    """The ``practical`` value with ``tricount`` removed."""
    practical = dict(practical_dict or {})
    practical.pop("tricount", None)
    return practical
