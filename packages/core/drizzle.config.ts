import { defineConfig } from "drizzle-kit";

// Generates the SQL migrations in ./drizzle from the Drizzle schema: a
// generated baseline, and a `--custom` file with what drizzle-kit cannot
// express (functions, triggers, the partitioned observation table, storage
// settings, seed rows). Generated files are never hand-edited. How a schema
// change becomes a migration is described in docs/database-migrations.md.
// The PostGIS extension and `conditions` schema are created in runMigrations(),
// not in a migration — drizzle-kit does not model `CREATE EXTENSION` and omits
// `CREATE SCHEMA` here.
export default defineConfig({
  schema: "./src/db/*schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
});
