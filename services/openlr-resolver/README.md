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
