import type postgres from "postgres";
import type { FeedSource } from "@openconditions/roads";
import { fetchAll } from "./fetch.js";
import { parseFor } from "./parse.js";
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
}

/**
 * A FeedSource annotated with its domain name so the pipeline can dispatch
 * to the correct domain plugin without coupling FeedSource to ingest internals.
 */
export interface DomainFeedSource extends FeedSource {
  domain: string;
}

/**
 * Runs the full ingest pipeline for one feed source:
 *   1. Fetch all URLs for the source (gunzip transparently).
 *   2. Parse each buffer via the domain plugin.
 *   3. Atomically swap the `conditions.observations` rows for this source.
 *
 * Feed-downtime safety: if fetching throws, the swap is never opened and
 * existing rows for this source are left intact (last-good behavior).
 * The error is logged and the function returns {count:0, durationMs}.
 */
export async function runSource(
  src: DomainFeedSource,
  deps: RunDeps,
): Promise<RunResult> {
  const start = Date.now();

  let buffers: Buffer[];
  try {
    buffers = await fetchAll(src, deps.fetch);
  } catch (err) {
    console.error(`[ingest] fetch failed for source ${src.id}:`, err);
    return { count: 0, durationMs: Date.now() - start };
  }

  const items = buffers.flatMap((b) => parseFor(src, b));
  const fresh = items;

  await atomicSwap(deps.sql, src.id, fresh);

  const durationMs = Date.now() - start;
  console.info(`[ingest] ${src.id}: inserted ${fresh.length} rows in ${durationMs}ms`);
  return { count: fresh.length, durationMs };
}
