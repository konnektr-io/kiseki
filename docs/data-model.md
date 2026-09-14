# Data model

A trip is **one document**. Everything the app shows — the itinerary, the map, the practicals, the
booklet — is a view of it, and the document lives in the Konnektr Graph as DTDL v4 twins and
relationships. `backend/app/models.py` is the authoritative Python shape;
`backend/dtdl/kiseki-models.json` is the authoritative graph shape.

## The trip document

```
Trip
├── stage, dates, timezone, visibility, discoverable
├── cover, theme, summary, stats / coverStats        (what the trip page shows first)
├── locations[]        places, with coordinates — the single source for markers AND maps
├── sections[]         multi-day units of the itinerary (title, day refs, fold state)
├── days[]             the itinerary
│   └── blocks[]       typed content: stay, drive, activity, meal, note, photo …
├── features[]         editorial cards for the overview
├── practical          checklist + contacts + notes (+ TriCount connection)
└── crew               people and their roles, in order
```

### Stages

A trip moves through a stage ladder — `idea → options → shortlist → planned → booked → live` — and
the surfaces adapt to it (what is editable, what the landing page shows, what the booklet emphasises).

### Blocks

Blocks are the atoms of a day, and they are **typed**, not free text. Each block kind carries only
the fields it needs, and the same block drives its card, its map marker and its booklet entry:

| Field group | Examples |
|---|---|
| Identity | `kind`, `title`, `time`, `status`, `order` |
| Content | `description`, `items[]`, `html`, `links[]` |
| Money | `cost`, `currency`, `bookingCode` |
| Movement | `distance`, `duration`, `mode`, `route`, `via`, `from`, `to` |
| Place | `location`, `placeId`, `images[]` |

### Locations

A `Location` is a named place with `lat`/`lng` (plus optional `placeId`, address, opening hours,
website, phone, rating and a rights-clean `photo` + credit). Blocks and days reference locations
instead of re-typing coordinates, which is why a coordinate is fixed in exactly one place.

### Themes

Per-trip theme presets (palette, typography, album feel) live in the document as a `theme` field —
content, not code. Anything that should change per trip reads a design token; nothing is hard-coded.

## The graph

### Twins

| Model | Carries |
|---|---|
| `Trip` | slug, title, subtitle, stage, dates, timezone, visibility, discoverable, `claimToken`, `followToken`, cover(+credit), map, summary, theme, coverStats, stats, practical, updated |
| `Day` | date, title, notes, map, meta |
| `Block` | kind, title, time, description, links, cost, currency, status, bookingCode, order, items, html, distance, duration, route, via, from, to, mode, location, placeId, images |
| `TripSection` | title, days, locationRefs, fold |
| `Location` | name, marker, alias, lat, lng, placeId, address, website, phone, openingHours, types, wheelchairAccessible, rating, summary, photo(+credit/license/source) |
| `Feature` | kicker, title, description, image(s), chips, cards, map, links |
| `Person` | name, contact — a crew entry; identity-less by design |
| `User` | email, displayName, authProvider, publicName — a *claimed* person, keyed by the Auth0 `sub` |
| `FeedEntry` | type, payload, visibility |
| `Integration` | kind, status, tokenRef |

### Edges

```
Trip ──hasDay──────► Day ──hasBlock──► Block ──atLocation──► Location
Trip ──hasSection──► TripSection ──hasBlock──► Block
        └───────────hasDay──► Day
Trip ──hasFeature──► Feature
Trip ──hasCrew─────► Person | User        (props: role, note, displayName, index)
User ──follows─────► User
```

Two things worth knowing:

- **A crew row is a `Person` until it is claimed**, then it is a `User` twin whose `$dtId` is the
  auth `sub`. The `hasCrew` edge — not the name, not the e-mail — is what grants access.
- **Following a trip is a `hasCrew` edge with `role: follower`.** There is no separate follow edge for
  trips; `follows` (User → User) is only for following people. That is why a follower can read the
  trip and a claimant can be promoted, using one mechanism.

## Access control

Visibility and roles are decided in one place, `backend/app/acl.py`:

| Visibility | Read | Write |
|---|---|---|
| `public` | anyone by id (an invalid token is ignored, not rejected) | `editor+` with a valid token |
| `private` | `follower+` with a valid token (else `401`/`403`) | `editor+` |

Role ladder, ascending: **`follower` (1) < `viewer` (2) < `editor` (3) < `owner` (4)**.

| Need | Minimum |
|---|---|
| Read a trip, its booklet, its expense snapshot | `follower` / `viewer` |
| Edit content (days, blocks, sections, crew fields, locations, features, practicals, photos) | `editor` |
| Revoke the crew invite, mint/rotate the follow link, change visibility, delete the trip, delete crew | `owner` |

Identity rules:

- **Claiming, never matching.** The owner shares a join link; the invitee signs in and claims their
  own placeholder. A placeholder is claimable once. Nothing about a self-asserted name or e-mail
  grants anything.
- **Two independent secrets per trip.** `claimToken` (crew invite: read, write if the role says so,
  and claim an identity) and `followToken` (follow link: read + follow, can never claim). They are
  separate properties on the `Trip` twin, so revoking one never touches the other: the crew invite is
  minted with the trip and revoked with `DELETE …/join-link`, while the follow link is minted — and
  rotated — with `POST …/follow-link`.
- **Neither secret ever appears in a trip document.** They leave the API only through the owner-only
  link endpoints.
- **The agent is never a graph identity.** It acts *as* the user whose turn it is running, so its
  writes carry that user's real role — and get refused when that role is insufficient.

## Where the data actually lives

| Concern | Home |
|---|---|
| Trips, days, blocks, sections, locations, features, crew, users | Konnektr Graph (AGE/PostgreSQL) |
| Trip media (covers, galleries, photos) | Garage S3 bucket, private, streamed via `/media/<trip-id>/<file>` |
| Agent conversation history | The agent's own side, scoped per user and trip |
| `trip.json` / `*.graph.json` | **Authoring scratch only** — git-ignored, never read at runtime |
| Anonymised samples | `backend/data/mocks/*.graph.anon.json`, committed, used for local dev and CI |

Media fields hold **bare filenames**; the API expands them to URLs, so the data model never contains a
storage path and the storage backend can change without touching content.
