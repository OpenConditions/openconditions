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
  spanning DATEX II, Open511, and WZDx GeoJSON — plus government point-sensor **traffic flow** (speed,
  volume, occupancy, level of service) from 24 flow feeds, among them Fintraffic (FI), WebTRIS (GB),
  NYC DOT (US-NY), NDW (NL), OHGO (US-OH, keyed) and Trafikverket (SE, keyed), as measurement sites and
  their readings. Congestion is computed from a self-derived free-flow baseline (85th
  percentile), with native reference speeds where a feed ships one and OSM `maxspeed` as a day-one proxy.
  See [docs/speed-coverage.md](docs/speed-coverage.md).
- **Emitters:** a paged record API, GeoJSON, JSON-LD, TraFF, DATEX II, Valhalla exclusions, and an SSE stream —
  all public, rate-limited, and bbox-filterable.
- **Graph binding:** road situations, and effects with a location of their own, are bound to the directed
  OSM segment spine (`way_id:f|b` spans with confidence); see [docs/graph-binding.md](docs/graph-binding.md).
- **Fuel domain:** station fuel prices from Tankerkönig (DE), E-Control (AT), Prix Carburants (FR), MITECO (ES)
  and OpenStreetMap, as features with per-grade price components; the Tankerkönig, E-Control and OpenStreetMap feeds are
  fetched on demand for the area a read asks about.
