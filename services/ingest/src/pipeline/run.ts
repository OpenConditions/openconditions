import { Readable } from "node:stream";
import type postgres from "postgres";
import type { Observation } from "@openconditions/core";
import type { FeedSource, SiteGeometry, UnresolvedRoadEvent } from "@openconditions/roads";
import { enrichFlowsWithBaseline } from "@openconditions/roads";
import type { MapMatchClient } from "@openconditions/openlr";
import { createResolverClient } from "@openconditions/openlr";
import {
  fetchAll,
  guardOptionsFromEnv,
  guardedFetch,
  makeAuthorizedFetch,
} from "@openconditions/ingest-framework";
import type { LookupFn } from "@openconditions/ingest-framework";
import { feedToSourceDescriptor } from "../domains.js";
import { isStreamingFlowFeed, streamMeasuredData } from "./measured-data.js";
import { parseFor } from "./parse.js";
import { resolveOpenLr } from "./resolve.js";
import { loadSiteTable } from "./site-table.js";
import type { SiteTableStreamFactory } from "./site-table.js";
import { loadStationRegistry } from "./station-registry.js";
import { atomicSwap } from "./write-postgis.js";
import { loadBaselineMap, writeSpeedSamples } from "./baseline-store.js";

type Sql = postgres.Sql;

export interface RunResult {
  count: number;
  durationMs: number;
  /**
   * Set when the run swallowed a genuine failure (site-table cold failure,
   * streaming-flow error, or fetch error) rather than throwing. Absent for a
   * successful poll, including an unchanged (304/interval-gated) poll — that
   * is a successful no-op, not a failure. Callers that need "did this run
   * actually succeed" (e.g. the scheduler's status recording) must check
   * this field, not just whether the call threw.
   */
  error?: string;
}

export interface RunDeps {
  sql: Sql;
  fetch: typeof fetch;
  now: () => string;
  openlrClient?: MapMatchClient | null;
  /**
   * Overrides the DNS resolver `guardedFetch` uses to pin egress connections.
   * Left unset in production (the scheduler doesn't set it), so `guardedFetch`
   * falls back to its default real `node:dns` lookup — pinning behavior is
   * unchanged. Tests inject a fake here so a fake `fetch` used to serve
   * fixtures doesn't still require live DNS to resolve the feed host first.
   */
  lookup?: LookupFn;
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
 * The error is logged and the function returns {count:0, durationMs, error}
 * so callers can distinguish a swallowed failure from a genuinely successful
 * (including unchanged/304) poll.
 */
export async function runSource(src: DomainFeedSource, deps: RunDeps): Promise<RunResult> {
  const start = Date.now();

  // Guard every egress path (feed, catalog, site-table, OAuth, mTLS) at one seam:
  // validate URL + DNS, re-check each redirect hop, cap size + time. Authorize on top.
  // The guard pins the socket to the validated IP via an undici dispatcher, which
  // only undici's fetch honors — so `deps.fetch` MUST be undici's fetch in
  // production (the scheduler passes it). Tests inject a fake fetch that serves
  // fixtures and ignores the dispatcher, keeping the run path hermetic.
  const guarded = guardedFetch(deps.fetch, guardOptionsFromEnv(), {}, deps.lookup);
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
      return {
        count: 0,
        durationMs: Date.now() - start,
        error: "site-table cold failure — no geometry map built",
      };
    }
  }

  // Same join, JSON/GeoJSON shape: a station registry supplies geometry for
  // flow feeds keyed only by station id (Fintraffic, WebTRIS) rather than a
  // DATEX site table. Mutually exclusive with `siteTable` in practice. Uses
  // the same guarded `fetchFn` the feed fetch uses, so the registry request is
  // egress-guarded too.
  if (src.stationRegistry) {
    siteMap = await loadStationRegistry(src, fetchFn);
    if (siteMap === undefined) {
      console.warn(
        `[ingest] ${src.id}: station-registry cold failure — skipping swap, preserving last-good rows`
      );
      return {
        count: 0,
        durationMs: Date.now() - start,
        error: "station-registry cold failure — no geometry map built",
      };
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
      return {
        count: 0,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    let buffers: Buffer[];
    try {
      const result = await fetchAll(src, fetchFn);
      if (result.status === "unchanged") {
        // 304 on every URL, or gated by fetchIntervalSec — keep last-good rows, no swap.
        return { count: 0, durationMs: Date.now() - start };
      }
      buffers = result.buffers;
    } catch (err) {
      console.error(`[ingest] fetch failed for source ${src.id}:`, err);
      return {
        count: 0,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    parsed = buffers.flatMap((b) => parseFor(src, b, siteMap));
  }

  // resolveOpenLr narrows the union: items without geometry (UnresolvedRoadEvent)
  // are resolved to real geometry or dropped — resolved[] always has geometry.
  const { resolved, dropped } = await resolveOpenLr(parsed, deps.openlrClient ?? null);

  // Stamp each flow's free-flow baseline (native > derived > osm_maxspeed) before
  // the swap so the enriched los/freeFlowKph and any newly derived congestion
  // events are what gets persisted, for every flow format (buffered and
  // streaming NDW alike) at this one seam.
  let toWrite = resolved;
  if (src.produces === "flow") {
    // Best-effort: a baseline-load failure must never throw away a good fetch +
    // resolve — fall back to writing the unenriched observations rather than
    // aborting the whole poll and reverting the feed to stale data.
    try {
      const baselineMap = await loadBaselineMap(deps.sql, src.id, deps.now);
      if (baselineMap.size > 0) {
        toWrite = enrichFlowsWithBaseline(resolved, baselineMap, feedToSourceDescriptor(src));
      }
    } catch (err) {
      console.warn(`[ingest] ${src.id}: baseline-map load failed, skipping enrichment:`, err);
    }
  }

  await atomicSwap(deps.sql, src.id, toWrite, src.freshnessWindowSec);

  if (src.produces === "flow") {
    // Append this cycle's speeds to the rolling per-sensor history (the raw
    // material the nightly baseline derivation consumes). Best-effort: a history
    // write must never fail the live swap that already succeeded.
    try {
      await writeSpeedSamples(deps.sql, src.id, toWrite, deps.now, src.cadenceSec);
    } catch (err) {
      console.warn(`[ingest] ${src.id}: speed-sample write failed:`, err);
    }
  }

  const durationMs = Date.now() - start;
  const dropNote = dropped > 0 ? ` (${dropped} dropped — no geometry)` : "";
  console.info(`[ingest] ${src.id}: inserted ${toWrite.length} rows in ${durationMs}ms${dropNote}`);
  return { count: toWrite.length, durationMs };
}
