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
  spanning DATEX II, Open511, and WZDx GeoJSON — plus NDW traffic-speed as `Measurement` flow.
- **Emitters:** GeoJSON, TraFF, DATEX II, GTFS-RT Alert, JSON-LD, Valhalla exclusions, and an SSE stream —
  all public, rate-limited, and bbox-filterable.
- **OpenMapX integration:** ships as an installable extension (a service + a provider integration).
- **OpenLR resolver:** built and tested, but **dormant** — no open feed currently carries OpenLR (the open
  feeds use coordinates or Alert-C/TMC). It activates when an OpenLR-bearing source is configured.

## Architecture

A two-axis canonical model — every record is an `Observation`, either a `ConditionEvent` (an incident, closure,
…) or a `Measurement` (a flow speed, …) — stored in a single generic `conditions.observations` PostGIS table.
Three layers:

```
packages/          reusable libraries (Apache-2.0)
  core/            canonical model, severity, freshness, read helpers, DB schema/migrations (./server)
  roads/           road-domain parsers (DATEX II / Open511 / WZDx) + feed registry
  publishers/      outbound emitters (GeoJSON, TraFF, DATEX II, GTFS-RT, JSON-LD, Valhalla)
  openlr/          OpenLR binary decode + resolver client

services/          deployable services
  ingest/          Fastify: fetch → parse → atomic PostGIS swap + public emitter feeds; ships
                   the OpenMapX service.json so `repos add` can install it (AGPL-3.0)
  openlr-resolver/ Python/FastAPI OpenLR → geometry map-matcher (dormant)

integrations/
  road-conditions-openconditions/   OpenMapX provider integration (reads observations back into the map)
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

### Public emitter feeds

All are bbox-filterable (`?bbox=west,south,east,north[&domain=roads]`) and rate-limited:

| Endpoint                        | Format                                            |
| ------------------------------- | ------------------------------------------------- |
| `GET /observations.geojson`     | GeoJSON FeatureCollection                         |
| `GET /observations.jsonld`      | JSON-LD (SOSA/Schema.org `@context`)              |
| `GET /traff.xml`                | TraFF (CoMaps / Navit)                            |
| `GET /datex2/situations.xml`    | DATEX II v3 SituationPublication                  |
| `GET /gtfs-rt/alerts.pb`        | GTFS-RT Alert (protobuf)                          |
| `GET /valhalla/exclusions.json` | Valhalla `exclude_locations` / `exclude_polygons` |
| `GET /stream`                   | Server-Sent Events (snapshot + live deltas)       |
| `GET /status`                   | health (unlimited)                                |

## Using OpenConditions with OpenMapX

OpenConditions installs into an OpenMapX deployment as a community extension:

```bash
pnpm openmapx repos add https://github.com/openconditions/openconditions
pnpm openmapx services enable openconditions-ingest
pnpm openmapx compose render && pnpm openmapx compose up
# then install the road-conditions-openconditions provider integration artifact
```

See OpenMapX's _Building an external extension_ guide for the full flow. The ingest writes to the shared PostGIS
`conditions` schema; the provider integration reads it back into the OpenMapX map overlay and routing avoidance.

## Published artifacts

- npm: `@openconditions/core`, `@openconditions/roads` (prebuilt, public)
- images: `ghcr.io/openconditions/ingest`, `ghcr.io/openconditions/openlr-resolver`

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
