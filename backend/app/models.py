"""Trip data model — authoritative schema for backend/data/trips/<slug>/trip.json.

Keep this model coarse on purpose (see docs/spec.md §5): content is markdown
strings + typed fields; custom layouts go through the `custom` block kind.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

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


class Block(BaseModel):
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


class Day(BaseModel):
    date: str  # ISO YYYY-MM-DD
    title: str = ""
    notes: Optional[str] = None  # markdown
    blocks: list[Block] = Field(default_factory=list)


class Person(BaseModel):
    name: str
    role: Role = "viewer"
    note: Optional[str] = None


class Practical(BaseModel):
    todos: list[TodoItem] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)
    notes: Optional[str] = None  # markdown


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
    summary: Optional[str] = None        # markdown
    theme: Theme = Field(default_factory=Theme)
    crew: list[Person] = Field(default_factory=list)
    practical: Practical = Field(default_factory=Practical)
    days: list[Day] = Field(default_factory=list)
    updated: Optional[str] = None        # ISO date of last content update
