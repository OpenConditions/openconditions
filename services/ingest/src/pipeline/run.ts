import { Readable } from "node:stream";
import type postgres from "postgres";
import type { Observation } from "@openconditions/core";
import type { FeedSource, SiteGeometry, UnresolvedRoadEvent } from "@openconditions/roads";
import type { MapMatchClient } from "@openconditions/openlr";
import { createResolverClient } from "@openconditions/openlr";
import {
  fetchAll,
  guardOptionsFromEnv,
  guardedFetch,
  makeAuthorizedFetch,
} from "@openconditions/ingest-framework";
import { isStreamingFlowFeed, streamMeasuredData } from "./measured-data.js";
import { parseFor } from "./parse.js";
import { resolveOpenLr } from "./resolve.js";
import { loadSiteTable } from "./site-table.js";
import type { SiteTableStreamFactory } from "./site-table.js";
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
 * Builds a streaming site-table source from the run's `fetch` so a custom fetch
 * (tests, instrumented clients) still drives the loader, while the body is
 * consumed as a stream — the large site table is never buffered whole.
 */
function streamFactoryFromFetch(fetchFn: typeof fetch): SiteTableStreamFactory {
  return async (url: string): Promise<Readable> => {
    const res = await fetchFn(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    if (!res.body) {
      throw new Error(`empty body fetching ${url}`);
    }
    return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  };
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

  // Guard every egress path (feed, discover, site-table, OAuth, mTLS) at one seam:
  // validate URL + DNS, re-check each redirect hop, cap size + time. Authorize on top.
  const guarded = guardedFetch(deps.fetch, guardOptionsFromEnv());
  const fetchFn = makeAuthorizedFetch(src, guarded);

  // Load the companion site table (cached, tolerant of failure) so flow feeds
  // that key measurements by site id can resolve geometry. Loaded before the feed
  // fetch so the streaming flow path has the join map ready.
  let siteMap: Map<string, SiteGeometry> | undefined;
  if (src.siteTable) {
    siteMap = await loadSiteTable(src, streamFactoryFromFetch(fetchFn));
    // A COLD site-table failure (no map ever built, not even stale) means every
    // measurement would lose its geometry and be skipped — parsing on would
    // hand atomicSwap an empty set, deleting all existing last-good rows. Treat
    // this like a fetch failure: skip the swap and preserve last-good.
    if (siteMap === undefined) {
      console.warn(
        `[ingest] ${src.id}: site-table cold failure — skipping swap, preserving last-good rows`
      );
      return { count: 0, durationMs: Date.now() - start };
    }
  }

  let parsed: (Observation | UnresolvedRoadEvent)[];
  if (isStreamingFlowFeed(src)) {
    // Large DATEX flow feed: stream fetch → gunzip → SAX so the ~50 MB document
    // is never buffered or DOM-parsed (the memory-cap OOM this path replaces).
    try {
      parsed = await streamMeasuredData(src, streamFactoryFromFetch(fetchFn), siteMap, deps.now);
    } catch (err) {
      console.error(`[ingest] stream failed for source ${src.id}:`, err);
      return { count: 0, durationMs: Date.now() - start };
    }
  } else {
    let buffers: Buffer[];
    try {
      buffers = await fetchAll(src, fetchFn);
    } catch (err) {
      console.error(`[ingest] fetch failed for source ${src.id}:`, err);
      return { count: 0, durationMs: Date.now() - start };
    }
    parsed = buffers.flatMap((b) => parseFor(src, b, siteMap));
  }

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
