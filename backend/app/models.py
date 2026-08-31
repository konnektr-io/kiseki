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


class Link(BaseModel):
    """An external hyperlink (label + url) used across blocks / features / contacts."""

    label: str = Field(..., description="Display text for the link.")
    url: str = Field(..., description="Target URL — absolute or /media/... relative.")


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
    items: list[Any] = Field(default_factory=list, description="todo → [{label,done}] · gallery → [image URLs] · custom → raw (sanitized) html.")
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
    images: list[str] = Field(default_factory=list, description="Card media strip (asset URLs).")


class Day(BaseModel):
    """A single dated day in the itinerary; owns its ordered blocks.

    `id` is the date (slug-prefixed, e.g. 'canada-2027-2027-02-15') — identity is
    the DATE, not the position, so reordering days never changes $dtId."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. Reorder-proof: identity is fixed, never derived from date/position. Re-seed replaces by id (no drift).")
    date: str = Field(..., description="ISO YYYY-MM-DD.")
    title: str = Field(default="", description="Day heading.")
    notes: Optional[str] = Field(default=None, description="Markdown day-level notes.")
    map: Optional[str] = Field(default=None, description="Optional map image for this day.")
    meta: list[MetaItem] = Field(default_factory=list, description="Stay/Lift/Flight chips (label/value).")
    blocks: list[Block] = Field(default_factory=list, description="Ordered blocks scheduled on this day (hasBlock edges in the graph).")


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


class Stat(BaseModel):
    """An 'at a glance' stat row, e.g. 16 DAYS · 12 LIFTS."""

    label: str = Field(..., description="Stat label, e.g. 'Days'.")
    value: str = Field(..., description="Stat value, e.g. '16'.")


class FeatureCard(BaseModel):
    """A card inside a feature (resort cards, route markers)."""

    title: str = Field(..., description="Card title.")
    value: Optional[str] = Field(default=None, description="Optional headline metric, e.g. '1,070 m vertical'.")
    description: Optional[str] = Field(default=None, description="Card body (markdown).")
    image: Optional[str] = Field(default=None, description="Card image URL.")
    links: list[Link] = Field(default_factory=list, description="Links attached to the card.")


class Feature(BaseModel):
    """An editorial overview card (booklet 'centerpiece' / 'road trip' sections)."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. Re-seed replaces by id (no drift).")
    kicker: str = Field(default="", description="Small overline above the title.")
    title: str = Field(..., description="Feature title.")
    description: Optional[str] = Field(default=None, description="Feature body (markdown).")
    image: Optional[str] = Field(default=None, description="Hero image URL.")
    images: list[str] = Field(default_factory=list, description="2-column image layout (centerpiece).")
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
    `marker` is set explicitly."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. Re-seed replaces by id (no drift).")
    name: str = Field(..., description="Place name (the canonical key).")
    marker: Optional[int] = Field(default=None, description="Explicit ① ② … loop-marker number; defaults to 1-based position in trip.locations.")
    alias: list[str] = Field(default_factory=list, description="Alternate names that resolve to this location, e.g. 'Hillcrest' → Revelstoke.")
    lat: Optional[float] = Field(default=None, description="Latitude (enables map generation).")
    lng: Optional[float] = Field(default=None, description="Longitude (enables map generation).")


class Person(BaseModel):
    """Base identity (placeholder crew OR real person). `User` EXTENDS this.
    NOTE: `role` is trip-relative and is stored as a property on the `hasCrew`
    relationship edge, NOT on this node — it is kept here only as the trip.json
    data carrier for the field."""

    id: str = Field(..., description="Opaque unique id (GUID), stored in trip.json. Used verbatim as the twin $dtId. (A logged-in User gets its own opaque $dtId = the global auth id; login transfers the hasCrew edges onto it.)")
    name: str = Field(..., description="Person's name (placeholder crew or real).")
    role: Role = Field(default="viewer", description="TRIP-RELATIVE crew role (owner|editor|viewer|follower). Carried on the hasCrew edge, not on this node.")
    note: Optional[str] = Field(default=None, description="Free-text note about this person on this trip.")
    contact: Optional[str] = Field(default=None, description="Phone/email when available.")


class Practical(BaseModel):
    """Trip-wide practical info: todos, links, notes, contacts."""

    todos: list[TodoItem] = Field(default_factory=list, description="Pre-trip / during-trip checklist.")
    links: list[Link] = Field(default_factory=list, description="Useful external links (docs, bookings).")
    notes: Optional[str] = Field(default=None, description="Free-form practical notes (markdown).")
    contacts: list[Contact] = Field(default_factory=list, description="At-a-glance contacts.")


class Theme(BaseModel):
    """UI theming — hex colors + font. The UI consumes CSS variables, never raw hex."""

    primary: Optional[str] = Field(default=None, description="Primary hex color.")
    accent: Optional[str] = Field(default=None, description="Accent hex color.")
    font: Optional[str] = Field(default=None, description="Font family key (bundled via @fontsource).")


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
    token: str = Field(..., description="Secret share key — appears in share URLs; editable (rotate without re-wiring the graph).")
    cover: Optional[str] = Field(default=None, description="Cover image URL (absolute or /media/...).")
    coverCredit: Optional[str] = Field(default=None, description="Cover image credit line.")
    map: Optional[str] = Field(default=None, description="Overview route-map image.")
    summary: Optional[str] = Field(default=None, description="Trip summary (markdown).")
    theme: Theme = Field(default_factory=Theme, description="UI theme (colors + font).")
    coverStats: list[str] = Field(default_factory=list, description="Cover strip lines, e.g. '16 DAYS · FEB 15 – MAR 2'.")
    locations: list[Location] = Field(default_factory=list, description="Places: drive loop markers + future map generation (atLocation edges).")
    stats: list[Stat] = Field(default_factory=list, description="'At a glance' stat rows.")
    features: list[Feature] = Field(default_factory=list, description="Editorial overview cards (hasFeature edges).")
    sections: list[TripSection] = Field(default_factory=list, description="Itinerary groupings (hasSection edges).")
    crew: list[Person] = Field(default_factory=list, description="People on the trip (hasCrew edges; role is an edge property).")
    practical: Practical = Field(default_factory=Practical, description="Trip-wide practical info.")
    days: list[Day] = Field(default_factory=list, description="Dated days, each owning its blocks (hasDay → hasBlock edges).")
    updated: Optional[str] = Field(default=None, description="ISO date of last content update.")
