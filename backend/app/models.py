"""Trip data model — authoritative schema for backend/data/trips/<slug>/trip.json.

Keep this model coarse on purpose (see docs/spec.md §5): content is markdown
strings + typed fields; custom layouts go through the `custom` block kind.

This module is ALSO the single source of truth for the DTDL v4 graph models
(backend/dtdl/README.md): `scripts/gen_dtdl.py` introspects these Pydantic
models and emits `dtdl/kiseki-models.json`. Every `Field(description=...)` below
becomes a DTDL `description` annotation, so the graph stays self-documenting.

Graph conventions that shape this file:
- `Person` is the base identity — a placeholder crew member OR a real person.
  `User` EXTENDS `Person` (DTDL `extends`): a logged-in user *is* a person, plus
  auth fields. Because a real user's `$dtId` is their global auth id (an opaque
  GUID, unprefixed), not the trip-scoped person id, login does NOT mutate the
  placeholder twin — it creates the `User` twin and TRANSFERS the `hasCrew`
  edges (carrying `role`) onto it, then drops the placeholder.
- `role` is trip-relative, so it lives on the `hasCrew` RELATIONSHIP (edge
  property), NOT on `Person`. It is kept here only as the trip.json data carrier;
  the generator strips it from the `Person` DTDL and the converter moves it to the
  edge.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# Block kinds — exactly these ten (spec §5). Coarse vocabulary, not split per kind.
# activity   : a thing to do (tour, hike, show, …)
# transport  : a leg between places (flight/drive/train/ferry)
# lodging    : where you sleep
# meal       : a food/drink stop
# todo       : a checklist block
# note       : free-form markdown
# gallery    : an image strip
# link       : external links
# booking    : a reservation with a code
# custom     : raw (client-sanitized) HTML for one-off layouts
BlockKind = Literal[
    "activity", "transport", "lodging", "meal",
    "todo", "note", "gallery", "link", "booking", "custom",
]
# planned → booked → done lifecycle of a block / booking.
BlockStatus = Literal["planned", "booked", "done"]
# Trip maturity: idea → … → live → archive (drives the UI badge + day highlights).
Stage = Literal["idea", "options", "shortlist", "planned", "booked", "live", "archive"]
# Crew relationship role (carried as a `hasCrew` edge property, NOT on Person).
Role = Literal["owner", "editor", "viewer", "follower"]
# Trip visibility: who may read the trip via GET /api/trips/{id}.
Visibility = Literal["public", "private"]


class Link(BaseModel):
    """An external hyperlink (label + url) used across blocks / features / contacts."""

    label: str = Field(..., description="Display text for the link.")
    url: str = Field(..., description="Target URL — absolute (https://…). Media is never referenced via links: use the dedicated image/cover/map fields (bare filenames).")


class TodoItem(BaseModel):
    """A single checklist entry (e.g. a pre-trip task or a booking to confirm)."""

    label: str = Field(..., description="The thing to do.")
    done: bool = Field(default=False, description="Whether it is completed.")
    when: Optional[str] = Field(default=None, description="Due/scheduled window, e.g. 'Feb 15–16' — shown in checklist + bookings table.")
    links: list[Link] = Field(default_factory=list, description="Booking links rendered alongside the item in the checklist.")


class MetaItem(BaseModel):
    """A day-level label/value chip, e.g. Stay: Banff · Lift: Ikon."""

    label: str = Field(..., description="Left-side label, e.g. 'Stay' or 'Lift'.")
    value: str = Field(..., description="Right-side value, e.g. 'Banff'.")


class Block(BaseModel):
    """One coarse content block. `kind` selects the renderer; shared fields cover
    every kind so the model stays small (spec §5)."""

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId; re-seed REPLACES the twin by id (no drift). Carries no semantic meaning — all meaning lives in $metadata.$model + content.")
    kind: BlockKind = Field(..., description="Which block kind — drives the renderer (one of the ten kinds).")
    title: Optional[str] = Field(default=None, description="Block heading.")
    time: Optional[str] = Field(default=None, description="Optional time-of-day label, e.g. '08:30'.")
    description: Optional[str] = Field(default=None, description="Markdown body of the block.")
    links: list[Link] = Field(default_factory=list, description="External links attached to the block.")
    cost: Optional[float] = Field(default=None, description="Monetary cost (number; pair with `currency`).")
    currency: Optional[str] = Field(default=None, description="ISO currency code for `cost`, e.g. 'CAD'.")
    status: Optional[BlockStatus] = Field(default=None, description="Lifecycle: planned | booked | done.")
    bookingCode: Optional[str] = Field(default=None, description="Confirmation / booking reference.")
    order: Optional[int] = Field(default=None, description="Sort order within the day (0-based).")
    # todo: [{label, done}] · gallery: [image urls] · custom: raw html
    items: list[Any] = Field(default_factory=list, description="todo → [{label,done}] · gallery → [bare media filenames] · custom → raw (sanitized) html.")
    html: Optional[str] = Field(default=None, description="Raw HTML for `custom` blocks (client-sanitized).")
    # drive/route info (transport blocks) — renders as the booklet's drive card
    distance: Optional[str] = Field(default=None, description="Drive distance, e.g. '143 km' (transport blocks).")
    duration: Optional[str] = Field(default=None, description="Drive duration, e.g. '1 h 35' (transport blocks).")
    route: Optional[str] = Field(default=None, description="Route name, e.g. 'Hwy 1 West, via Canmore'.")
    via: Optional[str] = Field(default=None, description="Notable waypoints, e.g. 'Rogers Pass (Glacier NP)'.")
    from_: Optional[str] = Field(default=None, alias="from", description="Directions origin place name/alias.")
    to: Optional[str] = Field(default=None, alias="to", description="Directions destination place name/alias.")
    mode: Optional[str] = Field(default=None, description="Explicit transport mode: flight | drive | train | ferry (beats the heuristic).")
    location: Optional[str] = Field(default=None, description="Place name/alias → auto Google Maps link + map thumbnail.")
    mapsQuery: Optional[str] = Field(default=None, description="Precise query for the ACTUAL place (hotel/restaurant) — overrides `location` for the link + thumbnail pin.")
    googlePlaceId: Optional[str] = Field(default=None, description="Google place_id for THE specific venue (hotel/restaurant, not just the town) — preferred deep-link key for the Google Maps link (keyless URL form, no photo/review fetch). Indefinitely cacheable per the #15/#95 storage rule.")
    images: list[str] = Field(default_factory=list, description="Card media strip — bare media filenames, served by the API at /media/<trip_id>/<file>.")


class Day(BaseModel):
    """A single dated day in the itinerary; owns its ordered blocks.

    `id` is the date (slug-prefixed, e.g. 'canada-2027-2027-02-15') — identity is
    the DATE, not the position, so reordering days never changes $dtId."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. Reorder-proof: identity is fixed, never derived from date/position. Re-seed replaces by id (no drift).")
    date: str = Field(..., description="ISO YYYY-MM-DD.")
    title: str = Field(default="", description="Day heading.")
    notes: Optional[str] = Field(default=None, description="Markdown day-level notes.")
    map: Optional[str] = Field(default=None, description="Optional map image for this day — bare media filename, served at /media/<trip_id>/<file>.")
    meta: list[MetaItem] = Field(default_factory=list, description="Stay/Lift/Flight chips (label/value).")
    blocks: list[Block] = Field(default_factory=list, description="Ordered blocks scheduled on this day (hasBlock edges in the graph).")


