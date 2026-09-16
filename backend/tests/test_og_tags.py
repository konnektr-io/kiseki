"""Link previews (issue #313): per-route Open Graph tags + resized covers.

WhatsApp/Telegram never run JS, so the card comes from the shell's <meta>
tags: /t/<id> names a PUBLIC trip (private stays generic — no title leak),
/join/<token> names the trip for the invited holder (join vs follow copy),
everything else keeps the absolute-URL generic fallback. og:image points at
the /api/og-image/… routes, which serve a 1200×630 JPEG (covers are ~640KB
live — bigger than WhatsApp reliably previews).
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import claims as claims_module
from app import main as main_mod
from app import store as store_mod
from app.graph.convert import graph_to_trip
from app.main import app
from fake_graph import FakeGraph
from test_follow_197 import CLAIM_TOKEN  # the anon fixture's Trip twin claim token

FOLLOW_TOKEN = "og-test-follow-token-001"  # set onto the twin by these tests

SHELL = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Kiseki — plan a trip with your crew</title>
    <meta
      name="description"
      content="generic description"
    />
    <meta property="og:site_name" content="Kiseki" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Kiseki — plan it together. Live it for real." />
    <meta
      property="og:description"
      content="generic og description"
    />
    <meta property="og:image" content="/logo-mark.png" />
    <meta property="og:image:alt" content="Kiseki alt" />
    <meta property="og:image:width" content="512" />
    <meta property="og:image:height" content="512" />
    <meta name="twitter:card" content="summary" />
  </head>
  <body></body>
</html>
"""

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean():
    main_mod._reset_og_image_cache()
    yield
    main_mod._reset_og_image_cache()


@pytest.fixture
def graph(monkeypatch: pytest.MonkeyPatch):
    made: list[FakeGraph] = []

    def _make(visibility: str = "public") -> FakeGraph:
        g = FakeGraph()
        g.add_user_role(g.root, "google-oauth2|1234567890", "owner")
        g.set_twin_prop(g.root, "visibility", visibility)
        monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
        monkeypatch.setattr(claims_module, "get_graph_client", lambda: g)
        made.append(g)
        return g

    yield _make
    for _ in made:
        store_mod._reset_store_cache()


def _trip_id(g: FakeGraph) -> str:
    return graph_to_trip(g.fetch_graph(g.root)).id


def _cover_bytes(w: int = 2000, h: int = 1000) -> bytes:
    img = Image.new("RGB", (w, h), (180, 40, 40))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


class _FakeStore:
    def __init__(self, payload: bytes | None):
        self.payload = payload
        self.calls = 0

    def get(self, key, start=None, length=None):
        self.calls += 1
        if self.payload is None:
            return None
        yield self.payload


def _serve(monkeypatch: pytest.MonkeyPatch, payload: bytes | None) -> _FakeStore:
    store = _FakeStore(payload)
    monkeypatch.setattr(main_mod, "get_media_store", lambda: store)
    return store


# ------------------------------------------- card resolution (/t/ + /join/)

def test_public_trip_link_gets_trip_card(graph) -> None:
    g = graph(visibility="public")
    card = main_mod._og_card_for_path(f"t/{_trip_id(g)}")
    assert card is not None
    assert card["title"] == "Canada Heliski + Resort Trip"
    assert "Powder Highway" in card["description"]
    assert card["image"].startswith("https://")
    assert "/api/og-image/t/" in card["image"]
    assert card["large"] is True


def test_public_trip_deep_link_gets_trip_card(graph) -> None:
    g = graph(visibility="public")
    card = main_mod._og_card_for_path(f"t/{_trip_id(g)}/day/3")
    assert card is not None
    assert card["title"] == "Canada Heliski + Resort Trip"


def test_private_trip_link_stays_generic(graph) -> None:
    g = graph(visibility="private")
    assert main_mod._og_card_for_path(f"t/{_trip_id(g)}") is None
    html = main_mod._og_shell(SHELL, f"t/{_trip_id(g)}")
    assert "Canada Heliski" not in html
    assert main_mod._OG_FALLBACK_TITLE in html


def test_unknown_trip_link_stays_generic(graph) -> None:
    graph(visibility="public")
    assert main_mod._og_card_for_path("t/00000000-0000-0000-0000-000000000000") is None


def test_claim_token_gets_join_card(graph) -> None:
    g = graph(visibility="private")  # even a private trip: the holder is invited
    card = main_mod._og_card_for_path(f"join/{CLAIM_TOKEN}")
    assert card is not None
    assert card["title"] == "Canada Heliski + Resort Trip"
    assert "invited to join" in card["description"]
    assert f"/api/og-image/join/{CLAIM_TOKEN}" in card["image"]


def test_follow_token_gets_follow_card(graph, monkeypatch) -> None:
    g = graph(visibility="private")
    g.set_twin_prop(g.root, "followToken", FOLLOW_TOKEN)
    monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
    monkeypatch.setattr(claims_module, "get_graph_client", lambda: g)
    card = main_mod._og_card_for_path(f"join/{FOLLOW_TOKEN}")
    assert card is not None
    assert "invited to follow" in card["description"]
    assert "invited to join" not in card["description"]


def test_unknown_token_stays_generic(graph) -> None:
    graph(visibility="public")
    assert main_mod._og_card_for_path("join/not-a-real-token") is None


