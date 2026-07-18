# Speed & congestion coverage

The speed/flow layer is **government point-sensor coverage on motorways and
major highways** across a spread of countries — **not** full-network live
traffic. A road with no nearby sensor carries no speed observation.

## Feed roster

Every feed below is a `produces: "flow"` source in `packages/roads/feeds/roads`;
each emits a per-sensor speed reading where the upstream carries one. This table
is the current set — the authoritative definition (URLs, cadence, credential
fields) lives in those feed files, and the credential-bearing subset is
regenerated into [`road-feed-credentials.md`](./road-feed-credentials.md).

| feed id                | region               | format              | keyed                        | license              |
| ---------------------- | -------------------- | ------------------- | ---------------------------- | -------------------- |
| `be-miv`               | Flanders, Belgium    | `miv`               | no                           | CC-BY-4.0            |
| `es-madrid`            | Madrid, Spain        | `informo`           | no                           | CC-BY-4.0            |
| `gb-webtris`           | Great Britain        | `webtris`           | no, **disabled by default**  | OGL-UK-3.0           |
| `fr-dir-flow`          | France (DIR/QTV-DIR) | `datex2`            | no                           | etalab-2.0           |
| `hk-td`                | Hong Kong            | `hk-td`             | no                           | HK-Gov-Open-Data     |
| `de-bonn`              | Bonn, Germany        | `bonn`              | no                           | dl-de/zero-2-0       |
| `it-turin`             | Turin, Italy         | `fdt`               | no                           | CC-BY-4.0            |
| `fi-fintraffic`        | Finland              | `fintraffic-tms`    | no                           | CC-BY-4.0            |
| `nl-ndw-flow`          | Netherlands          | `datex2`            | no                           | CC0-1.0              |
| `us-nyc-dot`           | New York City, US    | `nyc-dot`           | no (optional token)          | NYC-Open-Data        |
| `us-oh-ohgo`           | Ohio, US             | `ohgo`              | yes (`OHGO_API_KEY`)         | US-Gov-Public-Domain |
| `se-trafikverket-flow` | Sweden               | `trafikverket-flow` | yes (`TRAFIKVERKET_API_KEY`) | CC0-1.0              |
| `no-vegvesen-flow`     | Norway               | `datex2`            | yes, **disabled by default** | NLOD-2.0             |
| `sg-lta-speedbands`    | Singapore            | `lta-speedbands`    | yes, **disabled by default** | Singapore-ODL-1.0    |

`gb-webtris` is disabled by default: WebTRIS publishes quality-checked
_historical_ traffic data lagged roughly 6-8 weeks — a query for a recent date
window returns HTTP 204 (no content), and even the older data it does hold
falls outside the 28-day free-flow baseline-derivation window
(`deriveBaselines`'s default `windowDays`), so it never contributes to the
live pipeline. An operator who wants the historical samples anyway can flip
`enabledByDefault` on `gb-webtris` and widen the derive window to reach back
far enough.

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
event is emitted at queuing or worse.

## Keyed sources

Some speed feeds need a free credential and stay dormant until it is set; the
full list with registration links is in
[`road-feed-credentials.md`](./road-feed-credentials.md). The speed-layer ones:

- **OHGO (Ohio)** — `OHGO_API_KEY` (ohgo.com/developer).
- **Trafikverket (Sweden)** — `TRAFIKVERKET_API_KEY`
  (api.trafikinfo.trafikverket.se).
- **LTA DataMall Speed Bands (Singapore)** — `LTA_ACCOUNT_KEY`; disabled by
  default until the key is set.
- **Statens vegvesen (Norway)** — `NO_VEGVESEN_USERNAME` /
  `NO_VEGVESEN_PASSWORD`; disabled by default until credentials are set.

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
  `france-comptage-csv`; the Norway DATEX feed is credential-gated and off by
  default.
