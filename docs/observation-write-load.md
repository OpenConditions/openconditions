# Reducing observation write load

An observation at a new measurement time is a new sample even when its value is unchanged. Skipping equal-valued speeds would change latest timestamps, history counts, hourly histograms and derived baselines. The writer already compares content before writing and deduplicates history independently. Traffic speed history is kept only at site level; channel readings update latest state without adding history.

## Compact latest readings

Latest rows separate the series template from its changing reading. The template stays out of line and is reused by updates. Revision, temporality and aggregation now live in that template. When one changes, the template hash changes and the writer replaces the template normally.

A regular observation stores its 64-character local ID in the reading. The template supplies the namespace; the full record ID and its canonical SHA-256 ID are reconstructed when read. Its content hash, result, quality, baseline, every timestamp and varying provenance are retained. Identities that cannot be represented losslessly keep their original full fields.

Both the TypeScript codec and PostgreSQL's `conditions.observation_record` accept the previous and compact representations. Direct result, quality, baseline, expiry and content-hash access remains unchanged. Federation capture reconstructs the complete record before publishing it. History and rollup formats do not change.

## Reproduce the benchmark

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
