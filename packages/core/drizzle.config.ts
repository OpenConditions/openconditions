import { defineConfig } from "drizzle-kit";

// Generates versioned SQL migrations in ./drizzle from the Drizzle schema.
// Run `pnpm --filter @openconditions/core db:generate` after changing schema.ts,
// then review (do not hand-edit) the generated migration. The PostGIS extension
// and `conditions` schema are created in runMigrations(), not in a migration —
// drizzle-kit does not model `CREATE EXTENSION` and omits `CREATE SCHEMA` here.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
});
