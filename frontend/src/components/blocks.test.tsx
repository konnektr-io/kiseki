import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The prod bug this pins (#104): DayBlocks routes signed-in editors to
 * EditableBlockList, which used to DROP `letters` and `cardProps` — so on the
 * map surface, an editor's cards had no letter badge and no tap↔card wiring
 * while the same surface worked fine signed-out. The anonymous render path
 * was the only one the old smokes exercised, which is how the bug shipped.
 *
 * We render the REAL component tree (DayBlocks → EditableBlockList →
 * BlockView) with renderToString — no DOM needed to assert the contract — and
 * mock the Auth0 hook so useTripWrite's context requirement is satisfied.
 * Writes never fire in a server render. */
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
  }),
}));

// The lodging card embeds `TripMap` (MapLibre) and located cards embed a
// `MapView` minimap — that import chain pulls maplibre-gl +
// maplibre-contour, which don't resolve under node-env vitest. The map
// thumbnails are irrelevant to the letter/card wiring under test.
vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));

// DOMPurify needs a DOM and node-env SSR has none (`default.sanitize is not a
// function`), so the custom-block case in the #303 suite stubs it. Sanitizing
// itself is not what these tests are about — the server does it once at write
// (`app/sanitize.py`) and the browser probe exercises the real renderer.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

/* #286 wiring: `DayBlocks` → `BlockView` → `ActivityBlock` must pass the
 * block's STATUS down to PlaceFacts as `reviewsQuiet`. The live overlay is
 * mocked OFF for the whole file (every other assertion here is about static
 * facts + links — before this hook resolves the real one renders exactly the
 * same null) and switched ON per test in the done-collapse block below. */
const liveState: { current: unknown } = { current: null };
vi.mock("../lib/place-live", () => ({
  placePhotoUrl: (ref: string) => `/api/places/photo?ref=${encodeURIComponent(ref)}`,
  usePlaceLive: () => liveState.current,
}));

import { DayBlocks, resolveBlockPlace } from "./blocks";
import { GALLERY_PRINT_COUNT, PhotoLightbox, STRIP_PRINT_COUNT } from "./photos";
import { TripProvider } from "./theme";
import type { Block, BlockKind, Trip } from "../lib/types";

const trip = {
  id: "t1",
  slug: "test",
  title: "Test trip",
  stage: "booked",
  myRole: "owner",
  locations: [{ name: "Banff", lat: 51.18, lng: -115.57 }],
  days: [],
} as unknown as Trip;

const lodging: Block = {
  id: "b2",
  kind: "lodging",
  title: "Stay: Banff (2nd night)",
  order: 0,
} as unknown as Block;

function renderDayBlocks(props: Record<string, unknown>): string {
  const children = createElement(DayBlocks, props as never);
  return renderToString(
    createElement(TripProvider, {
      trip,
      apply: () => {},
      // A block card can carry an in-app content link (#301) — a router Link
      // needs a Router in the tree, exactly like the real app's.
      children: createElement(MemoryRouter, null, children),
    }),
  );
}

describe("DayBlocks editor mode keeps the map-surface card wiring (#104)", () => {
  it("stamps the letter badge and card props on an EDITOR's cards too", () => {
    const html = renderDayBlocks({
      blocks: [lodging],
      editable: true,
      containerId: "day-1",
      letters: new Map([["b2", "A"]]),
      cardProps: (b: Block) => ({
        "data-block-id": b.id,
        "data-active-block": "true",
      }),
    });
    // The letter badge renders (previously: editor cards had NO badge at all).
    expect(html).toContain("route-chip-badge");
    expect(html).toContain(">A<");
    // The tap↔card hooks survive (scroll target + active-card pulse attr).
    expect(html).toContain('data-block-id="b2"');
    expect(html).toContain('data-active-block="true"');
  });

  it("still renders plain cards when no letters are passed (booklet/today)", () => {
    const html = renderDayBlocks({
      blocks: [lodging],
      editable: true,
      containerId: "day-1",
    });
    expect(html).not.toContain("route-chip-badge");
    expect(html).not.toContain('data-block-id="b2"');
  });
});

