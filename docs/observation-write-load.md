# Reducing observation write load

An observation at a new measurement time is a new sample even when its value is unchanged. Skipping equal-valued speeds would change latest timestamps, history counts, hourly histograms and derived baselines. The writer already compares content before writing and deduplicates history independently. Traffic speed history is kept only at site level; channel readings update latest state without adding history.

## Compact latest readings

Latest rows separate the series template from its changing reading. The template stays out of line and is reused by updates. Revision, temporality and aggregation now live in that template. When one changes, the template hash changes and the writer replaces the template normally.

A regular observation stores its 64-character local ID in the reading. The template supplies the namespace; the full record ID and its canonical SHA-256 ID are reconstructed when read. Its content hash, result, quality, baseline, every timestamp and varying provenance are retained. Identities that cannot be represented losslessly keep their original full fields.

Both the TypeScript codec and PostgreSQL's `conditions.observation_record` accept the previous and compact representations. Direct result, quality, baseline, expiry and content-hash access remains unchanged. Federation capture reconstructs the complete record before publishing it. History and rollup formats do not change.

## Reproduce the compact-reading benchmark

The benchmark starts and migrates its own disposable PostGIS container. It accepts no database URL. Both arms use the production observation writer, validation, receipt capture and history retention. A test-only SQL-boundary adapter restores the previous representation for the reference arm. The compact arm uses the ordinary writer without an adapter.

The checked-in fixture contains four CC0 NDW reading shapes captured read-only on 2026-11-04: site/channel speed and volume. The benchmark expands them into unique series with approximately ten channel readings per two site readings, advances every measurement interval, and compares complete reconstructed-record and history digests. It reports WAL after a checkpoint separately from subsequent cycles, heap and TOAST sizes, and elapsed time. Durability and full-page writes stay enabled; autovacuum is disabled on this owned server to keep unrelated maintenance out of the comparison.

```sh
pnpm build
OC_TEST_POSTGIS_PROFILE=pg18 \
OC_RUN_LATEST_WRITE_BENCHMARK=1 \
OC_LATEST_WRITE_BENCHMARK_RECEIPT=/owned/output/latest-writes-pg18.json \
pnpm exec vitest run --project integration \
  packages/storage/src/__tests__/latest-write-wal.integration.test.ts
```

The [retained PG18 receipt](receipts/observation-write-benchmark-pg18.json) covers 2,000 and 20,000 rows over eight update cycles. It measured 20.6% less WAL at both sizes, including 20.3% less WAL in cycles after the first checkpoint cycle, 25% less heap space, and unchanged TOAST size. Complete-record and history digests match in each pair. The expanded run covers 2,000 and 20,000 rows over eight update cycles. The normal integration suite runs a smaller causal regression on an isolated server. `OC_TEST_POSTGIS_PROFILE=pg16` checks the ordinary CI database version. Record the image, PostgreSQL version, source revision and receipt together. Local ARM64 timings do not qualify native production AMD64 throughput; host contention also makes isolated timing comparisons inconclusive.

A preliminary experiment using 2,000 captured production rows over eight cycles reduced WAL from 15,415,136 to 12,189,696 bytes (20.9%) and latest heap size from 5,464,064 to 4,096,000 bytes. Both arms had identical full-record digests, latest-write and history counts, and TOAST size. This is a workload-specific local result, not a forecast of whole-server SSD savings.

A large-template regression also exercises alternating aggregation metadata and checks complete records and every history sample. It establishes correctness, not universal WAL savings: changing shared metadata replaces the template and can cost more than the previous representation for that workload.

A separate sweep of tuple targets and compression settings did not justify changing storage parameters. Smaller targets could increase TOAST and WAL. Queue representation, retention partitioning, polling cadence and durability settings are deliberately unchanged by this optimization.

## Avoid reading unchanged templates

The daily production measurement after the compact-reading rollout found about 122 GB of generated WAL and at least 685 GB of PostGIS device writes over 24 hours. PostgreSQL reported about 508 GB of relation writes, mostly from the background writer, clients and autovacuum. These are overlapping measurements. The instance is shared with OpenMapX, and this window had restarts, so its physical totals are lower bounds rather than a matched comparison with the previous writer.

