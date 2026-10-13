# Speed & congestion coverage

The speed/flow layer is **government point-sensor coverage on motorways and
major highways** across a spread of countries — **not** full-network live
traffic. A road with no nearby sensor carries no speed observation.

## Feed roster

Every feed below is a `product: "flow"` feed in `feeds/roads/`; each emits a
per-sensor speed reading where the upstream carries one. The region files hold
24 flow feeds in all; this table lists a part of them — the authoritative
definition (URLs, cadence, credential fields) lives in those files, and the
credential-bearing subset is regenerated into
[`feed-credentials.md`](./feed-credentials.md).

| feed id                | region               | format              | keyed                           | license                         |
| ---------------------- | -------------------- | ------------------- | ------------------------------- | ------------------------------- |
| `be-miv-flow`          | Flanders, Belgium    | `miv`               | no                              | CC-BY-4.0                       |
| `es-madrid-flow`       | Madrid, Spain        | `informo`           | no                              | CC-BY-4.0                       |
| `fr-dir-flow`          | France (DIR/QTV-DIR) | `datex2-measured`   | no                              | etalab-2.0                      |
| `hk-td-flow`           | Hong Kong            | `hk-td`             | no                              | LicenseRef-HK-Gov-Open-Data     |
| `de-nw-bonn-flow`      | Bonn, Germany        | `bonn`              | no                              | DL-DE-ZERO-2.0                  |
| `it-turin-flow`        | Turin, Italy         | `fdt`               | no                              | CC-BY-4.0                       |
| `fi-fintraffic-flow`   | Finland              | `fintraffic-tms`    | no                              | CC-BY-4.0                       |
| `nl-ndw-flow`          | Netherlands          | `datex2-measured`   | no                              | CC0-1.0                         |
| `us-nyc-dot-flow`      | New York City, US    | `nyc-dot`           | no                              | LicenseRef-NYC-Open-Data        |
| `us-oh-ohgo-flow`      | Ohio, US             | `ohgo`              | yes (`US_OH_OHGO_API_KEY`)      | LicenseRef-US-Gov-Public-Domain |
| `se-trafikverket-flow` | Sweden               | `trafikverket-flow` | yes (`SE_TRAFIKVERKET_API_KEY`) | CC0-1.0                         |
| `no-vegvesen-flow`     | Norway               | `datex2-measured`   | yes (`NO_VEGVESEN_*`)           | NLOD-2.0                        |
| `sg-lta-flow`          | Singapore            | `lta-speedbands`    | yes (`SG_LTA_API_KEY`)          | LicenseRef-Singapore-ODL-1.0    |

There is no per-feed enable switch: a feed runs as soon as its credentials are
set (a keyless feed always runs). The keyed speed feeds above therefore stay
dormant only until their credential is configured. (WebTRIS/Great Britain was
dropped: it publishes quality-checked data lagged ~4-8 weeks — recent-date
queries return HTTP 204 — so its yesterday→today fetch window could never
ingest anything and it never contributed to the live pipeline.)

## How congestion is derived

Level-of-service is computed from the ratio of the observed speed to a
free-flow baseline for that sensor:

- **native** — the feed ships a reference speed (OHGO `NormalAvgSpeed` inline;
  Fintraffic VVAPAAS from the sensor-constants endpoint).
- **derived** — a rolling 85th-percentile of the sensor's own recent history,
  bucketed by weekday/weekend and hour of day (UTC; local-timezone bucketing is
  a planned refinement).
- **osm_maxspeed** — a bounded day-one proxy from the nearest OSM `maxspeed`,
  used only until enough history accrues.

Priority is native > derived > osm_maxspeed. Thresholds (share of free-flow):
≥ 0.85 free-flow, ≥ 0.5 heavy, ≥ 0.15 queuing, else stationary. A congestion
situation is derived at queuing or worse; it is stored and bound to the segment
spine like any other road situation.

## Keyed sources

Some speed feeds need a free credential and stay dormant until it is set; the
full list with registration links is in
[`feed-credentials.md`](./feed-credentials.md). The speed-layer ones:

- **OHGO (Ohio)** — `US_OH_OHGO_API_KEY` (ohgo.com/developer).
- **Trafikverket (Sweden)** — `SE_TRAFIKVERKET_API_KEY`
  (api.trafikinfo.trafikverket.se).
- **LTA DataMall Speed Bands (Singapore)** — `SG_LTA_API_KEY`; dormant
  until the key is set.
- **Statens vegvesen (Norway)** — `NO_VEGVESEN_USER` /
  `NO_VEGVESEN_PASSWORD`; dormant until credentials are set.

## Known export limitation

Point-sensor congestion (Fintraffic, OHGO, Trafikverket) emits **Point**
geometry, and direction is set only where the feed carries it (Fintraffic,
OHGO). DATEX II models this correctly as-is: `loc:PointLocation` is a valid
DATEX II v3 location type for a point sensor, so no linear geometry is needed
and the emitter never fabricates one by buffering a point into a segment (see
`docs/datex-conformance.md` for what full SRTI conformance still requires).
**CIFS** (Waze/Google) is not built yet and does expect a linear polyline plus
a direction; how a point-sensor reading should project into a CIFS `line` is
an open design question left to whenever CIFS is actually implemented — it
must not silently invent geometry either.

