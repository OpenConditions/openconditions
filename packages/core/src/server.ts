// Server-only entry point: database access (drizzle-orm + postgres) and the
// services' startup configuration. Kept out of the main `@openconditions/core`
// barrel so consumers that only need the canonical model and read helpers —
// most notably the bundled OpenMapX provider integration — don't pull
// drizzle-orm/postgres into their artifact. Services that own the schema (the
// ingest) import `runMigrations` and the table from here. Mirrors the
// `@openmapx/core` vs `@openmapx/core/server` split.
export * from "./db/index.js";
export * from "./instance.js";