Ingestion's latest-row lookup fetched static credit provenance from each series template on every changed reading. The template is stored in TOAST; repeatedly fetching it consumes buffer space that could retain changing heap pages between polls. A bounded production read-only check of 1,000 NDW rows touched about 20,025 shared blocks with that projection and 5,000 without it. This establishes extra buffer activity; it does not by itself attribute physical writes to that query.

The lookup now prepares the first incoming record's sealed template for each series and sends its hash with the series key. PostgreSQL returns stored credit only when its template hash differs. A matching hash lets the writer reuse the incoming credit locally, without fetching the template or sending the credit over the database connection. A mismatch, failed validation or older template encoding takes the existing database projection. The prepared seal is reused if that draft is written. An invalid draft that compares unchanged remains skipped, while one that would be written is still rejected.

The additional work is one early seal and template hash per uncached series in each slice of at most 1,000 series. Changed readings already needed sealing. Uncached unchanged readings can incur extra validation work, and a different JSON key order can cause a harmless fallback. Database hash comparison remains the authority; no persistent cache or source-level assumption replaces it. Every measurement time, history sample, captured credit and latest result keeps its existing behavior.

### Reproduce the page-write benchmark

The opt-in benchmark owns and migrates a durable PostGIS server and accepts no database URL. It uses 24,000 changing NDW-style series and 8,000 unchanged series from a second network. Each arm runs twelve polls with history, competing reads, autovacuum enabled, and a final vacuum and checkpoint included in the measured window. The full latest heap, indexes and TOAST exceed the selected buffer pool. The reference arm forces the previous static-credit projection while keeping the rest of the writer identical; it isolates the database-access effect and includes early sealing in both arms. It does not independently measure the CPU cost added to uncached unchanged series.

```sh
pnpm build
OC_TEST_POSTGIS_PROFILE=pg18 \
OC_RUN_PAGE_WRITE_BENCHMARK=1 \
OC_PAGE_WRITE_BUFFERS_MB=96 \
OC_PAGE_WRITE_RECEIPT=/owned/output/latest-page-writes-pg18.json \
pnpm exec vitest run --project integration \
  packages/storage/src/__tests__/latest-page-writes.integration.test.ts
```

`OC_PAGE_WRITE_ROWS`, `OC_PAGE_WRITE_CYCLES` and `OC_PAGE_WRITE_BUFFERS_MB` select positive integer dimensions. `OC_PAGE_WRITE_AUTOVACUUM_NAPTIME_SEC` defaults to PostgreSQL's normal 60 seconds; a shorter interval stresses maintenance interaction. The receipt retains all four reference/candidate/candidate/reference arms, their settings, WAL, PostgreSQL relation writes, cgroup bytes per device, HOT updates, vacuum counts, poll latency, and complete latest/history digests. Device layers must not be added together.

The [96 MiB PG18 receipt](receipts/latest-page-writes-pg18-96mb.json) has identical complete-record and history digests and identical publication counts in every arm. Mean cgroup writes fell from 710 MB to 434 MB (39%), and mean PostgreSQL relation writes fell from 638 MB to 287 MB (55%). Mean WAL fell from 251 MB to 238 MB (5%). Vacuum timing and HOT rates varied: the candidate arms wrote 564 MB and 304 MB, so the average is a workload result with substantial variation. In the pair with one autovacuum and 264,000 HOT updates in both arms, cgroup writes fell 29% while WAL rose 0.5%.

A [direct control against the actual previous writer](receipts/latest-page-writes-actual-baseline-pg18.json), from commit `0d18c74c`, used 64 MiB buffers and six polls per arm. It wrote 389 MB versus 247 MB through the owned server’s cgroup (36% less), with 370 MB versus 144 MB of PostgreSQL relation writes (61% less). WAL was effectively unchanged at 119 MB (+0.12%). Both arms made 144,000 latest updates, retained 12,000 history samples, had 144,000 HOT updates and matching complete-record/history digests. Autovacuum was enabled but did not run during these short measured windows; both included the final explicit vacuum and checkpoint. This control includes the extra preparation work in the candidate only.

