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