/* Registry placeId wins on block Maps links + PlaceFacts render on day-view
 * cards (#place-facts): a block whose `location` (or title, via the #104
 * matcher) resolves to a registry place deep-links with that place's
 * place_id and carries the place facts above its own prose — and since the
 * card-polish pass the links-row Maps pill is SUPPRESSED when the block
 * resolves (PlaceFacts owns the canonical deep link), so exactly ONE
 * "Open in Google Maps" anchor renders per card. Unresolved blocks keep
 * their own location/placeId fallback pill.
 *
 * Pitfall 16: DayBlocks routes editors through EditableBlockList and viewers
 * through the plain list — both must render the same links + facts. */
const tripWithPlaces = {
  id: "t1",
  slug: "test",
  title: "Test trip",
  stage: "booked",
  myRole: "owner",
  locations: [
    {
      name: "Banff",
      lat: 51.18,
      lng: -115.57,
      placeId: "REGISTRY-PLACE-ID",
      address: "123 Mountain Ave, Banff AB",
      summary: "Home of the **powder**.",
    },
    { name: "Lake Louise", lat: 51.43, lng: -116.18, placeId: "LOUISE-PLACE-ID" },
  ],
  days: [],
} as unknown as Trip;

function renderWithPlaces(blocks: Block[], extra: Record<string, unknown> = {}): string {
  const children = createElement(DayBlocks, { blocks, ...extra } as never);
  return renderToString(
    createElement(TripProvider, {
      trip: tripWithPlaces,
      apply: () => {},
      children: createElement(MemoryRouter, null, children),
    }),
  );
}