def test_non_trip_paths_stay_generic(graph) -> None:
    graph(visibility="public")
    for path in ("", "/", "me", "feed", "u/google-oauth2%7C123", "join"):
        assert main_mod._og_card_for_path(path) is None, path


def test_card_escapes_html(graph) -> None:
    g = graph(visibility="public")
    g.set_twin_prop(g.root, "title", 'Evil <script>alert("x")</script> trip')
    html = main_mod._og_shell(SHELL, f"t/{_trip_id(g)}")
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


def test_description_falls_back_to_summary(graph) -> None:
    g = graph(visibility="public")
    g.set_twin_prop(g.root, "subtitle", "")
    card = main_mod._og_card_for_path(f"t/{_trip_id(g)}")
    assert card is not None
    # summary is markdown — the card carries plain text, truncated
    assert "**" not in card["description"]
    assert len(card["description"]) <= main_mod._OG_DESC_LIMIT + 1


def test_plain_text_strips_markdown() -> None:
    text = main_mod._og_plain_text("See [Selkirk](https://example.com/x) **powder**!\n\nNext line.")
    assert text == "See Selkirk powder! Next line."


# ------------------------------------------------------- shell injection

def test_shell_injection_sets_absolute_tags(graph) -> None:
    g = graph(visibility="public")
    trip_id = _trip_id(g)
    html = main_mod._og_shell(SHELL, f"t/{trip_id}")
    assert 'property="og:title" content="Canada Heliski + Resort Trip"' in html
    assert 'property="og:url" content="https://kiseki.konnektr.io/t/' + trip_id + '"' in html
    assert 'name="twitter:card" content="summary_large_image"' in html
    assert 'property="og:image:width" content="1200"' in html
    assert "/logo-mark.png" not in html  # relative fallback gone on a trip card


def test_landing_shell_gets_absolute_fallback(graph) -> None:
    graph(visibility="public")
    html = main_mod._og_shell(SHELL, "")
    assert 'property="og:image" content="https://kiseki.konnektr.io/logo-mark.png"' in html
    assert 'property="og:url" content="https://kiseki.konnektr.io/"' in html


def test_real_index_html_injects_cleanly(graph) -> None:
    """The repo's actual shell (build input) rewrites without leftovers."""
    from pathlib import Path

    src = (Path(main_mod.__file__).resolve().parent.parent.parent / "frontend" / "index.html").read_text()
    g = graph(visibility="public")
    html = main_mod._og_shell(src, f"t/{_trip_id(g)}")
    assert "Canada Heliski + Resort Trip" in html
    assert 'content="/logo-mark.png"' not in html
    assert html.count('property="og:title"') == 1
    assert html.count('property="og:url"') == 1


# ------------------------------------------------------- og-image routes

def test_og_image_serves_resized_cover(graph, monkeypatch) -> None:
    g = graph(visibility="public")
    store = _serve(monkeypatch, _cover_bytes())
    r = client.get(f"/api/og-image/t/{_trip_id(g)}")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/jpeg"
    assert r.headers["cache-control"] == "public, max-age=86400"
    with Image.open(io.BytesIO(r.content)) as im:
        assert im.size == (1200, 630)
    assert store.calls == 1


def test_og_image_caches_render(graph, monkeypatch) -> None:
    g = graph(visibility="public")
    store = _serve(monkeypatch, _cover_bytes())
    trip_id = _trip_id(g)
    assert client.get(f"/api/og-image/t/{trip_id}").status_code == 200
    assert client.get(f"/api/og-image/t/{trip_id}").status_code == 200
    assert store.calls == 1


def test_og_image_private_trip_404s(graph, monkeypatch) -> None:
    g = graph(visibility="private")
    _serve(monkeypatch, _cover_bytes())
    assert client.get(f"/api/og-image/t/{_trip_id(g)}").status_code == 404


def test_og_image_unknown_trip_404s(graph, monkeypatch) -> None:
    graph(visibility="public")
    _serve(monkeypatch, _cover_bytes())
    assert client.get("/api/og-image/t/00000000-0000-0000-0000-000000000000").status_code == 404


def test_og_image_no_cover_404s(graph, monkeypatch) -> None:
    g = graph(visibility="public")
    g.set_twin_prop(g.root, "cover", None)
    _serve(monkeypatch, _cover_bytes())
    assert client.get(f"/api/og-image/t/{_trip_id(g)}").status_code == 404


def test_og_image_store_miss_404s_not_500(graph, monkeypatch) -> None:
    g = graph(visibility="public")
    _serve(monkeypatch, None)
    assert client.get(f"/api/og-image/t/{_trip_id(g)}").status_code == 404


def test_og_image_unreadable_bytes_404(graph, monkeypatch) -> None:
    g = graph(visibility="public")
    _serve(monkeypatch, b"this is not an image")
    assert client.get(f"/api/og-image/t/{_trip_id(g)}").status_code == 404


def test_og_image_join_token_serves_cover(graph, monkeypatch) -> None:
    g = graph(visibility="private")
    _serve(monkeypatch, _cover_bytes())
    r = client.get(f"/api/og-image/join/{CLAIM_TOKEN}")
    assert r.status_code == 200, r.text
    with Image.open(io.BytesIO(r.content)) as im:
        assert im.size == (1200, 630)


def test_og_image_unknown_token_404s(graph, monkeypatch) -> None:
    graph(visibility="public")
    _serve(monkeypatch, _cover_bytes())
    assert client.get("/api/og-image/join/not-a-real-token").status_code == 404
