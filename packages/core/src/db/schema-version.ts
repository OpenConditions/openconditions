import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Sql } from "postgres";
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, resolveMigrationsFolder } from "./migrate.js";

/** How long a service waits for the schema when its configuration names no other limit. */
export const DEFAULT_SCHEMA_WAIT_TIMEOUT_MS = 5 * 60_000;

/** How often the migration history is read while the schema is behind. */
const DEFAULT_POLL_MS = 2_000;

const HISTORY = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;

/** The latest migration this build ships: its journal tag and `when`. */
export interface SchemaVersion {
  tag: string;
  when: number;
}

/**
 * What the database holds: the latest recorded migration's `when`, an empty
 * history, no history table (or no `conditions` schema) yet, or a history the
 * role may not read.
 */
export type AppliedSchemaVersion =
  | { state: "applied"; when: number }
  | { state: "empty" }
  | { state: "absent" }
  | { state: "unreadable"; detail: string };

/**
 * The latest entry of the migrations journal this build carries. Every image
 * ships the migrations folder next to its entry, as the ingest service's
 * migrator reads it, so the services that do not migrate read the same file.
 */
export function expectedSchemaVersion(folder: string = resolveMigrationsFolder()): SchemaVersion {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries?: { tag?: unknown; when?: unknown }[];
  };
  const last = journal.entries?.at(-1);
  if (typeof last?.tag !== "string" || typeof last.when !== "number") {
    throw new Error(`the migrations journal in ${folder} has no entry with a tag and a time`);
  }
  return { tag: last.tag, when: last.when };
}

/** Reads the latest recorded migration, telling a missing or unreadable history apart. */
export async function appliedSchemaVersion(sql: Sql): Promise<AppliedSchemaVersion> {
  try {
    const [row] = await sql<{ latest: string | null }[]>`
      SELECT max(created_at)::text AS latest FROM ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}`;
    if (row?.latest == null) return { state: "empty" };
    return { state: "applied", when: Number(row.latest) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // invalid_schema_name, undefined_table: the ingest service has not migrated yet.
    if (code === "3F000" || code === "42P01") return { state: "absent" };
    // insufficient_privilege: the grant arrives with the migrations, so this
    // too can be a database the ingest service is still migrating.
    if (code === "42501") {
      return { state: "unreadable", detail: (error as Error).message };
    }
    throw error;
  }
}

function describe(found: AppliedSchemaVersion): string {
  switch (found.state) {
    case "applied":
      return `the latest recorded migration has when ${found.when}`;
    case "empty":
      return `${HISTORY} is empty`;
    case "absent":
      return `${HISTORY} does not exist`;
    case "unreadable":
      return `${HISTORY} cannot be read by this role (${found.detail}); it needs USAGE on the schema conditions and SELECT on the table`;
  }
}

export interface WaitForSchemaVersionOptions {
  /** How long to wait before giving up. */
  timeoutMs: number;
  /** How often to read the history while waiting; 2 s. */
  pollMs?: number;
  /** Called once, when the first read finds the schema behind, with what it found. */
  onWait?: (found: string, expected: SchemaVersion) => void;
  /** The migrations folder whose journal names the expected version; the bundled one. */
  migrationsFolder?: string;
}

/**
 * Resolves once the ingest service has migrated the database at least to the
 * latest migration this build ships: `max(created_at)` in
 * `conditions.__drizzle_migrations` is at least that journal entry's `when`.
 * A newer schema, from a newer ingest, satisfies it too. A missing schema,
 * table or grant counts as not yet migrated. Needs no DDL right: only USAGE
 * on `conditions` and SELECT on the history table. Throws after `timeoutMs`,
 * saying which version it expected and what it found.
 */
export async function waitForSchemaVersion(
  sql: Sql,
  options: WaitForSchemaVersionOptions,
): Promise<void> {
  const expected = expectedSchemaVersion(options.migrationsFolder);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + options.timeoutMs;
  let told = false;
  for (;;) {
    const found = await appliedSchemaVersion(sql);
    if (found.state === "applied" && found.when >= expected.when) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(
        `the database schema did not reach this build's version within ${options.timeoutMs} ms: ` +
          `expected a migration in ${HISTORY} with when ${expected.when} (${expected.tag}) or later, ` +
          `but ${describe(found)}. The ingest service applies the migrations; check that it runs ` +
          "this release or a newer one and that its migration succeeded",
      );
    }
    if (!told) {
      options.onWait?.(describe(found), expected);
      told = true;
    }
    await sleep(Math.min(pollMs, left));
  }
}

/**
 * The wait timeout a service reads from its configuration: a whole number of
 * milliseconds above 0, or the default when the variable is unset or empty.
 */
export function schemaWaitTimeoutMs(env: NodeJS.ProcessEnv, variable: string): number {
  const raw = env[variable]?.trim();
  if (raw == null || raw === "") return DEFAULT_SCHEMA_WAIT_TIMEOUT_MS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${variable} must be a whole number of milliseconds above 0, got "${raw}"`);
  }
  return value;
}
