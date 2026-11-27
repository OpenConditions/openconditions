# SEVAS NRW restrictions

`de-nw-sevas-conditions` adds public SEVAS road-segment restrictions in Nordrhein-Westfalen. It reads the native WFS segment layer directly, without Hannibal, an OSRM service or additional credentials. Each `segment_id` remains a separate situation even when several segments share a `restrkn_id`.

## Meaning and limits

| Source sign         | Canonical effect                                                                              | Normalization                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 265, maximum height | `dimension_limit`, height in metres                                                           | Complete when all supplementary conditions are represented                             |
| 262, actual mass    | `dimension_limit`, `laden_weight` in kilograms                                                | Partial: the sign's separate treatment of vehicles in a combination needs more detail  |
| 253, truck access   | Prohibited truck access above 3,500 kg permitted gross mass, or the explicit source threshold | Partial: the current selector does not fully express tractors and vehicle combinations |

Local-access and delivery exceptions become typed `local_access` and `delivery` selectors. Geometry remains in source order; `fahrtri` becomes a direction relative to that geometry. Publisher OSM IDs and versions are reference evidence, not trusted bindings to the current routing graph. GML EPSG:4326 latitude/longitude coordinates become GeoJSON longitude/latitude.

Ordinary weekday and daily daytime intervals use `Europe/Berlin` schedules. Working-day and holiday groups, restricted all-day weekdays without clocks, overnight intervals, intervals touching the ambiguous DST transition hour, incomplete intervals and conflicting day representations remain partial evidence. An all-seven-day selector without clocks needs no temporal period. These choices avoid replacing a calendar day with 24 elapsed hours across DST. Unsupported active supplementary signs and malformed or missing expected flags also make the effect partial. Raw source fields remain in bounded effect source tokens. Invalid numeric limits become unsupported effects.

Partial and unsupported effects are stored and readable through the canonical API, but common routing evidence rules block them. Even a complete height effect needs a consumer that supports vehicle-specific dimension limits and a valid road binding. This feed does not make a truck-routing engine available or establish that any deployed engine enforces the limits.

## Acquisition and withdrawal

The catalog requests the unfiltered `ms:restriktionen_segmente` GML layer in one response with `COUNT=100000` and explicit EPSG:4326. The reader requires a closed WFS document, numeric `numberMatched = numberReturned = actual members`, at most 100,000 members and no continuation link. Unknown totals, truncated or capped documents, malformed identities, conflicting duplicate segments, mixed geometry and foreign predicate elements reject the candidate. The reader permits the provider's WFS/GML bounding envelopes and preserves unknown direct MS scalar fields. Known out-of-scope source codes are accounted as terminal; a known segment with unusable geometry reports a `no_geometry` skip and protects its previous publication.

Only an accepted complete snapshot may withdraw absent segments. A complete empty snapshot may withdraw the source. Fetch, parsing and acquisition-budget failures retain last-good bytes and the successful publication clock. Accepted HTTP 304 replay renews retrieval expiry; a rejected candidate cannot replace accepted validators.

Six-hour polling, 48-hour freshness, a 120-second endpoint timeout and a 128 MiB/180-second acquisition budget are operator choices. Every draft receives an explicit retrieval expiry. The source response timestamp lacks a timezone and is excluded from record publication time and semantic fingerprints. Neither retrieval nor OSM version is presented as `sourceUpdatedAt`.

## Rights and source evidence

The [official Open.NRW distribution](https://open.nrw/dataset/sevas___daten_zur_navigation_von_lkw_ab_3_5_tonnen_1580828998) grants `DL-DE-ZERO-2.0` for the WFS. [Mobidrom distribution metadata](https://www.mobilitaetsdaten.nrw/api/ckan/de/dataset/sevas-nrw) corroborates the source. The review on 27 November 2026 applies to the data grant; no Hannibal source code was copied. Provider credit is `NRW.Mobidrom / SEVAS`.

Source semantics come from the [SEVAS restriction schema](https://sevas.nrw.de/hilfe/export/daten-format/restriktionen) and [StVO Annex 2](https://www.gesetze-im-internet.de/stvo_2013/anlage_2.html). In particular, actual mass for sign 262 differs from the permitted gross-mass threshold for sign 253.

## Local qualification receipt

Two public full captures on 27 November 2026 each contained 88,236,588 bytes and 34,829 unique segments, with matching root and actual counts and no continuation. Full-capture SHA256 values were `6d38ba8be620153b6fa4573ccd85882ddaaf01085497b01181b9e7881462b04c` and `4b322db21fd313fa867f51841fbf6c21e861e0e184a39c2b577abe66af882603`. The second request completed at `2026-11-27T00:01:55.903833+00:00` in 12.77 seconds; HTTP Date was `Fri, 27 Nov 2026 00:01:43 GMT`, while the timezone-free source root said `2026-11-27T01:01:43`. The first capture's UTC completion time was not retained.

The final native adapter and production registry accepted and sealed all 29,839 scoped drafts in each capture: 20,911 sign-253 segments, 6,033 sign-262 segments and 2,895 sign-265 segments. Each produced 26,944 partial effects, 2,895 complete effects, zero unsupported effects, zero unlocatable records and zero schema failures. The other 4,990 members were terminal out-of-scope. Parse, assembly and sealing took 10.480 and 7.954 seconds locally. All semantic source fingerprints and IDs matched across captures. The 59 raw serialized member differences were whitespace changes; no semantic records changed.

The reduced [fixture manifest](../packages/roads/src/__tests__/fixtures/sevas/manifest.json) records its exact request, capture provenance, hashes, grant evidence and deliberate envelope reduction. Synthetic adverse cases exist only as explicit test mutations. Disposable PG16 tests exercise actual ingestion and public API behavior for that fixture; the full captures were parsed and sealed locally, without publishing them to an operator database. These checks do not establish deployed polling, binding accuracy or engine behavior.

Prose guidance was reviewed at Humanizer revision `a32f24407364c74c812b43c15926d638bee1e072`; no third-party scripts were installed or executed.
