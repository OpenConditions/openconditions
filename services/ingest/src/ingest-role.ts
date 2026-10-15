import type { Catalog, CatalogFeed } from "@openconditions/ingest-framework";
import type postgres from "postgres";

/**
 * What one ingest process runs. The `primary` serves the HTTP API, runs the
 * work one process of a deployment must run (catalogue sync, partitions,
 * rollups, the sweep, the binding drain, the segment and nightly jobs, the
 * boot repairs) and polls its selected feeds; a `feeds` process only polls
 * the feeds it names, so slow ones stop delaying the rest.
 */
export type IngestRole = "primary" | "feeds";

/**
 * The sources whose leftovers (poll attempts left running, raw payloads on
 * the process's volume) a process owns: `only` these, or all `except` these.
 */
export type SourceScope = { only: readonly string[] } | { except: readonly string[] };

/** The condition that `column` names a source of `scope`; with none, every source. */
export function inScope(
  sql: postgres.Sql | postgres.TransactionSql,
  column: string,
  scope?: SourceScope,
) {
  if (!scope) return sql`TRUE`;
  return "only" in scope
    ? sql`${sql(column)} = ANY(${[...scope.only]}::text[])`
    : sql`NOT (${sql(column)} = ANY(${[...scope.except]}::text[]))`;
}

export interface IngestPlan {
  role: IngestRole;
  /** The feeds this process polls; an on-demand feed is read through by the primary's API instead. */
  feeds: CatalogFeed[];
  scope: SourceScope;
}

const ROLE = "OPENCONDITIONS_INGEST_ROLE";
const FEEDS = "OPENCONDITIONS_INGEST_FEEDS";
const EXCLUDE = "OPENCONDITIONS_INGEST_FEEDS_EXCLUDE";

/** A feed id, `*` standing for any run of characters. */
const PATTERN = /^[a-z0-9*]+(-[a-z0-9*]+)*$/;

/** The process's role from `OPENCONDITIONS_INGEST_ROLE`: unset or empty, the primary. */
export function ingestRoleFromEnv(env: NodeJS.ProcessEnv = process.env): IngestRole {
  const raw = env[ROLE]?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "primary") return "primary";
  if (raw === "feeds") return "feeds";
  throw new Error(`${ROLE}: "${env[ROLE]}" is neither "primary" nor "feeds"`);
}

/** The comma-separated feed ids or patterns `key` holds; unset or empty, none. */
export function feedPatternsFromEnv(env: NodeJS.ProcessEnv, key: string): string[] {
  const patterns = (env[key] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  for (const p of patterns) {
    if (!PATTERN.test(p)) {
      throw new Error(
        `${key}: "${p}" is not a feed id or a pattern of one (lower-case letters, digits, "-" and "*")`,
      );
    }
  }
  return patterns;
}

function matcher(pattern: string): (id: string) => boolean {
  const re = new RegExp(`^${pattern.replaceAll("*", ".*")}$`);
  return (id) => re.test(id);
}

/**
 * Which feeds this process polls and which sources it owns, from its role,
 * `OPENCONDITIONS_INGEST_FEEDS` (the feeds it polls; unset, all) and
 * `OPENCONDITIONS_INGEST_FEEDS_EXCLUDE` (those it leaves to another process),
 * each comma-separated feed ids or `*` patterns. A process that splits the
 * catalogue with another reads the same list into the other variable, so
 * each polled feed falls to exactly one of them.
 *
 * Throws on a name that cannot be a feed id, on an included name that
 * matches no feed of the catalogue (a typo would leave the feed unpolled),
 * and on a `feeds` process that names or keeps no polled feed. An excluded
 * name that matches nothing only warns: the primary keeps serving if a
 * release drops a feed it was told to leave.
 */
export function planIngest(
  catalog: Pick<Catalog, "feeds" | "disabled" | "discovered">,
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, "warn" | "info"> = console,
): IngestPlan {
  const role = ingestRoleFromEnv(env);
  const include = feedPatternsFromEnv(env, FEEDS);
  const exclude = feedPatternsFromEnv(env, EXCLUDE);
  if (role === "feeds" && include.length === 0) {
    throw new Error(`${ROLE}=feeds polls only the feeds ${FEEDS} names; set it`);
  }
  const known = [...catalog.feeds, ...catalog.disabled, ...catalog.discovered].map((f) => f.id);
  const polled = catalog.feeds.filter((f) => f.accessMode !== "on_demand");
  for (const p of include) {
    const matches = matcher(p);
    if (!known.some(matches)) throw new Error(`${FEEDS}: "${p}" matches no feed of the catalogue`);
    if (!polled.some((f) => matches(f.id))) {
      log.warn(
        `[ingest] ${FEEDS}: "${p}" names no polled feed (disabled, discovered or on demand)`,
      );
    }
  }
  for (const p of exclude) {
    if (!known.some(matcher(p))) {
      log.warn(`[ingest] ${EXCLUDE}: "${p}" matches no feed of the catalogue`);
    }
  }
  const included = include.map(matcher);
  const excluded = exclude.map(matcher);
  const selected = (id: string) =>
    (included.length === 0 || included.some((m) => m(id))) && !excluded.some((m) => m(id));
  const feeds = polled.filter((f) => selected(f.id));
  if (role === "feeds" && feeds.length === 0) {
    throw new Error(`${ROLE}=feeds polls no feed: ${FEEDS} and ${EXCLUDE} leave none`);
  }
  if (role === "feeds") {
    const only = feeds.map((f) => f.id);
    log.info(`[ingest] polling ${only.length} feed(s) only: ${only.join(", ")}`);
    return { role, feeds, scope: { only } };
  }
  const elsewhere = polled.filter((f) => !selected(f.id)).map((f) => f.id);
  if (elsewhere.length > 0) {
    log.info(
      `[ingest] ${elsewhere.length} feed(s) left to another ingest process: ${elsewhere.join(", ")}`,
    );
  }
  return { role, feeds, scope: { except: elsewhere } };
}
