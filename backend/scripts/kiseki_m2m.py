"""M2M token mint for Kiseki write API.

Reads KISEKI_AGENT_CLIENT_ID + KISEKI_AGENT_CLIENT_SECRET from env (loaded from
/opt/data/.env by the caller's environment). The Auth0 token endpoint is
hardcoded for the dev tenant.

The token is cached on disk until it expires. Auth0 charges **every**
``client_credentials`` grant against the tenant's monthly M2M-token quota, so
minting one per API call burned ~780 grants in two weeks (2026-09) — the token
is valid 24 h, so those grants bought one and the same secret. The cache is
keyed by client_id+audience at the same path the agent-side ``mint_token.py``
uses (kiseki-trip-content skill), so scripted rounds and agent rounds share one
token.

Env: ``KISEKI_TOKEN_CACHE_DIR`` (default ``~/.cache/kiseki``),
``KISEKI_TOKEN_SKEW`` seconds of margin before expiry (default 300),
``KISEKI_TOKEN_NO_CACHE=1`` to always mint (debugging — it spends quota).
"""

import base64
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.request
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX host; the lock is a nicety
    fcntl = None

CLIENT_ID = os.environ.get("KISEKI_AGENT_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("KISEKI_AGENT_CLIENT_SECRET", "")
# The custom domain (not the raw tenant host): a token minted at the tenant
# host carries that host as `iss` and the backend — which validates the custom
# domain — rejects it.
AUTH0_DOMAIN = os.environ.get("AUTH0_DOMAIN", "auth.konnektr.io")
AUDIENCE = "https://kiseki.konnektr.io"
BASE_URL = "https://kiseki.konnektr.io"

DEFAULT_SKEW_S = 300

ctx = ssl.create_default_context()


def _cache_dir() -> Path:
    """Cache dir: ``KISEKI_TOKEN_CACHE_DIR`` or ``~/.cache/kiseki``."""
    override = os.environ.get("KISEKI_TOKEN_CACHE_DIR")
    return Path(override) if override else Path.home() / ".cache" / "kiseki"


def _cache_path(client_id: str, audience: str) -> Path:
    """One file per client+audience — the agent-side mint_token.py convention."""
    key = hashlib.sha256(f"{client_id}|{audience}".encode()).hexdigest()[:16]
    return _cache_dir() / f"m2m-{key}.json"


def token_exp(token: str) -> int:
    """``exp`` claim of a JWT, or 0 when it cannot be read."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return int(json.loads(base64.urlsafe_b64decode(payload))["exp"])
    except Exception:
        return 0


def _cached_token(path: Path) -> str | None:
    """The cached token, while it still has more than the safety skew left."""
    skew = int(os.environ.get("KISEKI_TOKEN_SKEW", DEFAULT_SKEW_S))
    try:
        entry = json.loads(path.read_text())
        token = entry.get("access_token") or ""
        exp = int(entry.get("exp") or token_exp(token))
    except Exception:
        return None
    return token if token and exp > time.time() + skew else None


def _store_token(path: Path, token: str, client_id: str, audience: str) -> None:
    """Write the cache entry owner-only, atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "access_token": token,
        "exp": token_exp(token),
        "client_id": client_id,
        "audience": audience,
        "minted_at": int(time.time()),
    }))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _grant(client_id: str, client_secret: str, audience: str) -> str:
    """One client_credentials grant — the quota-charged call."""
    payload = json.dumps({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "audience": audience,
    }).encode()
    req = urllib.request.Request(
        f"https://{AUTH0_DOMAIN}/oauth/token",
        data=payload, headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        return json.loads(resp.read())["access_token"]


def m2m_token(force: bool = False) -> str:
    """Kiseki write-API access token, reused from cache until it expires.

    One token serves every call until its 24 h expiry (5 min safety margin),
    because Auth0 charges each grant against the monthly M2M quota. Concurrent
    callers serialise on an flock, so a cold cache still costs a single grant.
    ``force=True`` / ``KISEKI_TOKEN_NO_CACHE=1`` always mints.
    """
    if not CLIENT_ID or not CLIENT_SECRET:
        raise RuntimeError(
            "KISEKI_AGENT_CLIENT_ID + KISEKI_AGENT_CLIENT_SECRET must be in env"
        )
    if force or os.environ.get("KISEKI_TOKEN_NO_CACHE") == "1":
        return _grant(CLIENT_ID, CLIENT_SECRET, AUDIENCE)

    path = _cache_path(CLIENT_ID, AUDIENCE)
    hit = _cached_token(path)
    if hit:
        return hit

    lock = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        lock = open(path.with_suffix(".lock"), "w")
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
    except Exception:
        lock = None  # unusable cache — mint without it rather than fail

    try:
        hit = _cached_token(path)  # another process may have filled it while we waited
        if hit:
            return hit
        token = _grant(CLIENT_ID, CLIENT_SECRET, AUDIENCE)
        try:
            _store_token(path, token, CLIENT_ID, AUDIENCE)
        except Exception:
            pass  # a cache write must never fail a scripted round
        return token
    finally:
        if lock is not None:
            try:
                if fcntl:
                    fcntl.flock(lock, fcntl.LOCK_UN)
                lock.close()
            except Exception:
                pass


def api(method: str, path: str, body: dict | None = None) -> dict:
    """Call the Kiseki write API. Returns parsed JSON."""
    token = m2m_token()
    hdrs = {
        "x-user-id": "google-oauth2|100613034256980569871",
        "Authorization": f"Bearer {token}",
        "content-type": "application/json",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=data, method=method, headers=hdrs,
    )
    with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
        return json.loads(resp.read())


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"usage: {sys.argv[0]} <method> <path> [--json <body>]")
        sys.exit(1)
    method, path = sys.argv[1], sys.argv[2]
    body = None
    if "--json" in sys.argv:
        idx = sys.argv.index("--json")
        body = json.loads(sys.argv[idx + 1])
    print(json.dumps(api(method, path, body), indent=2))
