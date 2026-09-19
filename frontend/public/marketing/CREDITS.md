# Marketing photography — provenance and licence

These files illustrate the landing page's **invented** example trip. They are not
private imagery: the owner of this repository has declared them rights-free, and the
trip they appear in is fiction written for the page.

| file | what it shows | origin |
|---|---|---|
| `hero.jpg` | a skier on a powder slope | the owner's Canada trip imagery — declared rights-free |
| `closing.jpg` | Machu Picchu and the Andes | the owner's Chile–Peru trip imagery — declared rights-free |
| `login-machu-picchu.jpg` | the Universal Login page background | **derived from `closing.jpg`** (same photograph, same licence): upscaled to 3008px, given a muted editorial grade, then re-cropped to 16:9 (2392×1344). Never referenced by the app itself — it is the URL configured in Auth0 → Branding → Universal Login → Page background |
| `day-garden.jpg` | a Tokyo garden pond and footbridge | the owner's *Urban Legends & Neon Dreams* imagery — an entirely fictional trip |
| `day-alley.jpg` | a lantern-lit Tokyo alley at night | as above |
| `day-rain.jpg` | a rainy Tokyo crossing under umbrellas | as above |

**Rights declaration** — Niko Raes, 2026-09-15: *"all images on Chile-Peru and Canada
are rights free… you can reuse some stuff from the Urban Legends & Neon Dreams trip
— it's completely fictional and all images should be rights free."*

## Excluded on purpose

- **Costa Rica** holds personal photos. It is not used here in any form, and the
  landing page fetches nothing from the graph, so it cannot appear by accident.
- **The Canada trip's route-map PNG** is not used either: it is a Google Maps
  screenshot (the image itself carries "Map data ©2026 Google"), so that trip's
  *photographs* being rights-free says nothing about the map's licence — Google's
  terms govern redistributing its tiles on a public page. The example's map is drawn
  as SVG in `pages/LandingMarketing.tsx` instead, which also keeps it honest: an
  invented trip should not be illustrated with somebody's actual route.
- No image carries identifiable faces, and the ones with people in the frame (the
  rainy street, the alley) show them at distance or from behind.

## Processing

Resized for the web and re-encoded with `ffmpeg -vf scale=… -q:v 4 -map_metadata -1`.
The `-map_metadata -1` is not cosmetic: it strips EXIF, which in a camera roll carries
timestamps and GPS coordinates — the same class of leak as the booking codes this
page stopped advertising.
