# Database migration history reset to a baseline

Affected versions: The first product release containing the baseline and every later one. No product version is assigned by this change.

Action: Create the OpenConditions database afresh. A database created by an earlier build is not upgraded: its migrations fail with "relation already exists". Drop the `conditions` schema and the `drizzle.__drizzle_migrations_oc` table, or the whole database, before starting the new ingest service.

Compatibility: The resulting schema equals the one the earlier migrations produced, apart from the physical column order of some tables. The traffic tile function `conditions.segment_flow(integer, integer, integer, json)` is unchanged. Data fixes that the earlier migrations applied to existing rows are not part of the baseline, since a new database has no rows to fix.

Caveats: The earlier migration history is preserved in Git up to commit `09e880bd`. See [database migrations](../database-migrations.md) for how schema changes are made from now on.
