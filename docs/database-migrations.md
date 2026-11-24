# Database migrations

OpenConditions keeps its database schema in the Drizzle schema code under `packages/core/src/db/*schema.ts` and its migrations in `packages/core/drizzle`. `runMigrations()` in `packages/core/src/db/migrate.ts` creates the PostGIS extension and the `conditions` schema, then applies every migration the database has not seen yet, under an advisory lock and in one transaction.

## Who migrates

Only the ingest service's processes run `runMigrations()`, at every start: the primary and, when enabled, the heavy-feeds process (`OPENCONDITIONS_INGEST_ROLE=feeds`, the `openconditions-ingest-heavy` service), which shares the primary's role. `runMigrations()` records each applied migration in `conditions.__drizzle_migrations`, inside the schema the migrations build, so the ingest role needs to own nothing but `conditions` (and `CREATE` on the database, which `CREATE SCHEMA IF NOT EXISTS` checks at every start, also once `conditions` exists), the history never mixes with another Drizzle project's in a shared database, and dropping `conditions` drops its history with it. Code sets no `search_path`: the operator sets the roles' search path (`conditions, extensions` under OpenMapX, whose PostGIS lives in the schema `extensions`).

The contributions and federation services apply no migrations. At start they call `waitForSchemaVersion()` (`packages/core/src/db/schema-version.ts`), which polls every two seconds until `max(created_at)` in `conditions.__drizzle_migrations` is at least the `when` of the last entry in the journal (`meta/_journal.json`) their build ships. A newer ingest that applied later migrations satisfies it too. A missing schema, table or read grant counts as not migrated yet. After `OPENCONDITIONS_SCHEMA_WAIT_TIMEOUT_MS` (default 300000) the service stops with the version it expected and what it found. Reading the version takes `USAGE` on `conditions` and `SELECT` on the history table, no DDL right. Every service image carries the migrations folder next to its entry, so the journal is the same file the ingest service migrates from. While they wait for a first migration that takes longer than about three minutes, the contributions and federation services report unhealthy, and they recover once it finishes.

## Database roles and grants

