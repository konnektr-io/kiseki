#!/usr/bin/env python3
"""Write the 3 missing Peru drive cards for chile-peru trip 6b11a061."""
import json, os, sys, urllib.request, ssl

ctx = ssl.create_default_context()
CLIENT_ID = os.environ["KISEKI_AGENT_CLIENT_ID"]
CLIENT_SECRET = os.environ["KISEKI_AGENT_CLIENT_SECRET"]
AUTH0_DOMAIN = os.environ.get("AUTH0_DOMAIN", "auth.konnektr.io")
AUDIENCE = "https://kiseki.konnektr.io"
BASE_URL = "https://kiseki.konnektr.io"
ACT_AS = "google-oauth2|100613034256980569871"

def m2m_token():
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

def api(method, path, body=None):
    tok = m2m_token()
    hdrs = {
        "x-user-id": ACT_AS,
        "Authorization": f"Bearer {tok}",
        "content-type": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=data, method=method, headers=hdrs,
    )
    with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
        return json.loads(resp.read())

TRIP = "6b11a061-54c8-401e-9861-855dea2f7338"

# Day ids from live GET
DAY_PISAC = "da1ffb91-0cc0-4a79-b0c3-331103edd946"      # Day 9
DAY_MPU = "3dbc864b-e992-4002-aa18-d943a2dddf92"        # Day 11
DAY_CUSCO = "290e5f3d-3b82-452e-8d22-5b20b04e1df8"      # Day 12

results = []

# 1) Day 9 — Sacred Valley → Machu Picchu (via Urubamba road)
b1 = api("POST", f"/api/trips/{TRIP}/blocks", {
    "container": {"type": "day", "id": DAY_PISAC},
    "kind": "transport",
    "title": "Sacred Valley → Machu Picchu",
    "from": "Sacred Valley", "to": "Machu Picchu",
    "via": "Urubamba", "mode": "drive", "status": "planned",
})
results.append(("SV→MP", b1.get("id"), b1.get("title")))
print(f"✓ Block 1: {b1.get('id')[:8]} — {b1.get('title')}")

# 2) Day 11 — Machu Picchu → Cusco
b2 = api("POST", f"/api/trips/{TRIP}/blocks", {
    "container": {"type": "day", "id": DAY_MPU},
    "kind": "transport",
    "title": "Machu Picchu → Cusco",
    "from": "Machu Picchu", "to": "Cusco",
    "mode": "drive", "status": "planned",
})
results.append(("MP→Cusco", b2.get("id"), b2.get("title")))
print(f"✓ Block 2: {b2.get('id')[:8]} — {b2.get('title')}")

# 3) Day 12 — Cusco → Sacred Valley (via Urubamba road)
b3 = api("POST", f"/api/trips/{TRIP}/blocks", {
    "container": {"type": "day", "id": DAY_CUSCO},
    "kind": "transport",
    "title": "Cusco → Sacred Valley",
    "from": "Cusco", "to": "Sacred Valley",
    "via": "Urubamba", "mode": "drive", "status": "planned",
})
results.append(("Cusco→SV", b3.get("id"), b3.get("title")))
print(f"✓ Block 3: {b3.get('id')[:8]} — {b3.get('title')}")

# Verify: show all transport blocks on the trip
trip = api("GET", f"/api/trips/{TRIP}")
print("\nAll transport blocks after write:")
for day in trip["days"]:
    for b in day.get("blocks", []):
        if b["kind"] == "transport":
            print(f"  {day['date']} {b['id'][:8]} {b.get('from','') or '(none)':12} → {b.get('to','') or '(none)':12} mode={b.get('mode',''):6} {b.get('title','')[:45]}")

print(f"\nDone — {len(results)} blocks added.")