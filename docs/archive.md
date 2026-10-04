# Static archive (GeoParquet published view)

The static archive is OpenConditions' **mirrorable artifact**: a nightly,
self-contained GeoParquet snapshot of the redistributable _published view_, one
file per record class. It exists so anyone can mirror the commons, seed a new
instance, or backfill a federation peer from four files — without live access to
this instance's database or its raw crowd ledger.

## What it contains — and what it never can

The archive is written by `writeRecordArchive`
(`packages/publishers/src/record-archive.ts`), whose `publishedRecords` filter is
the load-bearing gate. A record of the class reaches the archive only if:

1. **A peer could receive it.** On-demand answers (cached reads of a source that
   forbids bulk copies), fused observation rows and every record of a restricted
   source (`restricted` in the catalogue: share-alike, or redistribution not
   affirmatively granted) never leave the instance.
2. **It is live.** A tombstoned record (withdrawn, expired, rejected, erased)
   never appears; a situation whose validity has ended, an offer past its end, a
   reading past its `validUntil` and a decommissioned feature are left out, so a
   mirror never republishes dead conditions.
3. **A crowd record is corroborated.** A crowd report reaches the archive once
   corroborated or externally resolved and before its lifetime ends — the same
   default a federation subscriber gets.
4. **Its licence is public.** A record is dropped unless its own licence and
   every licence an upstream publisher states grant redistribution and are not
   share-alike (`isPublicLicense`); an unstated (`NOASSERTION`) or unknown licence
   is not public. Merged sources whose licence is not public are stripped. The
   archive is a redistributable bundle; ODbL/CC-BY-SA data never rides along.

Surviving records lose the reporter (`provenance.reporter`, the crowd key), and a
source's allow-listed `extras` ride along only when the source federates them
(`extrasFederate` in the catalogue). The `report_evidence` ledger and raw
payloads never appear; a crowd record carries its evidence summary only.

### Files and columns

Each class has its own file, because each class has its own columns:

| File                                     | Rows                                      |
| ---------------------------------------- | ----------------------------------------- |
| `archive-situation-YYYY-MM-DD.parquet`   | live situations                           |
| `archive-feature-YYYY-MM-DD.parquet`     | live features, components inside `record` |
| `archive-offer-YYYY-MM-DD.parquet`       | live offers                               |
| `archive-observation-YYYY-MM-DD.parquet` | the latest reading of every series        |

Every file has the kernel columns (`id`, `canonical_id`, `kind`, `type`,
`subtype`, `domain`, `temporality`, `source_id`, `origin`, `privacy_class`,
`evidence_state`, `attribution_provider`, `attribution_license`,
`attribution_url`, `revision`, `recorded_at`), the class's own columns
(situations: severity, certainty, validity and headline; features: lifecycle
and name; observations: property, subject key, result and phenomenon time;
offers: subject, component and currency), the whole stored `record` as JSON, and
the `geometry`.

## Format

Standard Parquet written with [`hyparquet-writer`](https://www.npmjs.com/package/hyparquet-writer)
(a maintained pure-JS writer — no native binaries), one bounded row group at a
time. Geometry is stored as ISO **WKB** in a `BYTE_ARRAY` column, with the
[GeoParquet 1.0](https://geoparquet.org) `geo` key in the file's key-value
metadata (`primary_column: "geometry"`, `encoding: "WKB"`, CRS84 / lon-lat
WGS84). Any GeoParquet-aware reader (GDAL, DuckDB `spatial`, GeoPandas,
`hyparquet`) reads it directly.

## Beyond-window federation backfill

The archive is also the **deep-past tier of federation backfill**. A peer catches
up over `GET /peer/backfill` — the same composite `(txid, seq)` cursor as the live
pull, but bounded to a lower time floor set by the caller's trust tier (Tier 0 →
24 h, Tier 1 → 30 days, Tier 2 → ≥ 30 days). A backfill request whose range
reaches _before_ that floor gets `beyondWindow: true` and an `archiveUrl` naming
the latest file of each class in the signed page:

```json
"archiveUrl": {
  "situation": "https://conditions.example.org/archive/archive-situation.parquet",
  "feature": "https://conditions.example.org/archive/archive-feature.parquet",
  "offer": "https://conditions.example.org/archive/archive-offer.parquet",
  "observation": "https://conditions.example.org/archive/archive-observation.parquet"
}
```

There is **no protocol** for the pre-floor history — the peer fetches these
static files directly (HTTP Range), then resumes the live cursor at the window
edge. The base URL is `OPENCONDITIONS_FEDERATION_ARCHIVE_URL` (default
`<baseUrl>/archive`); the operator serves the archive directory there.

## Nightly build

The ingest scheduler registers a nightly job (default `30 3 * * *`, after the
baseline derivation) that reads the published view of all four classes in one
repeatable-read snapshot and writes the dated files, then points each class's
stable name at its newest file:

```
${OPENCONDITIONS_ARCHIVE_DIR:-./data/archive}/archive-<class>-YYYY-MM-DD.parquet
${OPENCONDITIONS_ARCHIVE_DIR:-./data/archive}/archive-<class>.parquet   (latest)
```

- `OPENCONDITIONS_ARCHIVE_DIR` — output directory (default `./data/archive`;
  under OpenMapX `/data/archive`, on the service's volume).
- `OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS` — nights of dated files to keep (default
  `30`, a Tier 1 peer's backfill window; `0` keeps every night).
- `ARCHIVE_CRON` — schedule override; `off` disables the job.

The stable names move only once every dated file is written, each atomically, so
a peer never reads a half-written file or a mix of two nights. The build is
**best-effort**: an unwritable or misconfigured output directory is logged and
swallowed, never crashing the scheduler. After writing, the build deletes the
dated files of every night older than the newest
`OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS`.

An erasure reaches the kept nights too. After writing, each build rewrites
every dated file that holds an erased record — one tombstoned `rights_revoked`,
or one whose canonical id has an erasure fact in force (30 days) — without it,
in place, and moves the class's stable name along when it points at that file.
So an erased record leaves every dated file by the next nightly build. Each
erasure is applied once: `conditions.archive_erasure` records the erasures the
kept files are free of (in the database, because the archive directory is
served), so a night reads the files only for a new erasure, and an erasure
stays pending while any file failed to be rewritten. With the
job off (`ARCHIVE_CRON=off`) nothing rewrites the files: an operator who keeps
dated files and turns the job off removes erased records from them by hand.

## Deferred: z8 PMTiles snapshots

A tiled (`.pmtiles`) rendering of the archive for map overlays is **operator
infra, not built here**. The only mature path to vector tiles at this zoom is
[tippecanoe](https://github.com/felt/tippecanoe), a C++ binary; there is no
pure-JS z8 vector tiler in-stack, and OpenConditions deliberately takes on **no
external-binary dependency** in the ingest service. An operator who wants tiles
runs tippecanoe over the exported GeoParquet as a separate step:

```sh
# operator step — not part of the ingest service
tippecanoe -zg -o situations.pmtiles archive-situation.parquet
```

## Object storage

Uploading the archive to S3/object storage or fronting it with a CDN is likewise
operator infra. The service only writes to the local filesystem; mirroring the
directory elsewhere is a deployment concern.