class SectionFold(BaseModel):
    """One itinerary card that folds several CONSECUTIVE days into a single
    summary row (e.g. three near-empty heli days shown as one card). The days
    themselves keep existing — this is display grouping only, so unfolding
    (when real per-day content lands) is a pure data edit."""

    title: str = Field(..., description="Card title for the folded group, e.g. 'Heli Days 1–3'.")
    days: list[int] = Field(..., description="Consecutive 0-based day indices folded into this card, in trip.days order.")


class TripSection(BaseModel):
    """Itinerary grouping with two jobs:
    (1) group existing days by an INCLUSIVE [first,last] 0-based index range;
    (2) hold unscheduled activity ideas in `blocks` during ideation, before any
    day exists. Usually maps to a place/stay (`locationRefs`) so the map + loop
    markers can group by section. Empty `days`+`blocks` = pure ideation pool."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. Re-seed replaces by id (no drift).")
    title: str = Field(..., description="Heading, e.g. 'Days 6–9 — the heli block'.")
    days: list[int] = Field(default_factory=list, description="Inclusive [first,last] 0-based day indices this section groups. Empty during pure ideation. Becomes hasDay edges in the graph.")
    locationRefs: list[str] = Field(default_factory=list, description="Location name/alias(es) this section covers (resolves to Location twins). Multi-place sections allowed.")
    blocks: list[Block] = Field(default_factory=list, description="Unscheduled ideas owned by this section (ideation content, before landing on a day). Becomes hasBlock edges.")
    fold: list[SectionFold] = Field(default_factory=list, description="Display-only: consecutive day groups rendered as a single card in the itinerary (day pages + booklet stay per-day). Empty = render every day.")


class Stat(BaseModel):
    """An 'at a glance' stat row, e.g. 16 DAYS · 12 LIFTS."""

    label: str = Field(..., description="Stat label, e.g. 'Days'.")
    value: str = Field(..., description="Stat value, e.g. '16'.")


class FeatureCard(BaseModel):
    """A card inside a feature (resort cards, route markers)."""

    title: str = Field(..., description="Card title.")
    value: Optional[str] = Field(default=None, description="Optional headline metric, e.g. '1,070 m vertical'.")
    description: Optional[str] = Field(default=None, description="Card body (markdown).")
    image: Optional[str] = Field(default=None, description="Card image — bare media filename, served at /media/<trip_id>/<file>.")
    links: list[Link] = Field(default_factory=list, description="Links attached to the card.")


class Feature(BaseModel):
    """An editorial overview card (booklet 'centerpiece' / 'road trip' sections)."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. Re-seed replaces by id (no drift).")
    kicker: str = Field(default="", description="Small overline above the title.")
    title: str = Field(..., description="Feature title.")
    description: Optional[str] = Field(default=None, description="Feature body (markdown).")
    image: Optional[str] = Field(default=None, description="Hero image — bare media filename, served at /media/<trip_id>/<file>.")
    images: list[str] = Field(default_factory=list, description="2-column image layout (centerpiece) — bare media filenames, served at /media/<trip_id>/<file>.")
    chips: list[str] = Field(default_factory=list, description="Highlight chips (centerpiece).")
    cards: list[FeatureCard] = Field(default_factory=list, description="Resort/route card grid.")
    map: Optional[bool] = Field(default=None, description="Render the trip's dynamic map here (JS web / static print).")
    links: list[Link] = Field(default_factory=list, description="Feature-level links.")