describe("block Maps links resolve the registry place", () => {
  const located: Block = {
    id: "b10",
    kind: "activity",
    title: "Ski day",
    location: "Banff",
    order: 0,
  } as unknown as Block;

  it.each([true, false])(
    "uses the registry place_id + renders facts, with exactly ONE Maps anchor (editable: %s)",
    (editable) => {
      const html = renderWithPlaces(
        [located],
        editable ? { editable: true, containerId: "day-1" } : {},
      );
      // The links-row Maps pill is suppressed once the block resolves —
      // PlaceFacts owns the canonical place_id deep link …
      expect(html).not.toContain(">Google Maps<");
      expect(html.match(/Open in Google Maps/g) ?? []).toHaveLength(1);
      expect(html).toContain("query_place_id");
      expect(html).toContain("REGISTRY-PLACE-ID");
      // … and the place facts render above the block's own prose.
      expect(html).toContain("123 Mountain Ave, Banff AB");
      expect(html).toContain("<strong>powder</strong>");
    },
  );

  it("renders PlaceFacts above the block description (registry content first)", () => {
    const html = renderWithPlaces([
      {
        id: "b10n",
        kind: "activity",
        title: "Ski day",
        location: "Banff",
        description: "My own **note** on the day.",
        order: 0,
      } as unknown as Block,
    ]);
    expect(html).toContain("Open in Google Maps");
    expect(html).toContain("<strong>note</strong>");
    expect(html.indexOf("Open in Google Maps")).toBeLessThan(html.indexOf("<strong>note</strong>"));
  });

  it("keeps the query-only fallback when nothing resolves", () => {
    const html = renderWithPlaces([
      { id: "b11", kind: "activity", title: "Rest afternoon", order: 0 } as unknown as Block,
    ]);
    expect(html).toContain("Google Maps");
    expect(html).not.toContain("query_place_id");
    expect(html).not.toContain("Open in Google Maps");
    expect(html).not.toContain("123 Mountain Ave");
  });

  it("resolves the place through the block title (#104 matcher)", () => {
    const html = renderWithPlaces([
      { id: "b12", kind: "meal", title: "Dinner in Banff", order: 0 } as unknown as Block,
    ]);
    expect(resolveBlockPlace(tripWithPlaces, {
      id: "b12",
      kind: "meal",
      title: "Dinner in Banff",
    } as Block)?.name).toBe("Banff");
    expect(html).toContain("REGISTRY-PLACE-ID");
    expect(html).toContain("123 Mountain Ave, Banff AB");
  });

  it("suppresses the links-row Maps pill when the block resolves, even with its own placeId", () => {
    const html = renderWithPlaces([
      {
        id: "b13",
        kind: "activity",
        title: "Ski day",
        location: "Banff",
        placeId: "OWN-PLACE-ID",
        order: 0,
      } as unknown as Block,
    ]);
    // The resolved registry place owns the card's Maps anchor — the block's
    // own pinned venue id no longer gets a second pill …
    expect(html).not.toContain("OWN-PLACE-ID");
    expect(html).not.toContain(">Google Maps<");
    // … while the resolved registry place's own facts button keeps the
    // registry id (it links the place, not the block's venue).
    expect(html.match(/Open in Google Maps/g) ?? []).toHaveLength(1);
    expect(html).toContain("query_place_id=REGISTRY-PLACE-ID");
    expect(html).toContain("123 Mountain Ave, Banff AB");
  });

  it("keeps the block's own placeId fallback when nothing resolves", () => {
    const html = renderWithPlaces([
      {
        id: "b13b",
        kind: "activity",
        title: "Ski day",
        location: "Nowhereville",
        placeId: "OWN-PLACE-ID",
        order: 0,
      } as unknown as Block,
    ]);
    // No registry match — the links-row pill stays, deep-linking the pinned venue …
    expect(html).toContain(">Google Maps<");
    expect(html).toContain("query_place_id=OWN-PLACE-ID");
    // … and no PlaceFacts button renders (nothing resolved).
    expect(html).not.toContain("Open in Google Maps");
  });

  it("passes place ids on the drive-card directions link when both ends resolve", () => {
    const html = renderWithPlaces([
      {
        id: "b14",
        kind: "transport",
        title: "Drive to the lake",
        from: "Banff",
        to: "Lake Louise",
        order: 0,
      } as unknown as Block,
    ]);
    expect(html).toContain("origin_place_id");
    expect(html).toContain("REGISTRY-PLACE-ID");
    expect(html).toContain("destination_place_id");
    expect(html).toContain("LOUISE-PLACE-ID");
    // The human-readable queries stay alongside the ids.
    expect(html).toContain("Banff");
    expect(html).toContain("Lake Louise");
  });

  it("renders from → to in the title row with a single Directions CTA (card polish)", () => {
    const html = renderWithPlaces([
      {
        id: "b16",
        kind: "transport",
        title: "Drive to the lake",
        from: "Banff",
        to: "Lake Louise",
        duration: "1 h 35",
        order: 0,
      } as unknown as Block,
    ]);
    // Endpoints moved into the title row (pills + names with the → separator) …
    expect(html).toContain("Banff");
    expect(html).toContain("Lake Louise");
    expect(html).toContain("→");
    // … and the directions link is a single-label CTA (no trailing-tag game).
    expect(html).toContain(">Directions<");
    expect(html).not.toContain(">directions<");
    // SSR/print render shows the static values — live HERE time only ever
    // swaps in on the client (effects never run here or in the booklet PDF).
    expect(html).toContain("1 h 35");
    expect(html).not.toContain(">live<");
  });

  it("sends only the resolving end's place id on directions (mixed)", () => {
    const html = renderWithPlaces([
      {
        id: "b15",
        kind: "transport",
        title: "Drive in from nowhere",
        from: "Banff",
        to: "Nowhereville",
        order: 0,
      } as unknown as Block,
    ]);
    expect(html).toContain("origin_place_id");
    expect(html).toContain("REGISTRY-PLACE-ID");
    expect(html).not.toContain("destination_place_id");
    expect(html).toContain("travelmode");
  });
});

/* Photos: strip (A) + gallery (B), decision A+B (#190/#191, DESIGN.md §9).
 *
 * A photo that belongs to a block renders in that block's strip
 * (`Block.images`, now N instead of 1–2); the rest of the day renders as a
 * `gallery` block in chronological position. Both share one image component
 * (fixed aspect box + object-cover + lazy, no CLS — DESIGN.md §9), strip
 * overflow opens a screen-only lightbox, and print takes a stated cap with
 * a "+N more in the online album" line instead of letting the browser
 * decide (DESIGN.md §12). Pitfall 16/17: editor and anonymous branches must
 * render the same photos (EditableBlockList drops nothing). */
