# Database migration history reset to a baseline

Affected versions: The first product release containing the baseline and every later one. No product version is assigned by this change.

Action: Create the OpenConditions database afresh. A database created by an earlier build is not upgraded: its migrations fail with "relation already exists". Drop the `conditions` schema, or the whole database, before starting the new ingest service. Earlier builds kept their history in `drizzle.__drizzle_migrations_oc`; it is no longer read and can be dropped too.

Only the ingest service migrates now, and it records the history in `conditions.__drizzle_migrations`. The contributions and federation services wait at start until the schema reaches their version, for at most `OPENCONDITIONS_SCHEMA_WAIT_TIMEOUT_MS` (five minutes by default).

The migration grants OpenMapX's tile role `openmapx_tiles_owner` and the contributions service's role `openconditions_contributions` exactly what they use, provided they exist when it runs, so create both before the ingest service first starts. The federation service connects as the ingest service's role.

Compatibility: The resulting schema equals the one the earlier migrations produced, apart from the physical column order of some tables. The traffic tile function `conditions.segment_flow(integer, integer, integer, json)` is unchanged. Data fixes that the earlier migrations applied to existing rows are not part of the baseline, since a new database has no rows to fix.

Caveats: The earlier migration history is preserved in Git up to commit `09e880bd`. See [database migrations](../database-migrations.md) for how schema changes are made from now on.
