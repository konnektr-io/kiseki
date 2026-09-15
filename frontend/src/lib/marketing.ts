import type { ShowcaseTrip } from "./types";

/**
 * Copy and ordering rules for the signed-out landing page (#249).
 *
 * WHAT IS DELIBERATELY NOT HERE: trips. This repo is public and carries no trip
 * data (`AGENTS.md`) — no titles, dates, crew names or media URLs — so the
 * examples band reads `GET /api/showcase` (public AND discoverable trips, as
 * cards) instead of a list committed beside the code. Two things fall out of
 * that, and both are wanted: the front door shows the real graph, and every
 * word in THIS file is static, so the marketing copy renders — and can be
 * prerendered for crawlers — with no network call at all.
 *
 * Copy rules (DESIGN.md §1): concrete, calm, no superlatives, no exclamation
 * marks, and nothing that has not shipped.
 */

export interface MarketingStep {
  key: string;
  title: string;
  body: string;
}

export const MARKETING_STEPS: MarketingStep[] = [
  {
    key: "describe",
    title: "Describe the trip",
    body: "Tell the assistant where you are going, who is coming and roughly when. A sentence is enough to start — it asks for what it still needs.",
  },
  {
    key: "build",
    title: "It builds the document",
    body: "Days, places, routes and practicals become one booklet: an itinerary you can read, the whole route on a map, and the details in one place instead of five conversations.",
  },
  {
    key: "alive",
    title: "It stays alive",
    body: "Dates move, bookings land, plans get dropped. The document updates as that happens — and still prints as a PDF when you want it on paper.",
  },
];

export interface MarketingFeature {
  key: string;
  title: string;
  body: string;
}

export const MARKETING_FEATURES: MarketingFeature[] = [
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
];

/**
 * The stage ladder, furthest-along first.
 *
 * Someone travelling *now* is the most convincing thing this page can show,
 * so `live` leads and a finished trip trails. Keyed by string rather than the
 * `Stage` union so an unknown stage from the graph sorts last instead of
 * crashing the page.
 */
const STAGE_WEIGHT: Record<string, number> = {
  live: 0,
  booked: 1,
  planned: 2,
  shortlist: 3,
  idea: 4,
  archive: 5,
};

/** Where an unrecognised stage lands: after everything we know, never dropped. */
const UNKNOWN_STAGE_WEIGHT = 99;

/**
 * Display order for the examples band — the ONE rule the page sorts by.
 *
 * Stage weight first, then the trip that starts soonest, then the title as a
 * stable tiebreak. Keeping this in one exported function is the point: when
 * someone asks "why is that trip first?", the answer is here, not spread
 * across the components that happen to render the cards.
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
