# Speed & congestion coverage

The speed/flow layer is **government point-sensor coverage on motorways and
major highways** — Finland, Great Britain, Sweden, Ohio, New York City, and the
Netherlands — **not** full-network live traffic. A road with no nearby sensor
carries no speed observation.

## Feed roster

| feed id                | region            | format                   | keyed                        | license              |
| ---------------------- | ----------------- | ------------------------ | ---------------------------- | -------------------- |
| `fintraffic-tms-fi`    | Finland           | `fintraffic-tms-json`    | no                           | CC-BY-4.0            |
| `webtris-gb`           | Great Britain     | `webtris-json`           | no, **disabled by default**  | OGL-UK-3.0           |
| `nyc-dot-speed-us`     | New York City, US | `nyc-dot-speed-json`     | no (optional token)          | NYC-Open-Data        |
| `ohgo-oh-us`           | Ohio, US          | `ohgo-json`              | yes (`OHGO_API_KEY`)         | US-Gov-Public-Domain |
| `trafikverket-flow-se` | Sweden            | `trafikverket-flow-json` | yes (`TRAFIKVERKET_API_KEY`) | CC0-1.0              |

NDW (Netherlands) also carries traffic speed as part of its existing DATEX II
`Measurement` flow, independent of this roster.

`webtris-gb` is disabled by default: WebTRIS publishes quality-checked
_historical_ traffic data lagged roughly 6-8 weeks — a query for a recent date
window returns HTTP 204 (no content), and even the older data it does hold
falls outside the 28-day free-flow baseline-derivation window
(`deriveBaselines`'s default `windowDays`), so it never contributes to the
live pipeline. An operator who wants the historical samples anyway can flip
`enabledByDefault` on `webtris-gb` and widen the derive window to reach back
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

Two feeds need a free API key and stay dormant until it is set:

- **OHGO (Ohio)** — `OHGO_API_KEY` (ohgo.com/developer).
- **Trafikverket (Sweden)** — `TRAFIKVERKET_API_KEY`
  (api.trafikinfo.trafikverket.se).

## Known export limitation

Point-sensor congestion (Fintraffic, OHGO, Trafikverket) emits **Point**
geometry, and direction is set only where the feed carries it (Fintraffic,
OHGO). The CIFS and DATEX II JAM mappings expect a linear polyline plus a
direction, so for these point-sensor feeds those exports produce degenerate
(single-point) polylines with partial direction until the emitter buffers the
point into a short directional segment.

## Excluded / deferred

- **Norway (Statens vegvesen)** — volume/occupancy only, no speed. Excluded.
- **511NY developer API** — no speed field. Excluded (NYC DOT Socrata is used
  for New York City speed instead).
- **France (QTV-DIR)** — requires a CSV site-table reprojection from
  Lambert-93 (EPSG:2154) to WGS84. Deferred follow-up.