class Contact(BaseModel):
    """An at-a-glance contact (e.g. embassy, lodge, operator)."""

    label: str = Field(..., description="Who this contact is, e.g. 'Lodge'.")
    value: str = Field(default="", description="The value — phone, email, or address.")
    link: Optional[str] = Field(default=None, description="Optional URL/quick-dial link.")


class Location(BaseModel):
    """A place on the trip — the source for loop markers AND future map
    generation. Marker number = position in trip.locations (1-based) unless
    `marker` is set explicitly.

    Durable place metadata (issues #15/#95): only `placeId` may be persisted
    indefinitely; `lat`/`lng` for ≤30 days of routing use; photos/reviews are
    NEVER stored. `rating` follows the same ≤30-day rule — the read path
    strips it once the trip's `updated` is older than 30 days. `summary` is
    the agent's own editorial content (markdown OK), never Google text."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. Re-seed replaces by id (no drift).")
    name: str = Field(..., description="Place name (the canonical key).")
    marker: Optional[int] = Field(default=None, description="Explicit ① ② … loop-marker number; defaults to 1-based position in trip.locations.")
    alias: list[str] = Field(default_factory=list, description="Alternate names that resolve to this location, e.g. 'Hillcrest' → Revelstoke.")
    lat: Optional[float] = Field(default=None, description="Latitude (enables map generation).")
    lng: Optional[float] = Field(default=None, description="Longitude (enables map generation).")
    placeId: Optional[str] = Field(default=None, description="Google place_id — the only third-party place key that may be persisted indefinitely (#15 storage rule). Drives the keyless Google Maps deep link.")
    address: Optional[str] = Field(default=None, description="Formatted display address, e.g. '1-1 Niseko Hirafu…'.")
    website: Optional[str] = Field(default=None, description="Official website URL of the place.")
    phone: Optional[str] = Field(default=None, description="Phone in international format, e.g. '+81 136-21-1234'.")
    openingHours: Optional[list[str]] = Field(default=None, description="Weekday opening-hours lines, e.g. 'Monday: 09:00–17:00'.")
    types: Optional[list[str]] = Field(default=None, description="Place types, e.g. ['ski_resort', 'lodging', 'restaurant'].")
    wheelchairAccessible: Optional[bool] = Field(default=None, description="Whether the place is wheelchair accessible.")
    rating: Optional[float] = Field(default=None, description="Google rating snapshot — NOT stored long-term. The read path strips it once the trip's `updated` is older than 30 days (≤30-day retention, #15 rule).")
    summary: Optional[str] = Field(default=None, description="Editorial summary of the place (markdown OK). The agent's own content — never Google review/summary text.")
    photo: Optional[str] = Field(default=None, description="Rights-clean stored photo for the place card — bare media filename (served at /media/<trip_id>/<file> via the Garage S3 pipeline) or an external image URL. NEVER a Google photo: Google-derived imagery is fetched live through /api/places/photo and never stored (#15/#95 compliance).")
    photoCredit: Optional[str] = Field(default=None, description="Credit line for the stored photo, e.g. 'Photo: Rusutsu Resort' — rendered under the image.")
    photoLicense: Optional[str] = Field(default=None, description="License of the stored photo, e.g. 'CC BY-SA 4.0' or '© resort press kit (used with permission)'.")
    photoSourceUrl: Optional[str] = Field(default=None, description="Source page URL of the stored photo (where it came from) — lets the crew later upload their own photos while keeping provenance.")


class Person(BaseModel):
    """Base identity (placeholder crew OR real person). `User` EXTENDS this.
    NOTE: `role` is trip-relative and is stored as a property on the `hasCrew`
    relationship edge, NOT on this node — it is kept here only as the trip.json
    data carrier for the field."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. (A logged-in User gets its own opaque $dtId = the global auth id; login transfers the hasCrew edges onto it.)")
    name: str = Field(..., description="Person's name (placeholder crew or real).")
    role: Role = Field(default="viewer", description="TRIP-RELATIVE crew role (owner|editor|viewer|follower). Carried on the hasCrew edge, not on this node.")
    note: Optional[str] = Field(default=None, description="TRIP-RELATIVE free-text note about this person on this trip (e.g. gear). Carried on the hasCrew edge, not on this node — the node is shared across trips after claim.")
    contact: Optional[str] = Field(default=None, description="Phone/email when available.")
    claimed: bool = Field(default=False, description="VIEW-ONLY (not stored): whether the twin behind this crew entry is a claimed User (True) or an unclaimed placeholder Person (False). Set by graph_to_trip from the twin's $model; stripped by trip_to_graph (it is the model kind, not a property). Drives the Crew page's invite affordance.")


