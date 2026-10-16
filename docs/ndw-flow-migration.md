# NDW flow: DATEX II v3 migration

`nl-ndw-flow` uses NDW's separate v3.6 speed/volume and measurement-site
configuration snapshots. The source ID, station IDs and indexed channel keys
stay stable; no database migration or new consumer API is needed. Both endpoints
refresh every minute. The events feed remains `actueel_beeld.xml.gz`.

NDW's [official announcement](https://opendata.ndw.nu/) retires
`trafficspeed.xml.gz` and `measurement.xml.gz` on **9 February 2027**. The
[official conversion notes](https://mogin.nl/publicaties/Verkeersinformatie/Verkeersdata/vigerend/changelog.html)
explain the new measurement wrappers, station revisions, structured lanes and
measurement timestamps. The parser retains the old v1/v2 forms for other feeds
and archived captures.

## Interpretation

- `measurementSite` replaces `measurementSiteRecord`; indexed `physicalQuantity`
  replaces `measuredValue`, with a nested `SinglePhysicalQuantity` wrapper.
- `measurementTimeDefault/timeValue` remains the measurement instant, rather
  than the download or publication time. Counts, data errors, negative no-data
  sentinels, real zero speeds and zero-input speeds retain their existing rules.
- A v3 station's revision must match its measurement reference exactly. Missing
  or mismatched revisions withhold the affected station's readings. No stale
  metadata is borrowed to assign a channel's geometry, class or period. The
  table refreshes with measurements because its own version is now `latest` and
  individual stations can change independently. Separate snapshot fetches may
  straddle an upstream update; the next matching pair restores readings.
- V3 `specificLane/laneNumber` is understood where supplied. **The observed NDW
  v3 table supplied no channel lane assignments**, although the v2 table did.
  Channel keys remain distinct, but their lane stays unknown; it is not inferred
  from the index, retained from old metadata, or guessed from lane count.
- The current v3 table supplies point locations; some old table entries supplied
  lines. Use the new source geometry, without carrying an old extent forward.
  A changed point is not proof of a changed physical detector or a routing span.
- All-vehicle channels continue to supply site totals when present; length-band
  channels are not counted again on top of them.

The v3 table is smaller per download, but refreshing every minute adds network
and parse work compared with the old six-hour reference cadence. At this capture,
compressed table plus measurements total about 3 MB per minute (about 4.2 GiB per
24 hours, before protocol overhead). Both are still parsed incrementally through
existing byte/time bounds; no DOM, increased byte limit, or legacy-feed fallback
is introduced.

## Qualification receipt: 16 October 2026

Public snapshots were fetched from the four official endpoint URLs and parsed
locally through the same incremental readers, using 64 KiB UTF-8 chunks. No
production server or database was used. The v2 and v3 downloads had different
HTTP Last-Modified times (09:57:10Z and 09:58:10Z); their reporting stations'
measurement instants nevertheless matched exactly.

- Old site table: 353,298,081 decoded bytes, 88,080 located entries.
- V3 site table: 147,095,451 decoded bytes, 20,573 located entries.
- Old measurements: 52,528,547 decoded bytes.
- V3 measurements: 69,646,745 decoded bytes.
- Both parsers reported success and emitted the **same 19,190 station IDs**,
  **145,464 channel readings**, and the same declared channel keys. All emitted channel values, properties,
  periods, classes and sample counts matched when the absent lane field was
  excluded from the comparison.
- All 19,190 station measurement instants, aggregate speeds and aggregate volumes
  matched, including stations without a value for one of those properties.
  There were 17,717 stations with speeds and 19,186 with volumes.
- 2,873 emitted station geometries differed. The old output had 143,989 readings
  with a lane assignment; the new output had none. These are observable provider
  differences, not parity claims or a reason to invent missing detail.

Decoded payload SHA-256 values, in the same order:

```text
measurement.xml
154c429d1301d153b0d98890894aa2a2c9c10566a1074ecc6b65714743f3fd1e
snelheden_en_intensiteiten_configuratie_meetlocaties.xml
0a07df0ecd4527b4f246db9e6de2d94413386f14fd6b678d1c58b7f6d525eb42
trafficspeed.xml
b7220360c7ce12e363aa6e6b5806454baa5bbd0178599f7666bac9645df05c55
snelheden_en_intensiteiten_meetgegevens.xml
b3adfa4a4fa6452c0a3c173aa06dc5dcd7ed4fb66dc7762f241dfd17e6804b52
```

The two whole-station v3 fixtures and synthetic boundary tests cover identity,
indexed values, sample counts, source time, all-vehicle totals, lane absence,
structured lanes, revision mismatch, arbitrary chunk boundaries and truncation.
Existing v1/v2 fixtures remain regression coverage.

This is a single-capture parser qualification, not a production soak or an
accuracy assessment of the changed geometries. After rollout, inspect
`nl-ndw-flow` freshness, station/observation counts, skipped readings, parse
runtime and memory across multiple upstream revisions. Existing freshness rules
bound retained readings while a matching table is unavailable.