- **Parking domain:** car parks, garages and lorry parks with their spaces by kind, live occupancy and tariffs
  from 23 feeds in 13 countries, among them MobiData BW (DE, with Toll Collect's lorry parks Germany-wide),
  Mobidrom NRW (DE), RDW and NDW (NL), SBB and Basel (CH), HDB (SG) and OpenStreetMap, read on demand. A
  publisher's plain GeoJSON, JSON or CSV table is mapped in the catalogue with no code; see
  [feeds/README.md](feeds/README.md#generic-layouts).
- **Charging domain:** charging sites with their charge points (EVSEs), connectors, live charge-point status and
  tariffs from 24 feeds (a 25th, Poland's EIPA, waits for its registration): access points and registers
  covering 21 countries (OCPI from NDW, MobiData BW and Via
  Lietuva; OICP from BFE; DATEX II from DGT and NAP Slovenija; the Bundesnetzagentur register, the French IRVE
  base, AFDC for the US and Canada, NOBIL for Norway and Sweden, and more), Open Charge Map and OpenStreetMap,
  the last two read on demand.
- **Cameras domain:** traffic, weather and landscape cameras with their views and each view's latest still
  from 20 feeds: Digitraffic (FI), Trafikverket (SE), Statens vegvesen (NO), Vegagerðin (IS), DGT (ES),
  Ontario 511 (CA), the Transport Department (HK), Live Traffic NSW (AU), TDX (TW), TfL (GB), Caltrans, the
  National Park Service, ODOT TripCheck and five IBI 511 states (US), and Windy and OpenStreetMap, the last two
  read on demand. Each feed whose records carry proxyable stills declares the hosts they come from, which
  `GET /sources` serves for a consumer's image proxy (`osm-cameras` and `us-nps-cameras` declare none), and an OpenStreetMap webcam links with the publisher's camera it stands beside.
- **OpenMapX integration:** ships as an installable extension (the ingest and contributions services, serving
  the roads, fuel, parking, charging and cameras domains); OpenMapX reads them through its built-in OpenConditions integration.
- **TMC location tables:** publishers that send Alert-C location codes instead of coordinates are placed
  against the published national table (Germany's LCL 22.0, CC BY 4.0), behind a strict table-version guard.
  See [docs/tmc-location-tables.md](docs/tmc-location-tables.md).
- **OpenLR resolver:** built and tested, but **dormant** — no open feed currently carries OpenLR (the open
  feeds use coordinates or Alert-C/TMC). It activates when an OpenLR-bearing source is configured.

## Architecture

Road events are stored as model situations, each with its effects and revisions ([model](docs/model.md),
[storage](docs/storage.md)); flow feeds write measurement sites as model features and their speeds,
volumes and levels of service as model observations (the latest reading per series, a partitioned history
and hourly rollups).
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

Road situations, measurement sites and facilities (features), tariffs (offers) and readings
(observations) are served as model records ([model](docs/model.md)). Collections take the same
filters (`bbox=west,south,east,north`, `kind`, `type`, `domain`, `source`, `origin`, `at`; situations
also `minSeverity` and `horizonDays`, readings `property`) and are paged by a keyset cursor: follow
`next` (JSON) or the `Link: rel="next"` header (XML) until there is none. `canonical=1` serves the
canonical view: one feature per cluster of features several sources describe, and the fused reading of
a property several sources or the crowd report. Everything is rate-limited; `GET /openapi.json`
describes it all, and [storage](docs/storage.md#read-api) says what each route reads.

| Endpoint                             | Content                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /situations`                    | Situations as JSON records `{records, next}`                                                                                   |
| `GET /situations.geojson`, `.jsonld` | The same as GeoJSON, or GeoJSON-LD (SOSA/Schema.org `@context`)                                                                |
| `GET /situations/{id}`               | One situation with its evidence and graph binding                                                                              |
| `GET /features`                      | Features as JSON records; components with `expand=components`, the canonical view with `canonical=1`                           |
| `GET /features.geojson`, `.jsonld`   | The same as GeoJSON, or GeoJSON-LD                                                                                             |
| `GET /features/{id}`                 | One feature with its components and its canonical cluster (a canonical id serves the cluster)                                  |
| `GET /offers`, `/offers/{id}`        | Tariffs as JSON records, or one                                                                                                |
| `GET /observations/latest`           | The reading in effect of every series, paged by series                                                                         |
| `GET /observations`                  | One series (`subject`, `property`, `qualifiers`, `from`, `to`): raw readings, or hourly/daily rollups beyond the raw retention |
| `GET /history/{class}/{id}`          | A record's revisions and what changed                                                                                          |
| `GET /traff.xml`                     | TraFF (CoMaps / Navit)                                                                                                         |
| `GET /datex2/situations.xml`         | DATEX II v3 SituationPublication, one record per effect ([status](docs/datex-conformance.md))                                  |
| `GET /stream`                        | Server-Sent Events: live situations, then each change and removal                                                              |
| `GET /valhalla/exclusions.json`      | Valhalla `exclude_locations` / `exclude_polygons` and speed caps                                                               |
| `GET /segments/conditions.json`      | Bound effects in force, keyed by directed OSM way spans (routing feed)                                                         |
| `GET /taxonomy`, `/schemas/{path}`   | The running registry and its JSON Schemas                                                                                      |
| `GET /coverage`                      | Live records per country, kind and access mode; live series per property                                                       |
| `GET /status`                        | health (unlimited)                                                                                                             |

## Using OpenConditions with OpenMapX

OpenConditions installs into an OpenMapX deployment as an extension, in one step:

```bash
pnpm openmapx ext install openconditions
```

This registers both services (ingest and contributions API) at their pinned tag and starts them. It installs no
integration code: OpenMapX's built-in `openconditions` integration reads them once `OPENCONDITIONS_URL` (and, for
Tankerkönig (DE), E-Control (AT) and OpenStreetMap fuel stations, for the share-alike parking and charging
feeds and for the Windy, OpenStreetMap and US 511 cameras, `OPENCONDITIONS_OPERATOR_TOKEN`) is set in OpenMapX's
`.env`. It feeds the roads domain (conditions overlay, routing avoidance, live traffic), the fuel domain (fuel
stations and prices), the parking domain (car parks and their occupancy), the charging domain (charging sites,
charge-point status and tariffs) and the cameras domain (the webcam layer and its stills).

OpenMapX passes a community service's `container.environment` to the container verbatim, so the services'
configuration is `configSchema` fields: set the database URL (and the contributions API's grant secret and
reviewer token) once as secrets in the admin services panel. Until they are set, both services stop at boot
and their containers restart in a loop; once they are, apply the change and the services start. Set any
setting there, or as `SERVICE_OPENCONDITIONS_INGEST_<KEY>` in OpenMapX's `.env`. Settings kept in OpenMapX's
`.env` are applied with `pnpm openmapx services start openconditions-ingest` (which resets every setting saved
only in the admin form, so keep all of them in one place). Settings saved in the form are applied with
**Save & Apply**. See
[services/ingest/README.md](services/ingest/README.md#configuration-under-openmapx).

See OpenMapX's _Building an external extension_ guide for the full flow. OpenMapX's built-in OpenConditions
integration reads roads situations, routing evidence, fuel features, parking sites, charging sites and cameras
from the ingest's API into the map overlay, routing avoidance, fuel search, the parking layer, the EV charging
layer and the webcam layer. A request carrying `Authorization: Bearer
<OPENCONDITIONS_OPERATOR_TOKEN>` reads in the operator scope, which withholds nothing; without it a read is
public-scope. Reads with a bbox fetch stale on-demand feeds first, waiting at most
`OPENCONDITIONS_ON_DEMAND_DEADLINE_MS` (default 3000). See [services/ingest/README.md](services/ingest/README.md).

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
- **Apache-2.0** — the reusable `@openconditions/*` libraries and the
  standalone OpenLR resolver.
- **Source data** keeps each feed's upstream license (CC0 / CC-BY / dl-de/by / OGL / …); OSM-derived data is
  ODbL. Every record carries its licence; public exports (the public API, federation, the archive and the
  emitters) carry only records whose licence grants redistribution and is not share-alike, and never a record
  of a source whose terms restrict it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the quality bar, [SUPPORT.md](SUPPORT.md) for
where to ask questions, and the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted under a
[CLA](CLA.md).