class Practical(BaseModel):
    """Trip-wide practical info: todos, links, notes, contacts."""

    todos: list[TodoItem] = Field(default_factory=list, description="Pre-trip / during-trip checklist.")
    links: list[Link] = Field(default_factory=list, description="Useful external links (docs, bookings).")
    notes: Optional[str] = Field(default=None, description="Free-form practical notes (markdown).")
    contacts: list[Contact] = Field(default_factory=list, description="At-a-glance contacts.")
    tricount: Optional["TricountConfig"] = Field(default=None, description="Optional TriCount expense-sharing integration (issue #111). Holds the registry's public key only — Tricount credentials live in app secrets, never in the graph.")


class TricountConfig(BaseModel):
    """Connection to a Tricount (bunq) expense registry — the crew's shared
    expense pot. Only the PUBLIC registry key is stored here (the key from
    the sharing link, same secrecy class as the trip id link). Auth with the
    Tricount API happens server-side via app-level device credentials."""

    registryKey: str = Field(..., description="The Tricount registry's public_identifier_token (e.g. 'twOQZFDbXxZzipcjXG' — the part after /t in tricount.com/tXXXXX). Public to anyone with the sharing link; NOT a secret.")


class TricountExpense(BaseModel):
    """One expense in the connected Tricount registry (read-only snapshot)."""

    id: str = Field(..., description="Tricount transaction id.")
    date: Optional[str] = Field(default=None, description="Expense date, ISO YYYY-MM-DD (local part of the Tricount timestamp).")
    whoPaid: str = Field(..., description="Display name of the member who paid.")
    amount: float = Field(..., description="Positive amount paid (the API stores expenses negative; sign normalized here).")
    currency: str = Field(default="EUR", description="ISO currency code.")
    description: Optional[str] = Field(default=None, description="Expense description, e.g. 'Vluchten'.")
    category: Optional[str] = Field(default=None, description="Tricount category label ('UNCATEGORIZED' when unset; category_custom wins over the builtin enum).")
    involved: list[str] = Field(default_factory=list, description="Display names of members the expense is split among (zero-amount allocations excluded).")
    shareFor: dict[str, float] = Field(default_factory=dict, description="Per-involved-member share, positive, same currency — what each member owes for this expense.")
    type: str = Field(default="NORMAL", description="Transaction type: NORMAL (expense) | INCOME | BALANCE (reimbursement).")


