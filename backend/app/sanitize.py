"""Server-side sanitization of `custom`-block HTML (issue #196, phase B).

`Block.html` is raw HTML rendered client-side (the frontend runs DOMPurify at
render: `frontend/src/components/blocks.tsx`) — and #195/spec §12 make
sanitization a precondition for public sharing. This module is the WRITE-path
gate: every `custom` block's `html` is cleaned once, at write
(`app/write.py::create_block` / `update_block` — which also covers bulk `fill`,
it funnels through the same endpoints), so what is stored is clean for every
reader. The client-side DOMPurify stays as a backstop; nothing re-sanitizes on
read and the policy lives in exactly one place (here).

Policy (nh3, an Ammonia port — never regexes):
- Tags: block + inline text tags, headings, lists, tables, `img`, `a`,
  `figure`, `video` (+ `source` so video has a playable child). No `script`,
  no `iframe`/`object`/`embed`/`form`, no `style` element (`<script>`/`<style>`
  drop tag AND content; other unknown tags strip but keep their text).
- Attributes: `class`/`style`/`title` anywhere; `href`/`target`/`rel` on `a`;
  `src`/`alt`/`width`/`height` on `img`; `src`/`poster`/`width`/`height`/
  `controls` on `video`; `src`/`type` on `source`; `colspan`/`rowspan`,
  `ol[start]`, `col[span]`. No `on*` handlers (never allow-listed, so kept
  attributes cannot smuggle one).
- URLs: `http`/`https`/`mailto` anywhere; `data:` ONLY as a base64-encoded
  image on an image source (`img[src]`, `video[poster]`, `source[src]` — gated
  by an attribute filter, so `data:text/html` in an `a[href]` is still
  dropped). No `javascript:` URLs.
- CSS: `style` values pass through ammonia's declaration filter against a
  tight allowlist of inert layout properties — `background:url(javascript:…)`
  loses the declaration. (Known wrinkle: `expression(...)` comes back
  syntactically mangled and inert — unbalanced parens cannot execute anywhere,
  IE included. The declaration survives textually; it cannot run.)
- `link_rel` is left off (None): DOMPurify does not inject `rel` either, so
  author bytes stay byte-stable and sanitizing twice is a no-op.
"""

from __future__ import annotations

import re

import nh3

# Block + inline text tags, headings, lists, tables, img, a, figure, video.
_CUSTOM_HTML_TAGS = {
    "div", "span", "p", "br", "hr",
    "blockquote", "pre", "code",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "col", "colgroup", "caption",
    "b", "i", "em", "strong", "u", "s", "small", "sub", "sup", "mark",
    "img", "a", "figure", "figcaption",
    "video", "source",
    "section", "article", "header", "footer", "aside", "details", "summary",
}

_CUSTOM_HTML_ATTRIBUTES = {
    "*": {"class", "style", "title"},
    "a": {"href", "title", "target", "rel"},
    "img": {"src", "alt", "title", "width", "height"},
    "video": {"src", "poster", "width", "height", "controls"},
    "source": {"src", "type"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
    "col": {"span"},
    "ol": {"start"},
}

_CUSTOM_HTML_SCHEMES = {"http", "https", "mailto", "data"}

# Inert layout/typography properties only — nothing that can carry a URL or
# behaviour (`background`, `position`, `animation`, … are all absent, so a
# `background:url(javascript:…)` declaration is dropped with its property).
_CUSTOM_HTML_STYLE_PROPS = {
    "color", "background-color",
    "font-size", "font-weight", "font-style", "text-decoration",
    "text-align",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border", "border-width", "border-style", "border-color", "border-radius",
    "width", "height", "max-width",
}

# `data:` is only ever an inline image: base64-encoded image/* on an image
# source attribute. Everything else with a `data:` URL loses the attribute
# (notably `data:text/html` in an `a[href]`).
_IMAGE_DATA_URL_RE = re.compile(r"^data:image/[a-zA-Z0-9.+-]+;base64,", re.IGNORECASE)
_IMAGE_SOURCE_ATTRS = {("img", "src"), ("video", "src"), ("video", "poster"), ("source", "src")}


def _attribute_filter(tag: str, attr: str, value: str) -> str | None:
    """nh3 attribute filter: return the value to keep, None to drop it.

    Returning `value` unchanged preserves nh3's default handling (including
    the URL-scheme check); only `data:` URLs are gated here.
    """
    if isinstance(value, str) and value.strip().lower().startswith("data:"):
        if (tag, attr) in _IMAGE_SOURCE_ATTRS and _IMAGE_DATA_URL_RE.match(value.strip()):
            return value
        return None
    return value


def sanitize_custom_html(html: str | None) -> str | None:
    """Clean a `custom` block's HTML fragment for storage (idempotent).

    None/empty pass through untouched (an explicit null still clears the
    field); anything else returns the sanitized fragment.
    """
    if not html:
        return html
    return nh3.clean(
        html,
        tags=_CUSTOM_HTML_TAGS,
        clean_content_tags={"script", "style"},
        attributes=_CUSTOM_HTML_ATTRIBUTES,
        attribute_filter=_attribute_filter,
        url_schemes=_CUSTOM_HTML_SCHEMES,
        filter_style_properties=_CUSTOM_HTML_STYLE_PROPS,
        link_rel=None,
    )