A preliminary 64 MiB stress run with a one-second vacuum interval averaged 29% fewer cgroup write bytes and 40% fewer relation-write bytes, with 6% more WAL. It used the same hash comparison but sent matching credit through SQL before the final local hydration change. WAL reduction is therefore not a guarantee of this lookup optimization. The retained normal integration regression checks zero TOAST accesses when the template matches, plus changed-credit and legacy-hash fallback and validation behavior. These local ARM64 cache-pressure workloads are not forecasts of whole-server SSD savings or native production throughput. Confirm the total device-write effect against successful ingestion on the deployed instance.

### Deploy or roll back the lookup

Deploy the application images normally. This lookup change adds no migration or PostgreSQL setting, and it creates no table conversion period. The previous application images can be restored directly. Continue retaining migration 0091's compact-record decoder as required by the earlier codec rollout. Compare matching production windows using the counters below, including latest update volume, HOT rate, successful source polls and rejected readings. The `readings/lookup` timer now includes the early sealing work, so its individual stage duration is not directly comparable with older images.

### Full-day production result

The uninterrupted follow-up from 6 November 2026 at 00:42 UTC to 7 November at 00:42 UTC collected 289 snapshots without errors or restarts. PostGIS wrote 686.11 GB through its physical device, generated 120.73 GB of WAL and reported 497.32 GB of relation writes. Latest rows received 71.78 million updates, 95.03% HOT. There were 8.21 million inserted and 8.58 million deleted latest-table TOAST chunks. These counters overlap and must not be added together.

Compared with the earlier day's stable intervals, physical writes averaged 28.79 versus 28.59 GB/hour and WAL 5.09 versus 5.03 GB/hour. This does not establish a substantial production improvement from the lookup change. The days differ in source activity and update counts, so it is an observational comparison. NDW remained the largest application writer, reporting 48.43 million latest updates across 287 changed published polls. Application counters do not attribute PostgreSQL bytes per source. The finite collector and its owned directory were removed after verifying the archived samples; no periodic collector or PostgreSQL setting was installed.

## Keep fused lineage out of static credit

Fused records repeat changing contributor observation IDs in `mergedSources` and `derivedFrom.records`, plus their own point ID in provenance. Keeping those fields in the series template changed its hash at every new point, forcing static credit through TOAST again. Canonical `@fused` and `@fused-public` records now store the ordered contributor ID vector once in the reading, under the private `_ocFusionRecordIds` key. Readers restore the complete provenance and remove that key. Credit, contributor order, duplicate contributors, derivation metadata, IDs, content hashes, values and times are retained.

The codec uses this representation only when it can reconstruct every field exactly. Nonstandard identities, unmatched contributor references and references with extra fields keep their previous representation. Both the TypeScript and SQL readers accept old and new rows. Fused upserts retain the stored template datum when its hash matches under the conflict-row lock; changed credit or descriptors replace it. The changing reading and contributor array still update normally and can themselves require TOAST writes.

### Reproduce the fused-lineage benchmark

The opt-in benchmark owns a durable PostGIS server and accepts no database URL. It mixes 24,000 NDW-style native series with 600 fuel sites, including restricted contributors and both fused privacy scopes. Each cycle updates 900 fused rows alongside the native readings. Legitimate credit changes occur during the run. A SQL-boundary reference adapter restores the previous fused storage representation and ordinary template assignment; the candidate uses the production writer.

```sh
pnpm build
OC_TEST_POSTGIS_PROFILE=pg18 \
OC_RUN_FUSED_WRITE_BENCHMARK=1 \
OC_FUSED_BENCH_BUFFERS_MB=64 \
OC_FUSED_BENCH_RECEIPT=/owned/output/compact-fused-lineage.json \
pnpm exec vitest run --project integration \
  packages/storage/src/__tests__/fused-page-writes.integration.test.ts
```

