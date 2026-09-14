export type Stage =
  | "idea"
  | "options"
  | "shortlist"
  | "planned"
  | "booked"
  | "live"
  | "archive";

export type BlockKind =
  | "activity"
  | "transport"
  | "lodging"
  | "meal"
  | "todo"
  | "note"
  | "gallery"
  | "link"
  | "booking"
  | "custom";

export type BlockStatus = "planned" | "booked" | "done";
export type Role = "owner" | "editor" | "viewer" | "follower";
export type Visibility = "public" | "private";

export interface Link {
  label: string;
  url: string;
}

export interface TodoItem {
  label: string;
  done: boolean;
  when?: string;
}

export interface Block {
  id: string;
  kind: BlockKind;
  title?: string;
  time?: string;
  description?: string;
  links?: Link[];
  cost?: number;
  currency?: string;
  status?: BlockStatus;
  bookingCode?: string;
  order?: number;
  items?: string[] | TodoItem[] | { url: string }[];
  html?: string;
  distance?: string;
  duration?: string;
  route?: string;
  via?: string;
  from?: string;
  to?: string;
  mode?: "flight" | "drive" | "train" | "ferry";
  location?: string;
  /** Google place_id for THE specific venue — deliberately the SAME name as
   *  `TripLocation.placeId`, and the only deep-link key for the Google Maps
   *  link (keyless URL form; indefinitely cacheable, #15 rule). There is no
   *  free-text venue query field: unset means the link falls back to
   *  `location`/title as plain text. */
  placeId?: string;
  images?: string[];
}

export interface TodoItem {
  label: string;
  done: boolean;
  when?: string;
  links?: Link[];
}

export interface MetaItem {
  label: string;
  value: string;
}

export interface TripLocation {
  name: string;
  marker?: number;
  alias?: string[];
  lat?: number;
  lng?: number;
  /** Google place_id — the only third-party place key persisted indefinitely
   *  (#15 storage rule). Drives the keyless Google Maps deep link. */
  placeId?: string;
  address?: string;
  website?: string;
  phone?: string;
  openingHours?: string[];
  types?: string[];
  wheelchairAccessible?: boolean;
  /** Google rating snapshot — short-lived (≤30 days). The server strips it
   *  once the trip's `updated` is older than 30 days. */
  rating?: number;
  /** Editorial summary (the agent's own content, never Google text). */
  summary?: string;
  /** Rights-clean stored photo — bare media filename (canonicalized to
   *  /media/<trip_id>/<file> by the API) or an external image URL. NEVER a
   *  Google photo: Google imagery is a live web-only overlay (#15/#95). */
  photo?: string;
  /** Credit line for the stored photo, e.g. "Photo: Rusutsu Resort". */
  photoCredit?: string;
  /** License of the stored photo, e.g. "CC BY-SA 4.0". */
  photoLicense?: string;
  /** Source page URL of the stored photo (provenance, kept with the photo). */
  photoSourceUrl?: string;
}

export interface FeatureCard {
  title: string;
  value?: string;
  description?: string;
  image?: string;
  links?: Link[];
}

export interface Feature {
  kicker?: string;
  title: string;
  description?: string;
  image?: string;
  images?: string[];
  chips?: string[];
  cards?: FeatureCard[];
  map?: boolean;
  links?: Link[];
}

export interface Contact {
  label: string;
  value?: string;
  link?: string;
}

export interface Day {
  id: string;
  date: string; // ISO YYYY-MM-DD
  title: string;
  notes?: string;
  map?: string;
  meta?: MetaItem[];
  blocks: Block[];
}

export interface SectionFold {
  /** Card title for the folded group, e.g. "Heli Days 1–3". */
  title: string;
  /** Consecutive 0-based day indices folded into this card. */
  days: number[];
}

export interface TripSection {
  id: string;
  title: string;
  days: number[]; // inclusive [first,last] 0-based day indices this section groups
  locationRefs?: string[]; // location name/alias(es) this section covers
  blocks?: Block[]; // unscheduled ideas owned by this section (ideation content)
  fold?: SectionFold[]; // display-only: consecutive day groups as a single itinerary card
}

export interface Stat {
  label: string;
  value: string;
}

export interface Person {
  id: string;
  name: string;
  role: Role;
  note?: string;
  contact?: string;
  /** True when this crew entry is a claimed User (has an account), False for
   *  an unclaimed placeholder Person — drives the invite affordance. */
  claimed?: boolean;
}

export interface TripSummary {
  dtId: string;
  visibility: Visibility;
  title: string;
  subtitle?: string;
  stage: Stage;
  startDate?: string;
  endDate?: string;
  slug: string;
  cover?: string;
  role?: Role;
}

