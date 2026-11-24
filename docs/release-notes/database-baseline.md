# Database migration history reset to a baseline

Affected versions: The first product release containing the baseline and every later one. No product version is assigned by this change.

Action: Create the OpenConditions database afresh. A database created by an earlier build is not upgraded: its migrations fail with "relation already exists". Drop the `conditions` schema, or the whole database, before starting the new ingest service. Earlier builds kept their history in `drizzle.__drizzle_migrations_oc`; it is no longer read and can be dropped too.

Only the ingest service migrates now, and it records the history in `conditions.__drizzle_migrations`. The contributions and federation services wait at start until the schema reaches their version, for at most `OPENCONDITIONS_SCHEMA_WAIT_TIMEOUT_MS` (five minutes by default).

At every start the ingest service grants OpenMapX's tile role `openmapx_tiles_owner` and the contributions service's role `openconditions_contributions` exactly what they use, each if it exists. Create both before the ingest service first starts; a role created later gets its grants when the ingest service restarts. The federation service connects as the ingest service's role.

Crowd reporters are kept for 12 months after their last enrollment and entitlement end: the ingest service's records sweep then deletes a reporter with its votes, refusals and token quotas, and its evidence stays without its key. Deleting a reporter, by the sweep or by hand, also removes its key from its crowd readings, situations, revisions and federation journal entries. Ended token quotas, spent tokens a day past their issuer key's validity and federation erasure facts past their 30 days are deleted as well. The reporter table no longer has the unused columns `osm_uid`, `email_lookup_hmac` and `flagged_count`, and votes no longer have `subject_component_key`.

Compatibility: The resulting schema differs from the one the earlier migrations produced in these ways:

- Secrets: OAuth tokens and the issuer and federation private keys are stored encrypted, checked against the `secrets_key_check` table.
- Crowd data: the dropped columns and the retention above.
- Names: every constraint and index is named after its table and columns (`<table>_pkey`, `<table>_<columns>_key`, `<table>_<column>_fkey`, `<table>_<columns>_idx`, `<table>_<what>_check`).
- Ids and types: the five `bigserial` ids are identity columns, with the same sequence names; `jma_budget.day` is a `date`; `segment_observation.confidence` is `confidence_score`; `smn_cap_message.retrieval` has no default.
- Checks: closed value sets are checked (level of service, segment speed confidence, binding status and direction, subscription status, erasure reason), and so is the GeoNet coverage window.
- Indexes: three indexes that a primary key serves or nothing reads are gone, the crowd evidence index keys on the evidence state alone, and `feature` and `offer` have indexes for the records sweep.
- Storage: `observation`, `observation_latest` and `observation_rollup_hourly` store their fixed-width columns first.

The traffic tile function `conditions.segment_flow(integer, integer, integer, json)` is unchanged. Data fixes that the earlier migrations applied to existing rows are not part of the baseline, since a new database has no rows to fix.

Caveats: The earlier migration history is preserved in Git up to commit `09e880bd`. See [database migrations](../database-migrations.md) for how schema changes are made from now on.
