# Kiseki documentation

Start with the [README](../README.md) for what Kiseki is. Everything below goes deeper.

| Document | Read it when… |
|---|---|
| [architecture.md](architecture.md) | You want to know how the pieces fit: backend, frontend, graph, media, external services, the agent relay. |
| [api.md](api.md) | You are calling the HTTP API, or adding a route. Includes the access-control rule for every endpoint. |
| [data-model.md](data-model.md) | You are touching trip content: the trip document, the DTDL v4 models, the graph twins and edges, roles. |
| [development.md](development.md) | You are setting up, running tests, or wondering where things live in the repo. |
| [deployment.md](deployment.md) | You are building or running the container, or wiring configuration. |
| [spec.md](spec.md) | You want the original product spec and the design rationale behind the app. Kept as written; some of it describes work now shipped. |
| [`../DESIGN.md`](../DESIGN.md) | You are changing anything a user can see. This is the visual and interaction law. |
| [`../AGENTS.md`](../AGENTS.md) | You are an AI coding agent working in this repo, or you want the engineering conventions in one page. |

Design and history notes live alongside these:

- [chat-m3-design.md](chat-m3-design.md) — how the chat relay was designed (agent side)
- [chat-m4-frontend-design.md](chat-m4-frontend-design.md) — the chat UI design
- [post-deploy-dtdl-check.md](post-deploy-dtdl-check.md) — the DTDL conformance check to run after a graph deploy

## The one-paragraph version

A trip is a structured document (stage, days, typed blocks, sections, locations, crew, practicals)
held in the Konnektr Graph as DTDL v4 twins and edges. A FastAPI backend reads that graph, enforces
per-trip access control, proxies the services that need server-side keys (S3 media, HERE routes,
Google Places, the chat agent) and serves a built React SPA. The SPA renders one persistent map
surface that *is* the itinerary, inline edits for `editor+` roles, and a printable booklet that
Playwright renders from the same data and design system. Content is data: changing a trip never
requires a rebuild or a redeploy.