## Excluded / deferred

- **511NY developer API** — no speed field. Excluded (NYC DOT Socrata is used
  for New York City speed instead).
- **Norway and France are now included** (`no-vegvesen-flow`, `fr-dir-flow`
  in the roster above) — both were previously deferred here. The France feed
  (QTV-DIR) resolves its CSV site table (Lambert-93 → WGS84) via
  `france-comptage-csv`; the Norway DATEX feed is credential-gated (dormant
  until credentials are set).

## Selected display contributors

Migration `0068_flow_field_lineage` adds version 1 field lineage to the live
segment surface. `GET /segments.geojson` properties include `lineage_version: 1`,
`field_sources`, `field_contributors` and `field_lineage_complete`; `conditions.segment_flow` encodes the
three maps as JSON strings in MVT attributes. Each map has independent `speed`,
`freeFlow`, `ratio`, `los`, `confidence` and `geometry` keys when the field's lineage is known.
Source IDs are canonical display identities: a catalogue child credits its parent,
and the OSM segment spine credits `openstreetmap`.

Display credits have `{ sourceId, name, url?, licensing?,
attributionText?, publisher?: { name, url? }, notes?, retrievedAt? }`. A required
verbatim notice is an additional credit with the parent's source ID and the notice
as its `name`. Deduplicate identical credits, rather than source IDs, so the notice
survives. Migration `0069_captured_licensing` carries captured scoped definitions
through these credits and the OSM geometry credit; it changes functions only.
See [licence metadata](licensing.md) for the display contract. An unknown source keeps its proven ID and any available provenance;
missing catalogue metadata is never replaced with an unrelated feed's credit.

The speed winner follows tier and freshness. Declared LOS uses every supplier tied
at the worst declared rank; otherwise LOS inherits the selected speed ratio's
suppliers. Ratio credits its actual numerator and denominator. A native or derived
sensor baseline credits that measurement source; `osm_maxspeed` and graph fallback
credit OpenStreetMap. A propagated speed keeps the donor's speed receipt, while its
free-flow speed and geometry come from the target OSM segment. Producer-derived
`measured` confidence credits the selected speed supplier when present, otherwise
the selected worst declared LOS ties. `estimated` confidence credits the donor
speed and the OSM geometry used to establish the estimate; it does not require a
known free-flow denominator.

The shared observation writer captures each actual input before aggregation in
an immutable version-1 `contributor_receipt` dictionary. The nullable
`observation_latest.contributor_receipt_id` points to the receipt; canonical record
bodies and content hashes are unchanged. A bounded write slice captures once per
distinct source attribution, not once per reading. Aggregation unions each selected
input's stored receipt. If one of two sites changes, the other site's original name,
licence and mandatory notice survive alongside the newly acquired receipt, even
when both canonical source IDs match. Catalogue edits and LOS heartbeats never
refresh an existing unchanged input's receipt. A changed reading, baseline or
actual attribution acquires a new snapshot. Captured parent identity takes priority
over later catalogue reparenting.

`field_lineage_complete` reports a boolean per field, encoded as a JSON string in
MVT. Known partial credits remain in `field_contributors` and `field_sources` when
another dependency is historically unknown; a wholly unknown field omits those
keys. For example, a propagated legacy speed can still credit its proven target OSM
denominator and geometry, while `ratio` and `confidence` completeness are false.
Missing or incomplete lineage never authorizes guessing credits from collection
source lists. Non-sensor segment writers must capture their own field receipts and
explicit denominator origins alongside the measurement. Native field IDs remain
separate; `segment_speed.contributing` retains every live native rights supplier,
including losing speed sources. Public GeoJSON and tiles withhold all measurement
fields and their receipts when any rights contributor is restricted, retaining the
public OSM geometry.

The migration deletes no observations or valid scalar measurements and does not
backfill historical credits from the current catalogue. A fresh admitted acquisition
can attach the first receipt to an unchanged legacy input with the explicit writer
option `captureEvidence: "acquired"`. Fusion, status heartbeats, 304 responses and
held-cache replay cannot do so. The polling runner sets this evidence only when all
data roles provide `bodyFreshness: "acquired"` certificates for every parsed body.
Cached `each.keepSec` items, directory-walk stand-ins and mixed 200/304 bodies
carry `bodyFreshness: "held"`, even when the role reports `fetched`; on-demand publication
sets it after a successful fresh parse. Mixed-role replay waits for a fully acquired
batch to upgrade unknown inputs. Existing non-null receipts stay stable on no-op
writes. The next normal sensor/fusion sweep composes whatever input receipts have
actually been captured.

For rendering, credit geometry for a casing, `ratio` when a non-null ratio drives
color, and `los` when color falls back to declared LOS. Opacity driven by confidence credits the separate `confidence` receipt. A popup selects the separate
receipts of each field it displays. Unioning all fields for every rendered segment
would credit hidden inputs.
