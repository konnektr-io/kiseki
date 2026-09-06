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
  items?: string[] | TodoItem[];
  html?: string;
  distance?: string;
  duration?: string;
  route?: string;
  via?: string;
  from?: string;
  to?: string;
  mode?: "flight" | "drive" | "train" | "ferry";
  location?: string;
  mapsQuery?: string;
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

export interface Theme {
  primary?: string;
  accent?: string;
  font?: string;
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
