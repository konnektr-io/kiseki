import type { ShowcaseTrip } from "./types";

/**
 * Copy and ordering rules for the signed-out landing page (#249).
 *
 * WHAT IS DELIBERATELY NOT HERE: trips. This repo is public and carries no trip
 * data (`AGENTS.md`) — no titles, dates, crew names or media URLs — so the
 * photographic bands read `GET /api/showcase` (public AND discoverable trips, as
 * cards) instead of a list committed beside the code. Two things fall out of
 * that, and both are wanted: the front door shows the real graph, and every word
 * in THIS file is static, so the copy renders — and can be prerendered for a
 * crawler — with no network call at all.
 *
 * Three rules the copy obeys, beyond DESIGN.md §1 (concrete, calm, no
 * superlatives, no exclamation marks, nothing that has not shipped):
 *
 * - **The spine is the trip's life, not the document's.** Six stages, crews,
 *   invites, a feed, discovery and print all shipped after "living document" was
 *   the whole product. That phrase is now one section — the document is what
 *   stays true, not what the product is for.
 * - **Photography leads, copy explains** (DESIGN.md §9). The hero and every band
 *   below it is a photograph with words on it, not a paragraph with a thumbnail.
 * - **No social proof we do not have.** No review counts, ratings, user numbers
 *   or testimonials — inventing them would be worth nothing, and DESIGN.md §1
 *   puts Kiseki on the other side of the consumer-travel-app fence.
 */

export interface MarketingStep {
  key: string;
  title: string;
  body: string;
}

/** The hero: the claim, and the two things a stranger can do about it. */
export const MARKETING_HERO = {
  kicker: "Trip documents for crews",
  headline: "Every trip, from first idea to printed book.",
  lede: "Plan the route with the people who are coming, keep it honest while you are away, and finish with something worth printing — one document per trip, instead of a plan in one app and the photos in another.",
  primaryCta: "Open a real trip",
  secondaryCta: "See how it works",
  /**
   * The message for the visitor who arrived on a link someone sent them — the
   * single most common way a stranger meets Kiseki. It must survive: reading a
   * trip needs no account.
   */
  guestNote: "Sent a trip link? Open it — reading a trip needs no account.",
} as const;

/**
 * What we can say about ourselves without inventing anything. Each of these is
 * checkable in the product: there is no advertising, the analytics SDK only
 * loads after the visitor allows it (`lib/posthog.ts` + `CookieConsent`), and a
 * trip is private to its crew until its owner publishes it (`discoverable`).
 */
export const MARKETING_TRUST = [
  "No ads",
  "Analytics only if you allow them",
  "Private until you say otherwise",
] as const;

/** The three beats of a trip's life. This is the page's spine. */
export const MARKETING_STEPS: MarketingStep[] = [
  {
    key: "idea",
    title: "It starts as an idea",
    body: "A sentence is enough. The trip is a document from its first line, so the plan you build later is an edit — never a rewrite.",
  },
  {
    key: "crew",
    title: "You plan it together",
    body: "Invite the people who are coming. They see this trip and nothing else of yours, and the plan stops living in five chat threads.",
  },
  {
    key: "keep",
    title: "You live it, then keep it",
    body: "Days fill in as they happen, photos land on the block they belong to, and the whole thing prints as a booklet at the end.",
  },
];

export interface MarketingFeature {
  key: string;
  title: string;
  body: string;
}

/** The parts every trip carries — a definition list, not an icon grid. */
export const MARKETING_INSIDE = {
  kicker: "What is inside",
  title: "Every trip carries the same parts.",
  items: [
    {
      key: "booklet",
      title: "A booklet, not a form",
      body: "Written to be read: on the phone while you travel, or printed for the road.",
    },
    {
      key: "map",
      title: "The whole route",
      body: "Every leg on one map, so the shape of the trip is visible at a glance.",
    },
    {
      key: "crew",
      title: "Crew and join links",
      body: "Invite the people coming. They see the trip — not your other trips.",
    },
    {
      key: "identity",
      title: "Its own look",
      body: "Each trip carries its own colour and type instead of one template for everything.",
    },
    {
      key: "assistant",
      title: "The assistant, in the trip",
      body: "Ask for a change in the trip's own chat, and the document follows.",
    },
    {
      key: "feed",
      title: "What your people are up to",
      body: "Follow the people you travel with and their trips show up in your feed.",
    },
  ] satisfies MarketingFeature[],
} as const;

