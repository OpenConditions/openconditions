# OpenConditions

> Open, federated, self-hostable **live-conditions data commons** — the dynamic layer that complements
> OpenStreetMap's static map: road incidents / roadworks / closures / hazards / congestion now; transit
> occupancy, place busyness, and a crowd-sourced reporting layer later.
>
> **Status: v0 validation slice implemented (NDW DATEX II → conditions.observations → GeoJSON overlay;
> build / typecheck / test green). Only NDW is wired; dedup, additional feeds, and release are deferred.**

## Plans

The full design + phased implementation plans live in the **OpenMapX monorepo** at `docs/plans/conditions/`
(`github.com/OpenMapX/openmapx`) — they are a local, gitignored working artifact there and are **not duplicated
into this repo**. Entrypoint + dispatch hub: `docs/plans/conditions/README.md`. Four layers, read top-to-bottom:

- `0-strategy/` — positioning, roadmap, governance/legal/funding (the _why & how we run it_)
- `1-foundations/` — the spec, architecture, and canonical schema (read before coding)
- `2-road/` — the road domain: incidents overlay → navigation/TTS → OpenLR/routing (build first)
- `3-commons/` — crowd reporting, federation, publishing emitters, privacy/probe

When dispatching an implementation session here, reference the plan files by their absolute path in your OpenMapX
checkout (e.g. `…/openmapx/docs/plans/conditions/2-road/1-incidents-overlay.md`).

## Decided facts

- **Positioning:** an independent open commons whose reference implementation + anchor consumer is **OpenMapX**
  (the hungry first-party consumer every prior project in this space lacked).
- **Tech stack:** TypeScript / Node, Fastify, shared PostGIS + Redis; OpenLR via Rust-WASM; map-matching via the
  Valhalla service.
- **Model:** two-axis `Observation` → `ConditionEvent` | `Measurement`, one generic `conditions.observations`
  PostGIS table.
- **Packages/services:** `@openconditions/{core,roads,openlr,…}` (npm, prebuilt) + `ghcr.io/openconditions/ingest`.
- **Licensing:** AGPL-3.0 server / Apache-2.0 libraries / ODbL-or-CC-BY-SA data.
- **Domain:** openconditions.org.

## First implementation step

A thin **NDW-only tracer bullet** (one feed → canonical model → ingest → OpenMapX overlay) to validate the
architecture end-to-end before building breadth — see `2-road/1-incidents-overlay.md` in the OpenMapX plans.

## License

Per the governance plan: **AGPL-3.0-or-later** server stack · **Apache-2.0** `@openconditions/*` libraries/SDKs ·
**ODbL or CC-BY-SA 4.0** data corpus.
