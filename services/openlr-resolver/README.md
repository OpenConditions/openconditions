# openlr-resolver

An HTTP microservice that map-matches OpenLR location references onto an
OSM-derived road graph and returns geometry. It is the server side of the
`MapMatchClient` defined in `@openconditions/openlr`: the ingest pipeline POSTs
a decoded OpenLR location and gets back a GeoJSON line.

The service is built in Python on top of
[`openlr-dereferencer`](https://github.com/tomtom-international/openlr-dereferencer-python)
(the map-matching engine) and [`openlr`](https://github.com/tomtom-international/python-openlr)
(the binary codec and location datatypes). It runs as a standalone Docker
sidecar, separate from the TypeScript monorepo.

## Status: complete but dormant (no live OpenLR source yet)

The resolver, the `@openconditions/openlr` decoder, and the ingest resolve stage
are implemented and tested — but **nothing currently feeds them**, because none
of the ingested open feeds carry OpenLR references:

- **NDW** (`actueel_beeld`) uses **Alert-C / TMC** (`alertCLinear`, `alertCPoint`)
  plus WGS84 coordinates (`pointByCoordinates`) — **zero** OpenLR elements.
- Autobahn, Digitraffic, DriveBC and WZDx are coordinate/GeoJSON-based.

OpenLR-only location referencing is largely a commercial-feed (TomTom/HERE)
convention; open government feeds publish coordinates or TMC. So the resolver is
ready infrastructure waiting on a source. To activate it:

1. **Add a reference-only / OpenLR-carrying feed** to `@openconditions/roads`'
   `FEED_SOURCES` (set `openlrResolver: true`), set `OPENLR_RESOLVER_URL` on the
   ingest service, and load a real OSM graph (see [Building the graph](#building-the-graph)).
   The ingest resolve stage then fills geometry for those records automatically.
2. Or use it for **edge precision** when a feed carries *both* a coordinate and
   an OpenLR linear (prefer the resolved line for closures) — no current feed does.

The realistic future unlock for **NDW** specifically is **Alert-C / TMC**
decoding, which is a *different* path (a licensed TMC location-code database, not
OpenLR) and is deferred by design — see the spec's location-referencing notes.
Until a source exists, this service intentionally has no enabled feed and runs
against fixtures only in CI.

## Wire contract

### `POST /resolve`

Body — exactly one of:

```jsonc
{ "location": { "type": "line", "points": [ /* LrpPoint[] */ ], "positiveOffset": 0, "negativeOffset": 0 } }
```

or the convenience form (decoded server-side):

```jsonc
{ "openlr": "<base64 OpenLR binary>" }
```

`LrpPoint` mirrors the `@openconditions/openlr` decoder output:
`{ sequenceNumber, longitude, latitude, frc, fow, lfrcnp, bearing, distanceToNext, isLast }`.

Responses:

- `200` — `{ "geometry": <GeoJSON LineString>, "confidence": <0..1> }`. The
  geometry is trimmed/extended by the positive/negative offsets.
- `404` — `{ "detail": { "error": "no_match", "reason": "…" } }` when no
  DNP-consistent path is found.
- `400` — neither field supplied, or an invalid OpenLR binary.

### `GET /health`

Returns `200 { "status": "ok" }`.

## The road graph

Matching runs against a graph in two PostGIS tables (`DATABASE_URL` selects the
database, same convention as the ingest service):

- `conditions.osm_nodes(node_id BIGINT PK, geom geometry(Point,4326))`
- `conditions.osm_lines(line_id BIGSERIAL PK, way_id BIGINT, start_node BIGINT,
  end_node BIGINT, frc SMALLINT, fow SMALLINT, oneway BOOLEAN,
  geom geometry(LineString,4326))`

Each `osm_lines` row is one **directed** edge. A one-way OSM way yields one
edge; a bidirectional way yields a forward and a reversed edge, so travel
direction is always explicit (OpenLR matching is direction-sensitive). Both
tables get a GiST index on `geom`.

### OSM → FRC/FOW mapping

`scripts/build_graph.py` classifies every drivable `highway=*` way into an
OpenLR Functional Road Class (importance, 0 = highest) and Form of Way
(physical type). The mapping (`app/frc_fow.py`) follows the OpenLR reference /
TomTom OSM-adapter conventions:

| OSM `highway`            | FRC  | FOW                  |
| ------------------------ | ---- | -------------------- |
| `motorway`               | FRC0 | MOTORWAY             |
| `motorway_link`          | FRC0 | SLIPROAD             |
| `trunk`                  | FRC1 | MULTIPLE_CARRIAGEWAY |
| `primary`                | FRC2 | MULTIPLE_CARRIAGEWAY |
| `secondary`              | FRC3 | SINGLE_CARRIAGEWAY   |
| `tertiary`               | FRC4 | SINGLE_CARRIAGEWAY   |
| `unclassified`           | FRC5 | SINGLE_CARRIAGEWAY   |
| `residential`/`living_street` | FRC6 | SINGLE_CARRIAGEWAY |
| `service`                | FRC7 | SINGLE_CARRIAGEWAY   |
| `*_link`                 | parent FRC | SLIPROAD       |
| `junction=roundabout`    | by class | ROUNDABOUT       |

Non-vehicular ways (`footway`, `path`, `cycleway`, …) are skipped.

## Building the graph

Small fixture (used by the tests, committed):

```sh
python -m scripts.build_graph --pbf tests/fixtures/tiny_roads.osm --database-url "$DATABASE_URL"
```

Full Netherlands extract (the production target). The Geofabrik
`netherlands-latest.osm.pbf` is roughly **1.3 GB**; the drivable road subset
loaded into PostGIS is much smaller. Download and build are intentionally a
manual operational step — **not run by CI or the tests**:

```sh
curl -L -o netherlands-latest.osm.pbf \
  https://download.geofabrik.de/europe/netherlands-latest.osm.pbf
python -m scripts.build_graph --pbf netherlands-latest.osm.pbf --database-url "$DATABASE_URL"
```

## Development

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest                 # unit + PostGIS-testcontainer integration tests
python -m app          # run the service (PORT defaults to 4200)
```

The PostGIS integration tests require Docker and are skipped automatically when
it is unavailable.

## Docker

```sh
docker build -t ghcr.io/openconditions/openlr-resolver .
docker run -e DATABASE_URL=... -p 4200:4200 ghcr.io/openconditions/openlr-resolver
```
