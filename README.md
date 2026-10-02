# OpenConditions

> Open, federated, self-hostable **live-conditions data commons** — the dynamic layer that complements
> OpenStreetMap's static map: road incidents, roadworks, closures, hazards, and congestion today; transit
> occupancy, place busyness, and a crowd-sourced reporting layer later.

OpenConditions aggregates public road-condition feeds into one canonical model, stores them in PostGIS, and
re-emits them in the standard wire formats the wider ecosystem already speaks. Its reference consumer is
[OpenMapX](https://openmapx.com) — the hungry first-party consumer every prior project in this space lacked —
but the data and the libraries are designed to be reused anywhere.

## Status

Road domain, v0.1:

- **Live feeds:** NDW (NL), Die Autobahn (DE), Fintraffic / Digitraffic (FI), DriveBC (CA), and WZDx (US),
  spanning DATEX II, Open511, and WZDx GeoJSON — plus government point-sensor **traffic speed** as
  `Measurement` flow from Fintraffic (FI), WebTRIS (GB), NYC DOT (US-NY), NDW (NL), OHGO (US-OH, keyed),
  and Trafikverket (SE, keyed). Congestion is computed from a self-derived free-flow baseline (85th
  percentile), with native reference speeds where a feed ships one and OSM `maxspeed` as a day-one proxy.
  See [docs/speed-coverage.md](docs/speed-coverage.md).
- **Emitters:** a paged record API, GeoJSON, JSON-LD, TraFF, DATEX II, Valhalla exclusions, and an SSE stream —
  all public, rate-limited, and bbox-filterable.
- **Graph binding:** road situations, and effects with a location of their own, are bound to the directed
  OSM segment spine (`way_id:f|b` spans with confidence); see [docs/graph-binding.md](docs/graph-binding.md).
- **OpenMapX integration:** ships as an installable extension (a service + a provider integration).
- **TMC location tables:** publishers that send Alert-C location codes instead of coordinates are placed
  against the published national table (Germany's LCL 22.0, CC BY 4.0), behind a strict table-version guard.
  See [docs/tmc-location-tables.md](docs/tmc-location-tables.md).
- **OpenLR resolver:** built and tested, but **dormant** — no open feed currently carries OpenLR (the open
  feeds use coordinates or Alert-C/TMC). It activates when an OpenLR-bearing source is configured.

## Architecture

Road events are stored as model situations, each with its effects and revisions ([model](docs/model.md),
[storage](docs/storage.md)); flow speeds and crowd reports are `Observation` rows in `conditions.observations`.
Three layers:

```
packages/          reusable libraries (Apache-2.0)
  core/            canonical model, severity, freshness, read helpers, DB schema/migrations (./server)
  roads/           road-domain parsers (DATEX II / Open511 / WZDx) + feed registry + TMC location tables
    bind/          event → segment resolver + evaluation corpus
  publishers/      outbound emitters (GeoJSON, JSON-LD, TraFF, DATEX II, SSE, Valhalla)
  openlr/          OpenLR binary decode + resolver client

services/          deployable services
  ingest/          Fastify: fetch → parse → write records, bind + public record API and routing outputs; ships
                   the OpenMapX service.json so `repos add` can install it (AGPL-3.0)
  openlr-resolver/ Python/FastAPI OpenLR → geometry map-matcher (dormant)

integrations/
  road-conditions-openconditions/   OpenMapX provider integration (reads situations over HTTP into the map and routing)
```

The ingest service owns and migrates the `conditions` schema itself, idempotently, on boot.

## Quick start

Requires Node 24+ and pnpm 11+ (and a reachable PostGIS).

```bash
pnpm install
pnpm build

DATABASE_URL=postgres://postgres:postgres@localhost:5432/openconditions \
  pnpm --filter @openconditions/ingest dev
```

The service applies its migrations, starts polling the enabled feeds, and serves on `:4100`.

### Public API

Road situations are served as model records ([model](docs/model.md)). Collections take the same
filters (`bbox=west,south,east,north`, `kind`, `type`, `domain`, `source`, `origin`, `minSeverity`,
`at`, `horizonDays`) and are paged by a keyset cursor: follow `next` (JSON) or the `Link: rel="next"`
header (XML) until there is none. Everything is rate-limited; `GET /openapi.json` describes it all.

| Endpoint                             | Content                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `GET /situations`                    | Situations as JSON records `{records, next}`                                                  |
| `GET /situations.geojson`, `.jsonld` | The same as GeoJSON, or GeoJSON-LD (SOSA/Schema.org `@context`)                               |
| `GET /situations/{id}`               | One situation with its evidence and graph binding                                             |
| `GET /history/{class}/{id}`          | A record's revisions and what changed                                                         |
| `GET /traff.xml`                     | TraFF (CoMaps / Navit)                                                                        |
| `GET /datex2/situations.xml`         | DATEX II v3 SituationPublication, one record per effect ([status](docs/datex-conformance.md)) |
| `GET /stream`                        | Server-Sent Events: live situations, then each change and removal                             |
| `GET /valhalla/exclusions.json`      | Valhalla `exclude_locations` / `exclude_polygons` and speed caps                              |
| `GET /segments/conditions.json`      | Bound effects in force, keyed by directed OSM way spans (routing feed)                        |
| `GET /taxonomy`, `/schemas/{path}`   | The running registry and its JSON Schemas                                                     |
| `GET /coverage`                      | Live records per country, kind and access mode                                                |
| `GET /status`                        | health (unlimited)                                                                            |

## Using OpenConditions with OpenMapX

OpenConditions installs into an OpenMapX deployment as a community extension:

```bash
pnpm openmapx repos add https://github.com/openconditions/openconditions
pnpm openmapx services enable openconditions-ingest
pnpm openmapx compose render && pnpm openmapx compose up
# then install the road-conditions-openconditions provider integration artifact
```

See OpenMapX's _Building an external extension_ guide for the full flow. The provider integration reads situations
and their routing evidence from the ingest's API into the OpenMapX map overlay and routing avoidance.

## Crowd reporting

Pseudonymous contributors can augment the official feeds with signed
road-condition reports. Read [what crowd reporting is — and the guarantees we
deliberately do NOT make](docs/crowd-reporting-limitations.md) before relying on
it.

## Published artifacts

- npm: `@openconditions/core`, `@openconditions/roads` (prebuilt, public)
- images: `ghcr.io/openconditions/ingest`, `ghcr.io/openconditions/openlr-resolver`
- **static archive:** a nightly [GeoParquet snapshot of the published view](docs/archive.md) —
  the mirrorable artifact for seeding a new instance or backfilling a federation peer
  (license/expiry/tombstone enforced, no raw crowd evidence, no probe staging)

Releases are cut by tagging `vX.Y.Z` (see [`.github/workflows/release.yml`](.github/workflows/release.yml)).

## License

A two-license split — see [LICENSING.md](LICENSING.md):

- **AGPL-3.0-or-later** — the ingest service (the deployable network commons server).
- **Apache-2.0** — the reusable `@openconditions/*` libraries, the OpenMapX provider integration, and the
  standalone OpenLR resolver.
- **Source data** keeps each feed's upstream license (CC0 / CC-BY / dl-de/by / OGL / …); OSM-derived data is
  ODbL. Observations carry their `source_license`, and the emitters can filter share-alike-incompatible records
  out of permissive exports.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the quality bar, [SUPPORT.md](SUPPORT.md) for
where to ask questions, and the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted under a
[CLA](CLA.md).
