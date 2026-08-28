"""Trip data model — authoritative schema for backend/data/trips/<slug>/trip.json.

Keep this model coarse on purpose (see docs/spec.md §5): content is markdown
strings + typed fields; custom layouts go through the `custom` block kind.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

BlockKind = Literal[
    "activity", "transport", "lodging", "meal",
    "todo", "note", "gallery", "link", "booking", "custom",
]
BlockStatus = Literal["planned", "booked", "done"]
Stage = Literal["idea", "options", "shortlist", "planned", "booked", "live", "archive"]
Role = Literal["owner", "editor", "viewer", "follower"]


class Link(BaseModel):
    label: str
    url: str


class TodoItem(BaseModel):
    label: str
    done: bool = False


class MetaItem(BaseModel):
    """Day-level meta row, e.g. Stay: Banff · Lift: Ikon."""
    label: str
    value: str


class Block(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    kind: BlockKind
    title: Optional[str] = None
    time: Optional[str] = None
    description: Optional[str] = None  # markdown
    links: list[Link] = Field(default_factory=list)
    cost: Optional[float] = None
    currency: Optional[str] = None
    status: Optional[BlockStatus] = None
    bookingCode: Optional[str] = None
    order: Optional[int] = None
    # todo: [{label, done}], gallery: [image urls], custom: raw html
    items: list[Any] = Field(default_factory=list)
    html: Optional[str] = None
    # drive/route info (transport blocks) — renders as the booklet's drive card
    distance: Optional[str] = None     # e.g. "143 km"
    duration: Optional[str] = None     # e.g. "1 h 35"
    route: Optional[str] = None        # e.g. "Hwy 1 West, via Canmore"
    via: Optional[str] = None          # e.g. "Rogers Pass (Glacier NP)"
    from_: Optional[str] = Field(default=None, alias="from")   # directions origin
    to: Optional[str] = Field(default=None, alias="to")        # directions destination


class Day(BaseModel):
    date: str  # ISO YYYY-MM-DD
    title: str = ""
    notes: Optional[str] = None  # markdown
    map: Optional[str] = None    # optional map image for this day
    meta: list[MetaItem] = Field(default_factory=list)  # Stay/Lift/Flight chips
    blocks: list[Block] = Field(default_factory=list)


class TripSection(BaseModel):
    """Itinerary grouping (e.g. 'Days 6–9 — the heli block'). days = 0-based day indices."""
    title: str
    days: list[int] = Field(default_factory=list)


class Stat(BaseModel):
    label: str
    value: str


class FeatureCard(BaseModel):
    """A card inside a feature (resort cards, route markers)."""
    title: str
    value: Optional[str] = None      # e.g. "1,070 m vertical"
    description: Optional[str] = None
    image: Optional[str] = None
    links: list[Link] = Field(default_factory=list)


class Feature(BaseModel):
    """Editorial overview card (booklet 'centerpiece' / 'road trip' sections)."""
    kicker: str = ""
    title: str
    description: Optional[str] = None  # markdown
    image: Optional[str] = None
    images: list[str] = Field(default_factory=list)  # 2-col image layout (centerpiece)
    chips: list[str] = Field(default_factory=list)   # highlight chips (centerpiece)
    cards: list[FeatureCard] = Field(default_factory=list)  # resort/route card grids
    links: list[Link] = Field(default_factory=list)


class Contact(BaseModel):
    label: str
    value: str = ""
    link: Optional[str] = None


class Person(BaseModel):
    name: str
    role: Role = "viewer"
    note: Optional[str] = None


class Practical(BaseModel):
    todos: list[TodoItem] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)
    notes: Optional[str] = None  # markdown
    contacts: list[Contact] = Field(default_factory=list)  # at-a-glance contacts


class Theme(BaseModel):
    primary: Optional[str] = None  # hex
    accent: Optional[str] = None   # hex
    font: Optional[str] = None


class Trip(BaseModel):
    slug: str
    title: str
    subtitle: str = ""
    stage: Stage = "idea"
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    token: str  # the secret share key — it appears in share URLs
    cover: Optional[str] = None          # image URL (absolute or /media/...)
    coverCredit: Optional[str] = None
    map: Optional[str] = None            # overview route map image
    summary: Optional[str] = None        # markdown
    theme: Theme = Field(default_factory=Theme)
    coverStats: list[str] = Field(default_factory=list)   # cover strip lines, e.g. "16 DAYS · FEB 15 – MAR 2"
    stats: list[Stat] = Field(default_factory=list)          # "At a glance" row
    features: list[Feature] = Field(default_factory=list)    # editorial overview cards
    sections: list[TripSection] = Field(default_factory=list)  # itinerary grouping
    crew: list[Person] = Field(default_factory=list)
    practical: Practical = Field(default_factory=Practical)
    days: list[Day] = Field(default_factory=list)
    updated: Optional[str] = None        # ISO date of last content update
