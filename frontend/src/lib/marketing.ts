import type { Stage } from "./types";

/**
 * Copy and content for the signed-out landing page (#249).
 *
 * WHAT IS DELIBERATELY NOT HERE: real trips. This repo is public (`AGENTS.md`),
 * and the first version of this page proved why the rule matters: it linked to the
 * owner's real trips, and a stranger following a link landed on booking codes,
 * costs and a checklist naming balances. A landing page is the worst place for
 * anybody's paperwork.
 *
 * So the page shows an example trip — invented, with nobody's content in it, built
 * from copy in this file plus photographs the owner has declared rights-free
 * (`frontend/public/marketing/CREDITS.md`). Three consequences, all wanted:
 *
 * - the page renders with NO network call of its own (so a prerender carries all of it),
 * - there is no `discoverable` trip, no real URL and no crew name anywhere in it,
 * - and it cannot degrade: nothing is fetched, so nothing can be missing.
 *
 * The example is NOT captioned as an example. A note explaining that the trip is
 * fiction is a note to the reviewer, not copy for a stranger — the band is a view of
 * the product, the way a screenshot is, and the page claims nothing about it that
 * would need correcting. Where the honesty belongs is here and in CREDITS.md.
 *
 * `GET /api/showcase` still exists and still serves the real graph — the signed-in
 * discovery home reads it next. This page just stops advertising people's trips.
 *
 * Copy rules (DESIGN.md §1): concrete, calm, no superlatives, no exclamation marks,
 * nothing that has not shipped. And no social proof we do not have.
 */

export interface MarketingStep {
  key: string;
  title: string;
  body: string;
}

/** The hero: the claim, and the two things a stranger can do about it. */
export const MARKETING_HERO = {
  kicker: "Trip documents for crews",
  /**
   * Print is deliberately NOT in the headline. The booklet is a real feature and
   * the one artifact no consumer travel app answers, but it is the *end* of a
   * trip: leading with it made the page about paper instead of about the trip.
   * It survives as one stage, one band and one line in "what is inside".
   */
  headline: "Plan it together. Live it for real.",
  lede: "The route, the days, the places and the people in one document — kept up to date while you travel, and printed as a booklet when you are home.",
  secondaryCta: "See what a trip looks like",
  /** For the visitor who arrived on a link someone sent them. Reading needs no account. */
  guestNote: "Sent a trip link? Open it — reading a trip needs no account.",
} as const;

/**
 * What we can say about ourselves without inventing anything. Each is checkable in
 * the product: there is no advertising, the analytics SDK only loads after the
 * visitor allows it (`lib/posthog.ts` + `CookieConsent`), a trip is private to its
 * crew until its owner publishes it, and — since v0.41.1 — a reader without a crew
 * role gets no booking code, no cost and no checklist (see `_public_trip`).
 */