class TricountBalance(BaseModel):
    """A member's net position in the connected Tricount registry."""

    member: str = Field(..., description="Display name of the member.")
    amount: float = Field(..., description="Net balance: positive = is owed money, negative = owes the group.")
    currency: str = Field(default="EUR", description="ISO currency code.")


class TricountSnapshot(BaseModel):
    """Live read of a Tricount registry, served crew-only. Fetched on demand
    (never persisted in the graph) with a short in-memory TTL to stay friendly
    to the bunq API."""

    registryKey: str = Field(..., description="The connected registry's public key (mirrors practical.tricount.registryKey).")
    title: Optional[str] = Field(default=None, description="Registry title, e.g. 'Canada 2027'.")
    currency: str = Field(default="EUR", description="Registry currency.")
    members: list[str] = Field(default_factory=list, description="Registry member display names (ACTIVE only).")
    expenses: list[TricountExpense] = Field(default_factory=list, description="All transactions, oldest first.")
    balances: list[TricountBalance] = Field(default_factory=list, description="Net balance per member, positive = is owed money.")
    fetchedAt: str = Field(..., description="ISO UTC timestamp of the fetch (drives the UI's stale indicator).")


Practical.model_rebuild()  # resolve the forward ref to TricountConfig (defined above)


class Theme(BaseModel):
    """UI theming — the preset id is the whole contract (#40 follow-up).

    ``preset`` names one of the 12 curated presets in
    ``frontend/src/lib/theme-presets.ts`` (palette + type pairing + map style
    + radius). There are no per-trip overrides: retired scalar fields
    (primary/accent/surface/font/…/radius/mapStyle) were removed, and this
    model is strict (``extra="forbid"``), so a write that still sends one is
    rejected with 422 rather than silently ignored."""

    model_config = ConfigDict(extra="forbid")

    preset: Optional[str] = Field(default=None, description="Preset id, e.g. 'alpine' — palette + fonts + map style + radius. The ONLY theming surface.")