`OC_FUSED_BENCH_NATIVE_ROWS`, `OC_FUSED_BENCH_SITES` and `OC_FUSED_BENCH_CYCLES` select the dimensions. The [PG18 receipt](receipts/compact-fused-lineage-pg18-64mb.json) retains four reference/candidate/candidate/reference arms, each with its own database, twelve cycles, normal autovacuum and a final explicit vacuum and checkpoint. Durability and full-page writes remain enabled. Complete reconstructed-record and history digests, update counts and HOT counts match in all four arms.

Mean physical cgroup writes fell from 861 MB to 613 MB (29%), WAL from 321 MB to 278 MB (13%), and relation writes from 979 MB to 750 MB (23%). TOAST inserts and deletes fell from 21,660 to 10,980 (49%). Each arm made 309,600 latest updates, including 288,000 HOT updates. The two reference device totals varied from 973 MB to 748 MB; the candidates wrote 628 MB and 599 MB. This is a controlled ARM64 workload result, not a forecast of production savings. The reference adapter adds CPU work, so similar cycle times do not establish throughput against the actual previous binary or production AMD64. Confirm successful ingestion and total device writes after deployment.

### Deploy or roll back fused lineage

Migration 0092 installs the compatible decoder before polling starts. It changes functions only: no rows are scanned or rewritten, and no PostgreSQL settings change. Existing series convert on their next changed reading, replacing their template once. Exclude that conversion period from steady-state measurements.

Application rollback may restore the previous images, whose writers emit the old representation. Keep migration 0092's decoder and helper while compact fused rows remain, as well as the compact-identity support from 0091. Do not roll those functions back or bulk rewrite rows. The added cost is lineage reconstruction when a full fused record is read; native records avoid the helper. The private storage format adds a compatibility obligation for future readers and migrations.

## Rollout and rollback

Deploy the decoder migration before any new writer starts. Normal service startup runs migrations before polling. Migration 0091 replaces a function; it does not scan or rewrite the latest table or change PostgreSQL settings. Older rows stay readable and are converted naturally when their next changed reading arrives. The first conversion replaces a series template once, so initial rollout writes are not steady-state measurements.

The previous application can be restored without undoing the decoder migration. Its writers emit the old representation, which the new decoder also accepts. Keep migration 0091's decoder while any compact readings remain. Do not replace it with the old decoder as a rollback step, and do not bulk rewrite the table merely to convert rows.

## Production comparison

Use [`scripts/snapshot-observation-writes.sql`](../scripts/snapshot-observation-writes.sql) with PostgreSQL 18 (`psql -X -v ON_ERROR_STOP=1 -qAt -f ...`) to retain JSON lines locally. It opens a read-only transaction and has statement and lock timeouts. Capture matching windows before and after deployment, with unchanged feed configuration. Use a short window spanning several successful NDW polls to establish function, then matched 24-hour windows covering checkpoints, nightly derivation, rollup insertion and retention. Exclude the first conversion period from steady-state claims.

Record:

- `pg_stat_wal`: `wal_bytes`, `wal_records`, `wal_fpi`, and `stats_reset`.
- `pg_stat_user_tables`: inserts, updates, HOT updates, deletes, dead-row estimates and maintenance counts for latest, history leaf partitions, rollups, situations, revisions, baselines and the queue.
- `pg_stat_checkpointer` and `pg_stat_io`: checkpoint counts, buffers and actual PostgreSQL relation I/O.
- The PostGIS container's cgroup `io.stat` write-byte deltas on the physical device. Do not add this to WAL bytes: it already includes PostgreSQL's device writes.
- Successful polls, latest/history/unchanged counts, rejected readings, source mix, image identity, postmaster start and other OpenMapX activity on the shared instance.
- Complete observation IDs, canonical IDs, timestamps, values, quality and provenance, along with rollup sample counts and histograms. Lower writes caused by failed ingestion do not count as an improvement.

Use differences of cumulative counters, never lifetime totals or a statistics reset. Refuse comparisons crossing a restart/reset or changed configuration. `pg_stat_statements` can attribute statement WAL when already enabled; it was not installed on the reference production server. Enabling it is a separate operational change, not a prerequisite for this deployment.
