# Polish kilometre references and Dutch VILD

Research and implementation decision, 15 October 2026. This follows the TraFFxml
comparison: retain useful source evidence, and expand table coverage only where
identity, redistribution rights and precision are established.

## Decision

- **Poland:** preserve GDDKiA's road reference, starting kilometre and reported
  affected length. Geographic recovery remains unproven; do not manufacture a
  line or an ending kilometre from these fields.
- **Netherlands:** ship the official, currently active VILD **6.13.A** point
  distribution. Resolve only the measured, unambiguous Method2 point form with
  no offsets or secondary location. Mark the result `low_res`, preserve table
  provenance, and prefer every supplied geometry over this fallback.
- **Routing and XML:** coarse locations cannot create routing spans or enter
  segment-condition publication. DATEX and TraFF exports withhold situations
  containing coarse locations because those exports cannot express this
  uncertainty. GeoJSON retains them with canonical location metadata.

## Poland: evidence and limits

The [official open-data catalogue](https://api.dane.gov.pl/1.4/datasets/2752)
licenses the traffic data CC0. Resource 38739 links the
[existing GDDKiA XML feed](https://www.archiwum.gddkia.gov.pl/dane/zima_html/utrdane.xml).
A captured publication generated at `2026-10-15T20:38:02+0200` contained:

| Observation                         | Records |
| ----------------------------------- | ------: |
| All records                         |     512 |
| Valid supplied coordinate pairs     |     484 |
| Missing coordinate pairs            |      28 |
| Finite, nonnegative `km` and `dl`   |     512 |
| Positive reported length            |     473 |
| Zero reported length                |      39 |
| Road references containing suffixes |      96 |

Capture SHA-256:
`2894033bb49d799e43ac1e2f04901850edf50f99c83ecc4ada005d61f3391f58`.
These are one publication's observations, not ongoing coverage guarantees.

The adapter preserves the full road reference, including suffixes, in
`location.linear`: `system: kilometre_post`, `authority: GDDKiA`, `from` in
kilometres, and optional `reportedLengthM` in metres. Both dot and comma decimal
notation are accepted; blank, negative, non-finite and malformed values are
refused. Zero remains meaningful. Existing supplied points and source IDs stay
unchanged. `reportedLengthM` is a reported distance, not a coordinate or an
assertion that `to = from + length`.

TraFF's historical milestone table is derived from February 2023 OpenStreetMap
and its implementation is GPL-3.0. Reusing that code is unnecessary, and its
milestone coverage does not establish calibration or accuracy. In a historical
lookup, 475/512 nominal endpoint pairs were available, including 14/28 records
without coordinates; those are lookup counts, **not validated recovered
stretches**. OSM's ODbL obligations would also need a separate distribution
review for a derived milestone database.

An apparently independent GUGiK kilometre service is also OSM-backed, according
to [its official service manual, section 11.1](https://www.geoportal.gov.pl/wp-media/2023/10/PodstawoweUslugiDanychPrzestrzennychDlaSystemowInformatycznychPanstw-ver.-1.12.pdf).
It cannot validate an OSM-derived resolver independently. Fresh Overpass attempts
failed, so no current OSM coverage or accuracy claim is made.

**Gate for geographic recovery:** obtain a dated road-manager calibration or
independent surveyed reference, including road sections, resets and suffix
semantics; establish redistribution rights; then evaluate held-out records with
independent geometry, endpoint error and wrong-road/carriageway rates. Until
then the demonstrated geographic gain is zero. Preserved metadata makes that
future work possible without guessing now.

## Netherlands: exact namespace and active edition

[NDW's VILD documentation](https://docs.ndw.nu/en/producten/vild/) identifies
6.13.A as active since 22 October 2025. The already published 6.14.A activates
on **4 November 2026** and was not active on the research date. The importer
pins the reviewed archive rather than following “latest”.

The [Dutch location-reference profile](https://mogin.nl/publicaties/Verkeersinformatie/Locatiereferentie/vigerend/index.html)
uses country `8`, table `6.13`, version `A`. These tokens are matched literally
(after whitespace trimming); VILD is separate from Dutch RDS-TMC/LCL. TraFF's
synthetic country `39` / table `613` conversion is not an official wire identity
and is not adopted. No cross-edition road-name fallback is enabled. Canonical
TMC metadata retains integer table `6` and full version `6.13.A`; the separate
`location.locationTable` explicitly identifies `VILD` and edition `6.13.A`.

The [dataset-specific government catalogue entry](https://data.overheid.nl/dataset/ada74229-474e-4469-adc8-1ad87ef38c36)
identifies Rijkswaterstaat and CC0; the
[general VILD entry](https://data.overheid.nl/dataset/11626-verkeersinformatie-locatie-database)
also identifies public-domain reuse. This is the official distribution's grant,
independent of historical TraFF copies or licences.

Pinned source: <https://opendata.ndw.nu/VILD6.13.A.zip>

Archive SHA-256:
`d95f14076fb7eb91822944236ba2e68d96a2f59cb533d891580bce6d140a7f95`.

The main DBF contains 11,939 rows: 9,844 points, 1,662 lines, 432 areas and one
version header. It contains no coordinates. The importer joins main `LOC_NR`
to `WGS84/vild_point.dbf`, whose ordinal rows correspond to the point SHP. It
checks the version header, WGS84/EPSG:4326 projection, archive hash, dimensions,
record alignment, duplicate/missing joins and coordinate ranges. The vendored
snapshot contains **9,844 points**, sorted by code; no line/area interpretation
or interpolation is enabled. Border-road points outside the Netherlands are
retained, rather than clipped to an administrative bounding box.

Reproduce with Node, the repository's pnpm dependencies and `unzip` installed:

```sh
pnpm exec tsx scripts/gen-vild-table.ts --archive /path/to/VILD6.13.A.zip --out /tmp/vild-nl.json
cmp /tmp/vild-nl.json packages/roads/src/tmc/snapshots/vild-nl-6.13.A.json
```

Omit `--archive` to download the pinned URL. A different archive hash fails
before extraction. Release updates require a deliberate identity, activation,
licensing and accuracy review, followed by regeneration and tests.

## Measured gain and precision

The NDW `actueel_beeld.xml` capture published at
`2026-10-15T18:46:00.002131626Z` contained 1,235 records: 1,002 with GML, 224
with explicit points and **nine without geometry**. Its 737 references across
696 records all named `8 / 6.13 / A`. The nine missing-geometry records used
Method2 points without offsets and resolved to four codes:

|  Code | Road | Longitude |   Latitude |
| ----: | ---- | --------: | ---------: |
| 22370 | N2   | 5.7172270 | 50.8408564 |
| 16751 | N57  | 3.8071889 | 51.7063211 |
|  8162 | N200 | 4.7405132 | 52.3863390 |
| 17118 | N61  | 3.8087033 | 51.2960652 |

Full capture SHA-256:
`24bdefdfeebcf17ab4ba62ae14d3ad59e7114fd9c0317d0512e211a03e2463ff`.
The nine original records are retained in
`packages/roads/src/__tests__/fixtures/vild/ndw-method2-points.xml`; their source
IDs and publication time are preserved. The regression test resolves all nine
and verifies their canonical precision and table provenance. The older full
NDW golden fixture independently gains 11 parsed records and one assembled
situation; these are different publications and must not be added together.

A separate comparison against publisher-supplied points comprised only 15
records / 10 distinct codes: median separation **289.64 m**, maximum
**3,372.48 m**. The source pairs are retained alongside the XML fixture in
`publisher-point-comparison.json`. This small diagnostic corpus demonstrates that a VILD coded
point is unsuitable as an exact closure point. It does not validate closure
extent or carriageway. All 453 linear references in the live capture already
had geometry, so enabling coarse line reconstruction had no demonstrated
incremental value.

Offset-bearing references, secondary locations, Method4 forms, unknown codes,
missing editions and other namespaces remain unresolved. Even empty or
malformed offset/secondary elements prevent the point fallback. Grouped DATEX
records preserve each member's full location context, including uncertainty,
road references, direction and table provenance, even at identical coordinates.

The binder rejects non-exact effective locations, removes stale spans after a
precision change, and hashes precision along with geometry and road/direction
inputs. Publication also checks effective precision, so a stale historical exact
binding cannot leak coarse data into routing before rebind. Exact effect
locations can override a coarse parent and bind independently. Legacy locations
without a precision field retain their previous exact behavior.

## Further work

1. Acquire and independently validate Polish calibration before enabling
   kilometre-to-geometry recovery.
2. Review VILD 6.14.A around its activation date; never reinterpret a 6.13.A
   record through a newer edition automatically.
3. Consider additional VILD reference forms only after measuring unlocated
   records that need them and validating offset, direction and topology rules.
4. Keep coarse observations visible in map/debugging output while requiring
   precise evidence for navigation restrictions and XML interchange.
