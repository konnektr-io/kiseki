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

export interface Link {
  label: string;
  url: string;
}

export interface TodoItem {
  label: string;
  done: boolean;
}

export interface Block {
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
}

export interface Day {
  date: string; // ISO YYYY-MM-DD
  title: string;
  notes?: string;
  map?: string;
  blocks: Block[];
}

export interface TripSection {
  title: string;
  days: number[];
}

export interface Stat {
  label: string;
  value: string;
}

export interface Person {
  name: string;
  role: Role;
  note?: string;
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
}

export interface Trip {
  slug: string;
  title: string;
  subtitle?: string;
  stage: Stage;
  startDate?: string;
  endDate?: string;
  token: string;
  cover?: string;
  coverCredit?: string;
  map?: string;
  summary?: string;
  theme?: Theme;
  stats?: Stat[];
  sections?: TripSection[];
  crew: Person[];
  practical: { todos?: TodoItem[]; links?: Link[]; notes?: string };
  days: Day[];
  updated?: string;
}
