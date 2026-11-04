-- PostgreSQL 18. Run with psql -X -v ON_ERROR_STOP=1 -qAt -f snapshot.sql.
-- Store stdout outside the database at each end of a measurement window.
-- These counters are cumulative. Do not reset them between snapshots.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '1s';

SELECT jsonb_build_object('kind', 'identity', 'at', clock_timestamp(),
  'database', current_database(), 'server_version', current_setting('server_version'),
  'postmaster_start', pg_postmaster_start_time(), 'database_stats_reset', stats_reset)
FROM pg_stat_database WHERE datname = current_database();

SELECT jsonb_build_object('kind', 'wal', 'at', clock_timestamp(), 'stats', to_jsonb(w))
FROM pg_stat_wal w;

SELECT jsonb_build_object('kind', 'checkpointer', 'at', clock_timestamp(), 'stats', to_jsonb(c))
FROM pg_stat_checkpointer c;

SELECT jsonb_build_object('kind', 'io', 'at', clock_timestamp(), 'stats', to_jsonb(i))
FROM pg_stat_io i;

SELECT jsonb_build_object('kind', 'table', 'at', clock_timestamp(),
  'schema', schemaname, 'table', relname, 'oid', relid,
  'inserts', n_tup_ins, 'updates', n_tup_upd, 'hot_updates', n_tup_hot_upd,
  'deletes', n_tup_del, 'live_estimate', n_live_tup, 'dead_estimate', n_dead_tup,
  'autovacuum_count', autovacuum_count, 'autoanalyze_count', autoanalyze_count)
FROM pg_stat_user_tables WHERE schemaname = 'conditions' ORDER BY relname;

-- Other schemas share the same cluster-wide WAL counter.
SELECT jsonb_build_object('kind', 'other_schema_activity', 'at', clock_timestamp(),
  'schema', schemaname, 'inserts', sum(n_tup_ins), 'updates', sum(n_tup_upd),
  'deletes', sum(n_tup_del))
FROM pg_stat_user_tables WHERE schemaname <> 'conditions' GROUP BY schemaname;

SELECT jsonb_build_object('kind', 'setting', 'name', name, 'setting', setting, 'unit', unit)
FROM pg_settings WHERE name IN ('shared_buffers', 'max_wal_size', 'checkpoint_timeout',
  'checkpoint_completion_target', 'wal_compression', 'full_page_writes',
  'synchronous_commit', 'wal_level', 'track_wal_io_timing', 'block_size');

SELECT jsonb_build_object('kind', 'extension', 'name', extname, 'version', extversion)
FROM pg_extension WHERE extname IN ('pg_stat_statements', 'pg_stat_kcache');

-- Publication counters describe application work, not physical row updates.
SELECT jsonb_build_object('kind', 'source', 'source', source,
  'last_success', last_success_at, 'last_publication', last_publication_at,
  'outcome', last_outcome, 'reported_inserted', last_inserted,
  'reported_updated', last_updated, 'reported_deleted', last_deleted,
  'reported_rejected', last_rejected)
FROM conditions.source_status ORDER BY source;
COMMIT;