export const MARKETING_TRUST = [
  "No ads",
  "Opt-in analytics",
  "Booking codes stay with the crew",
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

/** One row in the example day — the same shape a real block renders in. */
export interface DemoRow {
  time: string;
  kind: string;
  title: string;
  body?: string;
  photo?: { src: string; alt: string };
  chip?: string;
}

/** A stop the example map draws a pin for. Real coordinates, invented itinerary. */
export interface DemoStop {
  name: string;
  lng: number;
  lat: number;
}

/**
 * The example trip, as the app would render it.
 *
 * The photographs are the owner's rights-free ones (see CREDITS.md) and the stops
 * are real Tokyo places — geocoded, so the map's pins land where their labels say.
 * The itinerary joining them is invented, and `frontend/src/components/LandingMap.tsx`
 * draws it straight from stop to stop rather than spending a routing call on it.
 */
export interface MarketingDemo {
  kicker: string;
  title: string;
  trip: { title: string; meta: string; stage: Stage };
  day: { label: string; title: string; rows: DemoRow[] };
  crew: { label: string; initials: string[]; note: string };
  route: { label: string; title: string; body: string; stops: DemoStop[] };
}

export const MARKETING_DEMO: MarketingDemo = {
  kicker: "In the app",
  title: "Nine days in Tokyo.",
  trip: {
    title: "Nine days in Tokyo",
    meta: "Planned · 9 days · Mar 2027",
    stage: "planned" as const,
  },
  day: {
    label: "Day 3",
    title: "Golden Gai, and a slow morning",
    rows: [
      {
        time: "09:00",
        kind: "Activity",
        title: "Coffee in Shinjuku Gyoen",
        body: "Gate opens at nine. Walk the pond loop before the crowds and let the city start without you.",
        photo: {
          src: "/marketing/day-garden.jpg",
          alt: "A quiet garden pond and footbridge with a skyscraper behind the trees",
        },
      },
      {
        time: "20:00",
        kind: "Activity",
        title: "Golden Gai — six seats and a jukebox",
        body: "Pick a bar by the signboard. Cash only, and nobody minds if you stay for one more.",
        photo: {
          src: "/marketing/day-alley.jpg",
          alt: "A narrow lantern-lit alley of tiny bars at night",
        },
      },
      {
        time: "—",
        kind: "Lodging",
        title: "Stay: Shinjuku, four nights",
        body: "Booked in advance, confirmation on file with the trip.",
        chip: "Booked · confirmation on file",
      },
    ],
  },
  crew: {
    label: "Crew",
    initials: ["A", "M", "R"],
    note: "Everyone on the trip opens the same link — reading needs no account.",
  },
  route: {
    label: "The map",
    title: "The whole route on one map",
    body: "Legs, stays and day trips on one map, so the shape of the trip is visible before anything is booked.",
    stops: [
      { name: "Shinjuku Gyoen", lng: 139.70955, lat: 35.68507 },
      { name: "Yanaka", lng: 139.76856, lat: 35.72479 },
      { name: "Kōenji", lng: 139.64991, lat: 35.70494 },
      { name: "Shibuya", lng: 139.7005, lat: 35.6595 },
      { name: "Golden Gai", lng: 139.7047, lat: 35.69399 },
    ],
  },
};

export interface MarketingFeature {
  key: string;
  title: string;
  body: string;
}

/**
 * The parts every trip carries — a definition list, not an icon grid. Print is
 * one entry here, which is where a secondary feature belongs.
 */
export const MARKETING_INSIDE = {
  kicker: "What is inside",
  title: "Every trip carries the same parts.",
  items: [
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
      key: "feed",
      title: "What your people are up to",
      body: "Follow the people you travel with and their trips show up in your feed.",
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
      key: "booklet",
      title: "A booklet at the end",
      body: "When the trip is over it prints — written to be read on the road, and to keep.",
    },
  ] satisfies MarketingFeature[],
} as const;

export const MARKETING_BOOKLET = {
  kicker: "At the end",
  title: "Something you can hold.",
  body: "The booklet is generated from the same document you planned in, so nothing is retyped and the printout matches the trip that actually happened.",
} as const;

export const MARKETING_PRIVACY = {
  kicker: "Privacy",
  title: "Private until you say otherwise.",
  points: [
    {
      key: "default",
      title: "Private by default",
      body: "A new trip is visible to you and the crew you invite. Publishing one is a deliberate choice, made per trip.",
    },
    {
      key: "paperwork",
      title: "The paperwork stays with the crew",
      body: "Booking codes, costs and the pre-trip checklist are visible to the crew only. A trip that is public shows its route, days, places and photos — not what anyone paid.",
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
 * The stage ladder, furthest-along first — the display rule for a list of
 * discoverable trips.
 *
 * NOT used by this page any more (it shows an example, not the graph). It stays
 * because it is the ordering the signed-in discovery home reads off
 * `GET /api/showcase`, and because the rule is worth having in one exported place
 * rather than re-derived: `live` leads, a finished trip trails, and an unknown
 * stage from the graph sorts last instead of crashing the page.
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
 * The minimum a trip list needs to be orderable. Generic (not `ShowcaseTrip`)
 * since #249 slice 2: the signed-in home sorts `TripSummary` lists with the
 * same comparator, and a second sort would be a second answer to "why is this
 * first?".
 */
export interface OrderableTrip {
  stage: string;
  startDate?: string | null;
  title: string;
}

export function sortShowcaseTrips<T extends OrderableTrip>(trips: readonly T[]): T[] {
  const weight = (trip: T) => STAGE_WEIGHT[trip.stage] ?? UNKNOWN_STAGE_WEIGHT;
  return [...trips].sort((a, b) => {
    const byStage = weight(a) - weight(b);
    if (byStage !== 0) return byStage;
    const startA = a.startDate ?? "";
    const startB = b.startDate ?? "";
    if (startA !== startB) return startA < startB ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