/* ---------------- #196d user profiles ----------------
 * Shapes of GET /api/users/{sub} (+ followers/following drill-ins).
 * The server omits `email` for anyone but the profile owner — the type
 * deliberately has NO email field, so the UI cannot render (or source)
 * another person's address even if a payload carried one. */

/** One trip summary inside a profile document — the server already applied
 *  the discoverable-only listing rule (discoverable, or the viewer has a
 *  role). Rendered verbatim: never filtered, never widened. `myRole` is
 *  absent when the viewer has no role on that trip. */
export interface ProfileTrip {
  dtId: string;
  title: string;
  subtitle?: string;
  stage: Stage;
  startDate?: string;
  endDate?: string;
  cover?: string;
  visibility: Visibility;
  discoverable?: boolean;
  myRole?: Role;
}

/* ---------------- #199 activity feed ---------------- */

/** What a feed row is about: a whole trip, or one write inside one. */
export type FeedKind = "trip" | "item";

/** Whose write it was: your own trip, or a trip of someone you follow. */
export type FeedSource = "my-trip" | "followed-user";

/**
 * One row of `GET /api/feed`, exactly as the server returns it.
 *
 * `at` is the raw stamp the graph wrote — the server owns the ordering, so the
 * SPA never re-derives it. An item row carries the `label` the server put in
 * words ("4 photos added") and its `thumbs` (`/media/<tripId>/<file>`): that is
 * the point of item granularity — a follower reads the photos in the feed.
 *
 * `href` is always a trip-id route (`/t/<tripId>`, `/t/<tripId>/day/<idx>`);
 * the repo-folder slug is not a route key anywhere in the app.
 */
export interface FeedEntry {
  kind: FeedKind;
  tripId: string;
  tripTitle: string;
  source: FeedSource;
  at?: string | null;
  by?: string | null;
  href: string;
  /** trip rows: the properties whose own write time is the newest. */
  changes?: string[];
  /** item rows: 0-based day index, its title, and what was written. */
  dayIndex?: number;
  dayTitle?: string;
  /** item rows: the block that moved (a day holds several). */
  blockTitle?: string;
  label?: string;
  thumbs?: string[];
}

/** The feed document, one page of it. */
export interface FeedDoc {
  generatedAt: string;
  /** Cursor for the next page; absent/null on the last page. */
  nextBefore?: string | null;
  items: FeedEntry[];
}

export interface UserProfile {
  sub: string;
  name: string;
  avatar?: string;
  /** Self-only opt-in flag (key absent for every other viewer). */
  publicName?: boolean;
  counts: { followers: number; following: number; trips: number };
  viewer: { isSelf: boolean; following: boolean };
  trips: ProfileTrip[];
}

/** One row of a followers/following drill-in — name + avatar only, no
 *  email, ever. `isSelf` marks the viewer's own row. */
export interface ProfilePerson {
  sub: string;
  name: string;
  avatar?: string;
  isSelf?: boolean;
}

/** Drill-in list: `count` is the TRUE total; `people` is capped at 200
 *  entries — when count exceeds the list, the UI must say so honestly. */
export interface PeopleList {
  count: number;
  people: ProfilePerson[];
}

/** Trip theming — the preset id is the whole contract (#40 follow-up).
 *  Retired per-trip override fields are not modelled; a document that still
 *  carries them is read as its preset only (see theme.tsx). */
export interface Theme {
  preset?: string | null;
}

export interface Practical {
  todos?: TodoItem[];
  links?: Link[];
  notes?: string;
  contacts?: Contact[];
  tricount?: TricountConfig;
}

export interface TricountConfig {
  registryKey: string;
}

export interface TricountExpense {
  id: string;
  date?: string;
  whoPaid: string;
  amount: number;
  currency: string;
  description?: string;
  category?: string;
  involved: string[];
  shareFor: Record<string, number>;
  type: string;
}

export interface TricountBalance {
  member: string;
  amount: number;
  currency: string;
}

export interface TricountSnapshot {
  registryKey: string;
  title?: string;
  currency: string;
  members: string[];
  expenses: TricountExpense[];
  balances: TricountBalance[];
  fetchedAt: string;
}

export interface Trip {
  id: string;
  slug: string;
  title: string;
  subtitle?: string;
  stage: Stage;
  startDate?: string;
  endDate?: string;
  timezone?: string; // IANA, e.g. "Asia/Tokyo" — trip-local "today", fallback viewer-local
  visibility: Visibility;
  myRole?: string;
  cover?: string;
  coverCredit?: string;
  map?: string;
  summary?: string;
  theme?: Theme;
  coverStats?: string[];
  locations?: TripLocation[];
  stats?: Stat[];
  features?: Feature[];
  sections?: TripSection[];
  crew: Person[];
  practical: { todos?: TodoItem[]; links?: Link[]; notes?: string; contacts?: Contact[]; tricount?: TricountConfig };
  days: Day[];
  updated?: string;
}