Each OpenConditions service connects as a dedicated role, never as the PostgreSQL superuser; the heavy-feeds process and the federation service share the ingest service's (below). After every migrate, `runMigrations()` calls `conditions.grant_consumer_roles()`, a function of the custom migration that grants two roles by name exactly what they use, each only if it exists. It runs with its caller's rights and no role but its owner (the ingest service's role) may call it:

- `openmapx_tiles_owner` is OpenMapX's role for its traffic tile. OpenMapX's PostGIS service creates it at every start; it cannot log in and owns the function in OpenMapX's `tiles` schema that the tile server calls, which calls `conditions.segment_flow`. It gets `USAGE` on `conditions`, `SELECT` on `road_segment`, `segment_speed`, `source` and `public_license_policy`, and `EXECUTE` on `segment_flow`, `flow_public_licenses` and `flow_osm_credit`: what the tile reads, so credentials, crowd data and every other table stay unreadable to it.
- `openconditions_contributions` is the contributions service's login, which the operator creates as OpenMapX's community extensions guide describes. It gets `USAGE` on `conditions`, `SELECT` on `conditions.__drizzle_migrations` for the schema version and on `conditions.secrets_key_check` to verify its secrets key, and the table privileges its queries use (the identity columns it inserts into need no grant on their sequences): reporters, block list, reports, votes and evidence, the issuer's keys and tokens, the situations and latest readings reports land on, the fused readings they refresh and the feed readings they are checked against. The federation capture triggers run with its rights when it writes a situation or a latest reading, so it also reads the subscriptions and journals into the outbox. It deletes no reporter: the ingest service's sweep does, as the owner, and the reporter strip trigger runs with the deleting role's rights.

The ingest service's role (`openconditions_ingest` under OpenMapX) owns `conditions` and needs no grant. The heavy-feeds process connects as the same role, since it migrates, grants and may seal the secrets key check like the primary; a role of its own would fail at `CREATE SCHEMA`, at the migration or at the grant step. The federation service connects as the same role too: at every start it creates and drops partitions of `observation`, which only the table's owner may do.

`services/ingest/src/__tests__/grants.integration.test.ts` checks that each role holds exactly its grants and renders the traffic tile as a role holding only the tile grants. `services/contributions-api/src/__tests__/role-grants.integration.test.ts` runs the contributions service's flows as a role holding only its grants, so a query that needs a privilege the function does not grant fails there.

Create both roles before the ingest service first starts, so the contributions service finds its grants as soon as the first migration is done. A role created later, or dropped and created again, gets its grants once the ingest service restarts (or its migrate runs again).

## The baseline

The folder holds two migrations. `0000_baseline.sql` is generated by drizzle-kit from the schema code and is never edited by hand. `0001_database_objects.sql` is a `--custom` migration with what drizzle-kit cannot express: the partitioned `observation` table and its index, the storage settings of `observation_latest`, the functions (among them `conditions.segment_flow`, the traffic tile OpenMapX serves), the federation capture triggers, the trigger that strips a deleted reporter's key from what it reported, the federation journal's first epoch and the function that grants the roles above. A test (`packages/core/src/__tests__/migration-files.test.ts`) refuses any other kind of statement in the custom file. Everything drizzle-kit can express, such as tables, columns, defaults, CHECKs, indexes and keys, belongs in the schema code.

The baseline replaced a history of 107 migrations (`0000` to `0106`). That history is preserved in Git up to commit `09e880bd`. A database created by it is not upgraded: migrating it fails with "relation already exists", and it has to be dropped and created again.

## Changing the schema

While no installation has to stay upgradeable, a schema change regenerates the baseline instead of adding a migration:

1. Copy the body of `packages/core/drizzle/0001_database_objects.sql` aside.
2. Delete the folder with `git rm -r packages/core/drizzle`.
3. Run `pnpm --filter @openconditions/core db:generate --name baseline`.
4. Run `pnpm --filter @openconditions/core db:generate --custom --name database_objects`.
5. Write the saved body, with any change to the objects it holds, into the new custom file.
6. Commit, then run `pnpm check:migrations`, which must pass.

Every constraint and index is named after its table and columns: `<table>_pkey`, `<table>_<columns>_key`, `<table>_<column>_fkey`, `<table>_<columns>_idx` and `<table>_<what>_check`. drizzle-orm's `.references()` and an unnamed composite `primaryKey()` cannot carry such a name, so foreign keys are declared with `foreignKey({ name })` and composite primary keys with `primaryKey({ name })`. A partial index that selects rows by more than whether a column is null, an index in another collation than its column's, an index on an expression and a name past PostgreSQL's 63 characters are named for their purpose instead, still with the table as prefix and the kind as suffix. Ids are identity columns generated by default, never `serial`, and a closed set of values gets a CHECK. The schema conventions test in `services/ingest/src/__tests__/baseline-schema.integration.test.ts` checks all of this against the catalog.

Never run `drizzle-kit generate` against the old files during this procedure. If it prompts, or emits an `ALTER` other than the foreign-key constraints drizzle-kit adds after the tables, the folder was not empty.

Once the first release containing the baseline is installed, a schema change adds an ordinary incremental migration: change the schema code and run `pnpm --filter @openconditions/core db:generate`. Objects drizzle-kit cannot express go into a migration created with `--custom`. From then on, `0000_baseline.sql` and `0001_database_objects.sql` are never edited or regenerated.

## Drift gate

`pnpm check:migrations` (`scripts/check-drizzle-drift.ts`) runs `drizzle-kit check` and `drizzle-kit generate` in `packages/core`, each with a timeout. It passes only when `check` reports "Everything's fine", `generate` reports "No schema changes, nothing to migrate", neither prints an error, and `git status` shows no change in the migrations folder. Checking the messages matters: without a terminal, drizzle-kit refuses a rename question, and fails to load broken schema code, while still exiting 0 and writing nothing. The gate therefore fails when the schema code has a change no migration carries, when drizzle-kit would have to ask, and when the folder has uncommitted changes, so run it on a committed tree. CI runs it in the typecheck and test job.
