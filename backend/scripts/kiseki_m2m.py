import json, os, sys, urllib.request, ssl

"""M2M token mint for Kiseki write API.

Reads KISEKI_AGENT_CLIENT_ID + KISEKI_AGENT_CLIENT_SECRET from env
(loaded from /opt/data/.env by the caller's environment).
The Auth0 token endpoint is hardcoded for the dev tenant.
"""

CLIENT_ID = os.environ.get("KISEKI_AGENT_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("KISEKI_AGENT_CLIENT_SECRET", "")
AUTH0_DOMAIN = "dev-zv5urb33g0msy7bc.eu.auth0.com"
AUDIENCE = "https://kiseki.konnektr.io"
BASE_URL = "https://kiseki.konnektr.io"

ctx = ssl.create_default_context()


def m2m_token() -> str:
    """Mint a client_credentials access token for the Kiseki write API."""
    if not CLIENT_ID or not CLIENT_SECRET:
        raise RuntimeError(
            "KISEKI_AGENT_CLIENT_ID + KISEKI_AGENT_CLIENT_SECRET must be in env"
        )
    payload = json.dumps({
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "audience": AUDIENCE,
    }).encode()
    req = urllib.request.Request(
        f"https://{AUTH0_DOMAIN}/oauth/token",
        data=payload, headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        return json.loads(resp.read())["access_token"]


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