/**
 * The one thing a consumer travel app has no answer to: the print artifact
 * (DESIGN.md §1 — "a printed travel booklet that happens to be alive", §12).
 */
export const MARKETING_BOOKLET = {
  kicker: "At the end",
  title: "Something you can hold.",
  body: "The booklet is generated from the same document you planned in — itinerary, route and photos, laid out for paper. Nothing is retyped, so the printout matches the trip that actually happened.",
} as const;

export const MARKETING_PRIVACY = {
  kicker: "Privacy",
  title: "Private until you say otherwise.",
  points: [
    {
      key: "default",
      title: "Private by default",
      body: "A new trip is visible to you and the crew you invite. Putting a trip on this front door is a deliberate opt-in, per trip.",
    },
    {
      key: "analytics",
      title: "Opt-in analytics, first-party",
      body: "The analytics SDK does not load until you allow it, and it sets one first-party cookie. No ads, no cross-site tracking.",
    },
    {
      key: "links",
      title: "A shared link stays read-only",
      body: "Anyone you send a trip link to can read that trip, and nothing else, without an account.",
    },
  ],
} as const;

export const MARKETING_CLOSING = {
  title: "Start with the trip you are already planning.",
  body: "Describe it once and let the document build itself while the plans firm up.",
} as const;

export const MARKETING_FOOTER = {
  left: "Kiseki 軌跡 — one document per trip",
  right: "Printed as a booklet. Private until you publish it.",
} as const;

/**
 * The stage ladder, furthest-along first.
 *
 * Someone travelling *now* is the most convincing thing this page can show, so
 * `live` leads and a finished trip trails. Keyed by string rather than the
 * `Stage` union so an unknown stage from the graph sorts last instead of
 * crashing the page.
 */
const STAGE_WEIGHT: Record<string, number> = {
  live: 0,
  booked: 1,
  planned: 2,
  shortlist: 3,
  options: 4,
  idea: 5,
  archive: 6,
};

/** Where an unrecognised stage lands: after everything we know, never dropped. */
const UNKNOWN_STAGE_WEIGHT = 99;

/**
 * Display order for the page — the ONE rule it sorts by.
 *
 * Stage weight first, then the trip that starts soonest, then the title as a
 * stable tiebreak. Keeping this in one exported function is the point: when
 * someone asks "why is that trip first?", the answer is here, not spread across
 * the components that happen to render the cards.
 */
export function sortShowcaseTrips(trips: readonly ShowcaseTrip[]): ShowcaseTrip[] {
  const weight = (trip: ShowcaseTrip) => STAGE_WEIGHT[trip.stage] ?? UNKNOWN_STAGE_WEIGHT;
  return [...trips].sort((a, b) => {
    const byStage = weight(a) - weight(b);
    if (byStage !== 0) return byStage;
    const startA = a.startDate ?? "";
    const startB = b.startDate ?? "";
    if (startA !== startB) return startA < startB ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * The trip the page leads with.
 *
 * One trip is *shown*, not just listed: it becomes the hero photograph and the
 * booklet's cover, so the lead has to be a trip that can carry a photograph.
 * A coverless trip still leads if it is all we have — the hero is designed to
 * work without an image (see `MarketingLanding`) and must never fall back to an
 * empty grey box.
 */
export function leadShowcaseTrip(trips: readonly ShowcaseTrip[]): ShowcaseTrip | null {
  return trips.find((trip) => Boolean(trip.cover)) ?? trips[0] ?? null;
}

/** A second trip for the closing band, so the page does not repeat one photo. */
export function closingShowcaseTrip(
  trips: readonly ShowcaseTrip[],
  lead: ShowcaseTrip | null,
): ShowcaseTrip | null {
  return trips.find((trip) => trip !== lead && Boolean(trip.cover)) ?? null;
}
