# Static archive (GeoParquet published view)

The static archive is OpenConditions' **mirrorable artifact**: a nightly,
self-contained GeoParquet snapshot of the redistributable _published view_. It
exists so anyone can mirror the commons, seed a new instance, or backfill a
federation peer from a single file — without live access to this instance's
database or its raw crowd ledger.

## What it contains — and what it never can

The archive is built by `dailyGeoParquet` (`packages/publishers/src/archive.ts`),
whose `toPublishedArchiveRows` filter is the load-bearing gate. A row reaches the
archive only if it survives, in order:

1. **License.** `filterForPermissiveExport` drops any share-alike (copyleft)
   record. The archive is a permissive redistributable bundle; ODbL/CC-BY-SA/GPL
   data never rides along.
2. **Tombstones.** `status === "archived"` (the reviewer's tombstone) and
   `status === "cancelled"` are dropped. A tombstoned record can never resurrect
   in the archive.
3. **Expiry / validity.** A row past its `expiresAt` or `validTo` (relative to
   the build instant) is dropped, so a stale mirror never republishes dead
   conditions.
4. **Privacy tier.** Only released tiers pass (`authoritative`, `aggregate`,
   `crowd_pseudonym`, `dp_noised`, `k_anon`; plus legacy feed rows with no
   explicit class). **Probe staging never enters** — any unreleased/staging
   privacy marker falls through the gate by construction, enforced the moment the
   probe pipeline introduces one.

Surviving rows are flattened to published columns with **crowd identity
stripped**: `origin.reporter` (the reporter `keyId`, signature, reputation), the
`report_evidence` ledger, and `sourceRaw` never appear. Only `origin.kind`
(`feed`/`crowd`), `privacyClass`, `evidenceState`, and public `attribution`
travel.

### Columns

`id`, `source`, `domain`, `kind`, `type` (events) / `metric` (measurements),
`severity`, `headline`, `geometry`, `validFrom`, `validTo`, `dataUpdatedAt`,
`confidenceScore`, `privacyClass`, `evidenceState`, `fuzziness`, `sourceLicense`,
`instanceId`, `originKind`, `attributionProvider`, `attributionLicense`,
`attributionUrl`.

## Format

Standard Parquet written with [`hyparquet-writer`](https://www.npmjs.com/package/hyparquet-writer)
(a maintained pure-JS writer — no native binaries). Geometry is stored as ISO
**WKB** in a `BYTE_ARRAY` column, with the [GeoParquet 1.0](https://geoparquet.org)
`geo` key in the file's key-value metadata (`primary_column: "geometry"`,
`encoding: "WKB"`, CRS84 / lon-lat WGS84). Any GeoParquet-aware reader (GDAL,
DuckDB `spatial`, GeoPandas, `hyparquet`) reads it directly.

## Nightly build

The ingest scheduler registers a nightly job (default `30 3 * * *`, after the
baseline derivation) that reads the current published view across all domains and
writes a dated file:

```
${OPENCONDITIONS_ARCHIVE_DIR:-./data/archive}/archive-YYYY-MM-DD.parquet
```

- `OPENCONDITIONS_ARCHIVE_DIR` — output directory (default `./data/archive`).
- `ARCHIVE_CRON` — schedule override; `off` disables the job.

The build is **best-effort**: an unwritable or misconfigured output directory is
logged and swallowed, never crashing the scheduler.

> **Read scope.** The build reads through `readObservations`, which caps at 2000
> rows per query. That is ample for the current single-region deployments; a
> planet-scale archive would page this read. Tracked as a follow-up.

## Deferred: z8 PMTiles snapshots

A tiled (`.pmtiles`) rendering of the archive for map overlays is **operator
infra, not built here**. The only mature path to vector tiles at this zoom is
[tippecanoe](https://github.com/felt/tippecanoe), a C++ binary; there is no
pure-JS z8 vector tiler in-stack, and OpenConditions deliberately takes on **no
external-binary dependency** in the ingest service. An operator who wants tiles
runs tippecanoe over the exported GeoParquet/GeoJSON as a separate step:

```sh
# operator step — not part of the ingest service
tippecanoe -zg -o conditions.pmtiles archive-YYYY-MM-DD.parquet
```

## Object storage

Uploading the archive to S3/object storage or fronting it with a CDN is likewise
operator infra. The service only writes to the local filesystem; mirroring the
directory elsewhere is a deployment concern.