describe("photos: block strip (A) + day gallery (B) (#190/#191)", () => {
  const strip5 = [1, 2, 3, 4, 5].map((i) => `/media/t/strip${i}.jpg`);
  const gal8 = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `/media/t/gal${i}.jpg`);
  const activity: Block = {
    id: "bp1",
    kind: "activity",
    title: "Ski day",
    order: 0,
    images: strip5,
  } as unknown as Block;
  const gallery: Block = {
    id: "bg1",
    kind: "gallery",
    title: "Photos",
    order: 1,
    items: gal8,
  } as unknown as Block;

  it.each([true, false])(
    "strip renders the screen cap + a +N overflow into the lightbox (editable: %s)",
    (editable) => {
      const html = renderWithPlaces(
        [activity],
        editable ? { editable: true, containerId: "day-1" } : {},
      );
      // Screen shows the first 4; the 5th photo is one tap away, not 12 rows tall.
      // (React SSR splits text nodes with comments — match loosely.)
      for (const src of strip5.slice(0, 4)) expect(html).toContain(src);
      expect(html).toMatch(/\+\s*(<!-- -->)?1/);
      expect(html).toContain('aria-label="Show all 5 photos"');
      // Shared photo treatment: fixed aspect box, cover, lazy below the fold.
      expect(html).toContain("aspect-[4/3]");
      expect(html).toContain("object-cover");
      expect(html).toContain('loading="lazy"');
      // Lightbox chrome is screen-only; the dialog stays closed until tapped.
      expect(html).toContain("no-print");
      expect(html).not.toContain('role="dialog"');
    },
  );

  it("gallery renders the 2-up / 3-up grid in stored (capture-time) order", () => {
    const html = renderWithPlaces([gallery]);
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("md:grid-cols-3");
    const positions = gal8.map((src) => html.indexOf(src));
    expect(Math.min(...positions)).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("print takes a stated cap, never the whole roll", () => {
    const stripHtml = renderWithPlaces([activity]);
    // Strip print cap: capped photos render twice (screen button + print
    // figure); the overflow photo lives only in the lightbox (screen button
    // aria-label) — no print node.
    const occurrences = (html: string, src: string) => html.split(src).length - 1;
    expect(occurrences(stripHtml, strip5[0])).toBe(2);
    expect(occurrences(stripHtml, strip5[4])).toBe(0);
    expect(stripHtml).toContain('aria-label="Show all 5 photos"');
    // … and the booklet says where the rest lives.
    expect(stripHtml).toMatch(/\+\s*(<!-- -->)?1(<!-- -->)?\s*more in the online album/);
    expect(STRIP_PRINT_COUNT).toBe(4);

    const galHtml = renderWithPlaces([gallery]);
    // Gallery shares one node per photo across screen+print, so beyond-cap
    // nodes carry the print-hide class.
    const hiddenCount = (galHtml.match(/print:hidden/g) ?? []).length;
    expect(hiddenCount).toBe(gal8.length - GALLERY_PRINT_COUNT);
    expect(galHtml).toMatch(
      new RegExp(`\\+\\s*(<!-- -->)?${gal8.length - GALLERY_PRINT_COUNT}(<!-- -->)?\\s*more in the online album`),
    );
    expect(GALLERY_PRINT_COUNT).toBe(6);
  });

  it("lightbox shows one photo at a time with prev/next/close (screen-only chrome)", () => {
    const html = renderToString(
      createElement(PhotoLightbox, {
        images: strip5,
        index: 0,
        onClose: () => {},
        onIndex: () => {},
      }),
    );
    // Current photo only — prev/next swap the src client-side.
    expect(html).toContain(strip5[0]);
    expect(html).not.toContain(strip5[1]);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("no-print");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('aria-label="Previous photo"');
    expect(html).toContain('aria-label="Next photo"');
  });

  it("cards keep break-inside avoid so a photo never splits a page", () => {
    const html = renderWithPlaces([activity, gallery]);
    expect(html).toContain("booklet-keep");
  });
});

/* #286: the status is what decides the review treatment — a `done` activity
 * (this day already happened) collapses the Google snippet set behind one line,
 * while a `planned`/`booked`/unset block keeps the inline clamped snippet that
 * helps choose what to do. Wired by `reviewsQuiet={b.status === "done"}` in
 * blocks.tsx. */
describe("a DONE block quiets the whole live Google overlay (#286/#289)", () => {
  const LIVE = {
    available: true,
    placeId: "REGISTRY-PLACE-ID",
    rating: 4.4,
    userRatingCount: 1092,
    googleMapsUri: "https://maps.google.com/?cid=42",
    reviews: [
      { text: "Best powder in Hokkaido.", authorName: "Snow Fan" },
      { text: "Second.", authorName: "B" },
    ],
    photos: [{ name: "places/REGISTRY-PLACE-ID/photos/a", authorAttributions: [{ displayName: "Snow Fan" }] }],
  };
  const activityWith = (status?: Block["status"]): Block =>
    ({ id: "b20", kind: "activity", title: "Ski day", location: "Banff", status, order: 0 }) as unknown as Block;

  beforeEach(() => {
    liveState.current = LIVE;
  });
  afterEach(() => {
    liveState.current = null;
  });

  it("collapses the snippets when the block is done", () => {
    const html = renderWithPlaces([activityWith("done")]);
    // One line instead of a quote + author + disclosure…
    expect(html).toContain("Show 2 reviews from Google");
    expect(html).not.toContain("line-clamp-2");
    const disclosure = html.indexOf("<details");
    expect(disclosure).toBeGreaterThan(-1);
    expect(html.slice(0, disclosure)).not.toContain("Best powder in Hokkaido");
    // …while the rating survives as quiet text with the route out to Google
    // (one line, and "Open in Google Maps" above it stays the place deep link)…
    expect(html).toContain("reviews on Google");
    expect(html).toContain("1,092");
    expect(html).toContain(">4.4<");
    // …but the star icons (#289) and the Google photo are gone entirely.
    expect(html).not.toContain("Rated 4.4 out of 5");
    expect(html).not.toContain("/api/places/photo?ref=");
  });

  it("keeps the planning treatment for planned, booked, skipped and unset", () => {
    for (const status of ["planned", "booked", "skipped", undefined] as const) {
      const html = renderWithPlaces([activityWith(status)]);
      expect(html).toContain("line-clamp-2");
      expect(html).toContain("Best powder in Hokkaido.");
      expect(html).not.toContain("Show 2 reviews from Google");
      expect(html).toContain("Rated 4.4 out of 5");
      expect(html).toContain("/api/places/photo?ref=");
    }
  });
});

/* #385: a planned block that did not happen records `skipped` — honest
 * history, no false "done". The card renders muted (struck-through chip +
 * dimmed card) and the day keeps its planning review treatment (the traveller
 * did not do the thing, so the choosing aid stays loud). */
describe("a SKIPPED block stays visible but muted (#385)", () => {
  const skipped: Block = {
    id: "b21",
    kind: "activity",
    title: "Morning run",
    status: "skipped",
    order: 0,
  } as unknown as Block;

  it("renders a struck-through SKIPPED chip on a dimmed card", () => {
    const html = renderWithPlaces([skipped]);
    expect(html).toContain("SKIPPED");
    expect(html).toContain("line-through");
    expect(html).toContain("opacity-70");
  });
});

/* #301 — a content-supplied link that points back INTO the app must navigate
 * in-app. Every block link pill was a hardcoded
 * `<a target="_blank" rel="noreferrer">`, so the kiseki content-agent's
 * `/t/<trip_id>/day/<idx>` riding-log cards (and any other in-app target)
 * opened a second tab — Niko, verbatim: "the links open in a new tab, which is
 * not what we want." The rule is per TARGET, not per surface: an app route
 * renders as a router Link (same tab, client-side nav) and everything off-app
 * keeps the new-tab contract, which is right for Strava/YouTube/Maps.
 *
 * Negative control: against the ORIGINAL renderer (hardcoded `target="_blank"`)
 * every internal-target assertion below fails. */
const ANCHORS = /<a\b[^>]*>/g;

function anchorFor(html: string, href: string): string {
  const anchors = html.match(ANCHORS) ?? [];
  const hit = anchors.find((a) => a.includes(`href="${href}"`));
  expect(hit, `no anchor for ${href} — rendered: ${anchors.join(" ")}`).toBeTruthy();
  return hit as string;
}

describe("a block's content links follow their target (#301)", () => {
  const DAY = { label: "Open the day", url: "/t/t1/day/3" };
  const STRAVA = { label: "Strava", url: "https://www.strava.com/activities/9001" };

  it("keeps a card's in-app day link in the app, and external pills new-tab", () => {
    const html = renderWithPlaces([
      { id: "b30", kind: "activity", title: "Riding", order: 0, links: [DAY, STRAVA] } as unknown as Block,
    ]);
    expect(anchorFor(html, DAY.url)).not.toContain('target="_blank"');
    expect(anchorFor(html, STRAVA.url)).toContain('target="_blank"');
  });

  it("does it on the flight card too", () => {
    const html = renderWithPlaces([
      { id: "b31", kind: "transport", mode: "flight", title: "BRU → NRT", order: 0, links: [DAY] } as unknown as Block,
    ]);
    expect(anchorFor(html, DAY.url)).not.toContain('target="_blank"');
  });

  it("does it on the drive card too", () => {
    const html = renderWithPlaces([
      {
        id: "b32",
        kind: "transport",
        mode: "drive",
        title: "Drive to the trailhead",
        from: "Banff",
        to: "Lake Louise",
        order: 0,
        links: [DAY],
      } as unknown as Block,
    ]);
    expect(anchorFor(html, DAY.url)).not.toContain('target="_blank"');
  });

  it("does it in the links block too, keeping its off-app entries new-tab", () => {
    const html = renderWithPlaces([{ id: "b33", kind: "link", order: 0, links: [DAY, STRAVA] } as unknown as Block]);
    expect(anchorFor(html, DAY.url)).not.toContain('target="_blank"');
    expect(anchorFor(html, STRAVA.url)).toContain('target="_blank"');
  });
});

/* #303 — the itinerary and the day view must AGREE about which photos a day
 * has. The day-row collector (`dayThumbnails`) reads `block.images` on EVERY
 * kind, so a photo attached to a `note`/`transport` block becomes the day's
 * thumbnail in the list — while the day view rendered the shared media strip
 * on exactly three kinds (activity/lodging/meal) and silently dropped the rest.
 * The strip now renders ONCE, in the shared `BlockCard` wrapper, plus on the
 * two cards that are not `BlockCard`s (the dark transport card, the raw-HTML
 * custom block) — one decision, every kind.
 *
 * Negative control: against the ORIGINAL per-kind renderer every `toContain(src)`
 * below fails for the seven non-activity kinds. */
describe("the shared media strip renders on every block kind (#303)", () => {
  const IMG = (kind: string) => `/media/t/${kind}.jpg`;
  const cases: { kind: BlockKind; block: Partial<Block> }[] = [
    {
      kind: "transport",
      block: { mode: "drive", title: "Drive back to Annupuri", from: "Banff", to: "Lake Louise" },
    },
    { kind: "transport", block: { mode: "flight", title: "BRU → NRT" } },
    { kind: "todo", block: { title: "Pack", items: [{ label: "Skis", done: false }] } },
    { kind: "note", block: { title: "Out along the ridge", description: "Two shots from the ridge." } },
    { kind: "link", block: { links: [{ label: "Strava", url: "https://www.strava.com/activities/9001" }] } },
    { kind: "booking", block: { title: "Rental car", bookingCode: "ABC123" } },
    { kind: "gallery", block: { title: "Photos", items: ["/media/t/gal-item.jpg"] } },
    { kind: "custom", block: { html: "<p>Hand-written card.</p>" } },
  ];

  it.each(cases)("renders the block's photo on a $kind card", ({ kind, block }) => {
    const src = IMG(kind);
    const html = renderWithPlaces([
      { id: `k-${kind}`, kind, order: 0, images: [src], ...block } as unknown as Block,
    ]);
    // The same photo, in the same treatment as the three kinds that already
    // had it (shared strip: fixed 4:3 box, cover, lazy — DESIGN.md §9) …
    expect(html).toContain(src);
    expect(html).toContain("aspect-[4/3]");
    expect(html).toContain('loading="lazy"');
  });

  it("renders a gallery block's `images` alongside its `items`", () => {
    const html = renderWithPlaces([
      {
        id: "g1",
        kind: "gallery",
        title: "Photos",
        order: 0,
        images: ["/media/t/gal-strip.jpg"],
        items: ["/media/t/gal-item.jpg"],
      } as unknown as Block,
    ]);
    expect(html).toContain("/media/t/gal-strip.jpg");
    expect(html).toContain("/media/t/gal-item.jpg");
  });

  it("carries the location/track minimap fallback on the other kinds too", () => {
    // A `note` with a registry place — the minimap the day view never showed.
    const located = renderWithPlaces([
      { id: "n1", kind: "note", title: "Out along the ridge", location: "Banff", order: 0 } as unknown as Block,
    ]);
    expect(located).toContain("minimap");
    // A bare recorded track still earns its minimap (no registry place).
    const tracked = renderWithPlaces([
      { id: "td1", kind: "todo", title: "Pack", track: "ridge.gpx", order: 0 } as unknown as Block,
    ]);
    expect(tracked).toContain("minimap");
    // Photos win over the fallback — one strip, never two.
    const both = renderWithPlaces([
      {
        id: "n2",
        kind: "note",
        title: "Out along the ridge",
        location: "Banff",
        order: 0,
        images: ["/media/t/n2.jpg"],
      } as unknown as Block,
    ]);
    expect(both).toContain("/media/t/n2.jpg");
    expect(both).not.toContain("minimap");
  });

  it("keeps the GPX in the booklet when a block carries photos AND a track (#361 slice 5)", () => {
    // The defect: `cardMediaNode` returned the PhotoStrip first, so a
    // photo+track activity printed photos + stats but no track map. The fix
    // appends a print-only minimap after the photos — screen stays
    // photos-only (`hidden`), the booklet (`print:block`) keeps the track.
    // MapView is mocked to null here, so the wrapper div is the assertion.
    const html = renderWithPlaces([
      {
        id: "n4",
        kind: "activity",
        title: "Morning run with photos and GPX",
        location: "Banff",
        order: 0,
        images: ["/media/t/n4.jpg"],
        track: "morning-run.gpx",
      } as unknown as Block,
    ]);
    expect(html).toContain("/media/t/n4.jpg");
    expect(html).toContain("minimap");
    expect(html).toContain("print:block");
    // Photos first, track minimap after — the booklet order Niko asked for.
    expect(html.indexOf("/media/t/n4.jpg")).toBeLessThan(html.indexOf("minimap"));
    // Photo-only blocks are unchanged: no track, no extra minimap.
    const photosOnly = renderWithPlaces([
      {
        id: "n5",
        kind: "activity",
        title: "Photos, no GPX",
        location: "Banff",
        order: 0,
        images: ["/media/t/n5.jpg"],
      } as unknown as Block,
    ]);
    expect(photosOnly).toContain("/media/t/n5.jpg");
    expect(photosOnly).not.toContain("minimap");
  });

  it("renders the strip above the card's own body", () => {
    const html = renderWithPlaces([
      {
        id: "n3",
        kind: "note",
        title: "Out along the ridge",
        description: "Ridge line.",
        order: 0,
        images: ["/media/t/n3.jpg"],
      } as unknown as Block,
    ]);
    expect(html.indexOf("/media/t/n3.jpg")).toBeLessThan(html.indexOf("Out along the ridge"));
  });

  it("leaves a photo-less transport card's padding exactly as it was", () => {
    const html = renderWithPlaces([
      {
        id: "d1",
        kind: "transport",
        mode: "drive",
        title: "Drive",
        from: "Banff",
        to: "Lake Louise",
        order: 0,
      } as unknown as Block,
    ]);
    expect(html).toContain("flex items-start gap-3 p-4");
    expect(html).not.toContain("px-4 pt-4");
  });

  it("reserves the strip's padding on a transport card only when it has media", () => {
    const html = renderWithPlaces([
      {
        id: "d2",
        kind: "transport",
        mode: "drive",
        title: "Drive back to Annupuri",
        from: "Banff",
        to: "Lake Louise",
        order: 0,
        images: ["/media/t/d2.jpg"],
      } as unknown as Block,
    ]);
    expect(html).toContain("/media/t/d2.jpg");
    expect(html).toContain("px-4 pt-4");
    expect(html).not.toContain("flex items-start gap-3 p-4");
  });

  it("renders the strip on an EDITOR's card too (EditableBlockList drops nothing)", () => {
    const html = renderWithPlaces(
      [{ id: "n4", kind: "note", title: "Moment", order: 0, images: ["/media/t/n4.jpg"] } as unknown as Block],
      { editable: true, containerId: "day-1" },
    );
    expect(html).toContain("/media/t/n4.jpg");
  });
});
