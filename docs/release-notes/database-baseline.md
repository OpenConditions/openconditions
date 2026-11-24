# Database migration history reset to a baseline

Affected versions: The first product release containing the baseline and every later one. No product version is assigned by this change.

Action: Create the OpenConditions database afresh. A database created by an earlier build is not upgraded: its migrations fail with "relation already exists". Drop the `conditions` schema, or the whole database, before starting the new ingest service. Earlier builds kept their history in `drizzle.__drizzle_migrations_oc`; it is no longer read and can be dropped too.

Only the ingest service migrates now, and it records the history in `conditions.__drizzle_migrations`. The contributions and federation services wait at start until the schema reaches their version, for at most `OPENCONDITIONS_SCHEMA_WAIT_TIMEOUT_MS` (five minutes by default).

At every start the ingest service grants OpenMapX's tile role `openmapx_tiles_owner` and the contributions service's role `openconditions_contributions` exactly what they use, each if it exists. Create both before the ingest service first starts; a role created later gets its grants when the ingest service restarts. The federation service connects as the ingest service's role.

Crowd reporters are kept for 12 months after their last enrollment and entitlement end: the ingest service's records sweep then deletes a reporter with its votes, refusals and token quotas, and its evidence stays without its key. Ended token quotas, spent tokens past their issuer key's validity and federation erasure facts past their 30 days are deleted as well. The reporter table no longer has the unused columns `osm_uid`, `email_lookup_hmac` and `flagged_count`, and votes no longer have `subject_component_key`.

Compatibility: The resulting schema equals the one the earlier migrations produced, apart from the physical column order of some tables. The traffic tile function `conditions.segment_flow(integer, integer, integer, json)` is unchanged. Data fixes that the earlier migrations applied to existing rows are not part of the baseline, since a new database has no rows to fix.

Caveats: The earlier migration history is preserved in Git up to commit `09e880bd`. See [database migrations](../database-migrations.md) for how schema changes are made from now on.
