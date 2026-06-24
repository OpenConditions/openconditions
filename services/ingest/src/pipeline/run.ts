import type postgres from "postgres";
import type { FeedSource } from "@openconditions/roads";
import type { MapMatchClient } from "@openconditions/openlr";
import { createResolverClient } from "@openconditions/openlr";
import { fetchAll } from "./fetch.js";
import { parseFor } from "./parse.js";
import { resolveOpenLr } from "./resolve.js";
import { loadSiteTable } from "./site-table.js";
import { atomicSwap } from "./write-postgis.js";

type Sql = postgres.Sql;

export interface RunResult {
  count: number;
  durationMs: number;
}

export interface RunDeps {
  sql: Sql;
  fetch: typeof fetch;
  now: () => string;
  openlrClient?: MapMatchClient | null;
}

/**
 * A FeedSource annotated with its domain name so the pipeline can dispatch
 * to the correct domain plugin without coupling FeedSource to ingest internals.
 */
export interface DomainFeedSource extends FeedSource {
  domain: string;
}

/**
 * Creates a map-match client from OPENLR_RESOLVER_URL if the env var is set.
 * Returns null when the variable is absent or empty.
 */
export function createOpenlrClient(): MapMatchClient | null {
  const url = process.env["OPENLR_RESOLVER_URL"] || undefined;
  if (!url) return null;
  return createResolverClient(url);
}

/**
 * Runs the full ingest pipeline for one feed source:
 *   1. Fetch all URLs for the source (gunzip transparently).
 *   2. Parse each buffer via the domain plugin.
 *   3. Resolve any OpenLR-only observations via the map-match service.
 *   4. Atomically swap the `conditions.observations` rows for this source.
 *
 * Feed-downtime safety: if fetching throws, the swap is never opened and
 * existing rows for this source are left intact (last-good behavior).
 * The error is logged and the function returns {count:0, durationMs}.
 */
export async function runSource(src: DomainFeedSource, deps: RunDeps): Promise<RunResult> {
  const start = Date.now();

  let buffers: Buffer[];
  try {
    buffers = await fetchAll(src, deps.fetch);
  } catch (err) {
    console.error(`[ingest] fetch failed for source ${src.id}:`, err);
    return { count: 0, durationMs: Date.now() - start };
  }

  // Load the companion site table (cached, tolerant of failure) so flow feeds
  // that key measurements by site id can resolve geometry. Absent/failed loads
  // simply leave measurements without external geometry (those sites are then
  // skipped) rather than failing the run.
  const siteMap = src.siteTable ? await loadSiteTable(src, deps.fetch) : undefined;

  const parsed = buffers.flatMap((b) => parseFor(src, b, siteMap));
  // resolveOpenLr narrows the union: items without geometry (UnresolvedRoadEvent)
  // are resolved to real geometry or dropped — resolved[] always has geometry.
  const { resolved, dropped } = await resolveOpenLr(parsed, deps.openlrClient ?? null);

  await atomicSwap(deps.sql, src.id, resolved, src.freshnessWindowSec);

  const durationMs = Date.now() - start;
  const dropNote = dropped > 0 ? ` (${dropped} dropped — no geometry)` : "";
  console.info(
    `[ingest] ${src.id}: inserted ${resolved.length} rows in ${durationMs}ms${dropNote}`
  );
  return { count: resolved.length, durationMs };
}