class User(Person):
    """Authenticated user (P2). A User EXTENDS Person — same identity, plus auth.
    `$dtId` is the global auth id (opaque, no prefix — NOT the trip-scoped person
    id), so on login we create this twin and transfer the `hasCrew` edges (with
    `role`) from the placeholder Person onto it, then drop the placeholder."""

    email: str = Field(..., description="Primary login email (unique).")
    displayName: str = Field(..., description="Name shown in the UI.")
    authProvider: str = Field(default="password", description="Auth origin: password | auth0 | google (P2).")


class Trip(BaseModel):
    """The trip document — the P0 source of truth, and (in P1) the Konnektr Graph
    twin that aggregates days, locations, crew, features, and sections."""

    id: str = Field(..., description="Opaque unique id (GUID). Used verbatim as the twin $dtId. Stored in trip.json so re-seed REPLACES the twin rather than duplicating it. Carries no semantic meaning — all meaning lives in $metadata.$model + content. The repo folder name is the `slug`, not this id.")
    slug: str = Field(..., description="URL/identity slug, e.g. 'canada-2027'. Repo folder/file name; editable, NOT part of $dtId.")
    title: str = Field(..., description="Trip title.")
    subtitle: str = Field(default="", description="Trip subtitle / tagline.")
    stage: Stage = Field(default="idea", description="Maturity: idea → options → shortlist → planned → booked → live → archive.")
    startDate: Optional[str] = Field(default=None, description="ISO start date.")
    endDate: Optional[str] = Field(default=None, description="ISO end date.")
    timezone: Optional[str] = Field(default=None, description="IANA timezone, e.g. 'Asia/Tokyo' — resolves 'today' in the trip's local calendar date, not the viewer's. Optional; when absent, the viewer's local date is used.")
    visibility: Visibility = Field(default="private", description="Who may read the trip: 'public' = anyone with the id link (no auth); 'private' = crew only (JWT + hasCrew edge, follower+). Default private (issue #64 — replaces the old token-as-switch).")
    discoverable: bool = Field(
        default=False,
        description="Opt-in (#196): this trip may be LISTED on its crew's profiles and in the "
                    "follower feed. Additive to `visibility`, never a replacement: a discoverable "
                    "`private` trip is listed but still requires follower+ to read.",
    )
    claimToken: Optional[str] = Field(default=None, description="Secret CLAIM key (issue #6 + #65) — authorizes claiming a crew identity or following this trip ('join link'). Separate from the read path: the read link is the trip id itself (gated by visibility). Editable (rotate without re-wiring the graph). None = no invite links issued.")
    cover: Optional[str] = Field(default=None, description="Cover image — bare media filename (content-addressed sha256[:32].ext), served at /media/<trip_id>/<file>.")
    coverCredit: Optional[str] = Field(default=None, description="Cover image credit line.")
    map: Optional[str] = Field(default=None, description="Overview route-map image — bare media filename, served at /media/<trip_id>/<file>.")
    summary: Optional[str] = Field(default=None, description="Trip summary (markdown).")
    theme: Theme = Field(default_factory=Theme, description="UI theme — preset id only (#40 follow-up).")
    coverStats: list[str] = Field(default_factory=list, description="Cover strip lines, e.g. '16 DAYS · FEB 15 – MAR 2'.")
    locations: list[Location] = Field(default_factory=list, description="Places: drive loop markers + future map generation (atLocation edges).")
    stats: list[Stat] = Field(default_factory=list, description="'At a glance' stat rows.")
    features: list[Feature] = Field(default_factory=list, description="Editorial overview cards (hasFeature edges).")
    sections: list[TripSection] = Field(default_factory=list, description="Itinerary groupings (hasSection edges).")
    crew: list[Person] = Field(default_factory=list, description="People on the trip (hasCrew edges; role is an edge property).")
    practical: Practical = Field(default_factory=Practical, description="Trip-wide practical info.")
    days: list[Day] = Field(default_factory=list, description="Dated days, each owning its blocks (hasDay → hasBlock edges).")
    updated: Optional[str] = Field(default=None, description="ISO date of last content update.")
