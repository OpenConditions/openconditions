import { Readable } from "node:stream";
import type postgres from "postgres";
import type { Observation } from "@openconditions/core";
import type { FeedSource, SiteGeometry, UnresolvedRoadEvent } from "@openconditions/roads";
import { enrichEventSeverity, enrichFlowsWithBaseline } from "@openconditions/roads";
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
import { getLastRowCount, upsertSourceStatus } from "./source-status.js";

type Sql = postgres.Sql;

/**
 * Ratio (0-1) of an event feed's previous `source_status.last_row_count` that
 * its fresh count must exceed, or the swap is skipped as a suspected
 * partial-failure wipe rather than applied (see the shrink tripwire below).
 * Default 0: conservative, only guards the unambiguous drop-to-zero case (a
 * fresh count of exactly 0 while the previous cycle had rows) — a feed whose
 * count merely shrinks while staying above zero is written as-is, since a
 * smaller-but-nonempty count is often a legitimate falling event count, not a
 * partial parse. Raise it (e.g. "0.1") via env to also guard partial drops.
 * A `""` value (Compose's `${VAR:-}` unset-injection) is treated as absent,
 * matching the repo's other env-tunable readers (see guardOptionsFromEnv).
 * Read fresh on every call (same per-call env-read path as
 * `guardOptionsFromEnv`), not cached at module load, so the env var takes
 * effect without a process restart.
 */
function shrinkTripwireRatioFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["OPENCONDITIONS_SHRINK_TRIPWIRE_RATIO"];
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface RunResult {
  /**
   * Rows actually persisted this cycle: `inserted + updated` from the
   * diff-upsert swap (an unchanged row, left untouched by the swap, counts
   * toward neither). 0 for an unchanged/304 poll and for every swallowed
   * failure below — not the size of the fetched/parsed set, which may be
   * larger than what was actually written (capped, or partially unchanged).
   */
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
 *
 * The same last-good guarantee also covers a parse that "succeeds" but yields
 * an empty or suspiciously-shrunk fresh set (a HARD parse failure surfaced via
 * `FlowParseResult.failed`, a 200-with-garbage body, a dormant feed resolving
 * zero URLs, or an event feed's row count collapsing relative to its last
 * successful cycle) — every one of these skips the swap instead of handing
 * `atomicSwap` an empty/shrunk set, since its delete-missing step would
 * otherwise delete every row absent from that set.
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
      const error = "site-table cold failure — no geometry map built";
      console.warn(`[ingest] ${src.id}: ${error} — skipping swap, preserving last-good rows`);
      await upsertSourceStatus(deps.sql, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
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
      const error = "station-registry cold failure — no geometry map built";
      console.warn(`[ingest] ${src.id}: ${error} — skipping swap, preserving last-good rows`);
      await upsertSourceStatus(deps.sql, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
  }

  let parsed: (Observation | UnresolvedRoadEvent)[];
  if (isStreamingFlowFeed(src)) {
    // Large DATEX flow feed: stream fetch → gunzip → SAX so the ~50 MB document
    // is never buffered or DOM-parsed (the memory-cap OOM this path replaces).
    try {
      parsed = await streamMeasuredData(src, streamFactoryFromFetch(fetchFn), siteMap, deps.now);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] stream failed for source ${src.id}:`, err);
      await upsertSourceStatus(deps.sql, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
  } else {
    let buffers: Buffer[];
    try {
      const result = await fetchAll(src, fetchFn);
      if (result.status === "unchanged") {
        // 304 on every URL, or gated by fetchIntervalSec — keep last-good rows,
        // no swap. Still a successful poll: advance last_success_at without
        // touching last_row_count, so an orphan sweep keyed off source_status
        // never treats this healthy source as gone.
        await upsertSourceStatus(deps.sql, src.id, {
          freshnessWindowSec: src.freshnessWindowSec,
          outcome: "success",
        });
        return { count: 0, durationMs: Date.now() - start };
      }
      buffers = result.buffers;
      if (buffers.length === 0) {
        // A dormant/uncredentialed feed (e.g. an expandEnv fan-out with zero
        // resolved URLs) resolves to `{status:"fetched", buffers:[]}` rather
        // than "unchanged" — treat it the same way: a successful no-op, not a
        // fresh (empty) set to swap in, which would otherwise wipe the
        // source's last-good rows every cycle it stays dormant.
        console.warn(
          `[ingest] ${src.id}: fetch resolved zero URLs — no-op, preserving last-good rows`
        );
        await upsertSourceStatus(deps.sql, src.id, {
          freshnessWindowSec: src.freshnessWindowSec,
          outcome: "success",
        });
        return { count: 0, durationMs: Date.now() - start };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] fetch failed for source ${src.id}:`, err);
      await upsertSourceStatus(deps.sql, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
    try {
      parsed = buffers.flatMap((b) => parseFor(src, b, siteMap));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] parse failed for source ${src.id}:`, err);
      await upsertSourceStatus(deps.sql, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
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

  // Derive a severity for events the feed left undeclared (uniform across every
  // feed at this one seam) so the map's severity ramp is meaningful for sources
  // that omit it, e.g. the German Mobilithek roadworks. No-op on declared
  // events and on flows.
  toWrite = enrichEventSeverity(toWrite);

  // Shrink tripwire: the diff-upsert swap's delete-missing step deletes every
  // row absent from `toWrite`, so an empty/suspiciously-shrunk fresh set is as
  // dangerous as a thrown parse error — it just doesn't look like one. Both
  // guards below skip the swap entirely (last-good rows survive) rather than
  // letting `atomicSwap` reconcile against a bad fresh set.
  if (src.produces === "flow") {
    // A sensor network never legitimately vanishes to zero — this also covers
    // a 200-with-garbage body (parses to []) and any parse path that yields an
    // empty set without throwing.
    if (toWrite.length === 0) {
      const error = `flow feed produced zero measurements this cycle — skipping swap to avoid wiping sensor data`;
      console.warn(`[ingest] ${src.id}: ${error}`);
      await upsertSourceStatus(deps.sql, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
  } else if (!src.allowMassClear) {
    const shrinkTripwireRatio = shrinkTripwireRatioFromEnv();
    const previousCount = await getLastRowCount(deps.sql, src.id);
    if (
      previousCount != null &&
      previousCount > 0 &&
      toWrite.length <= previousCount * shrinkTripwireRatio
    ) {
      const error =
        `event feed shrank from ${previousCount} to ${toWrite.length} rows ` +
        `(tripwire ratio ${shrinkTripwireRatio}) — skipping swap to avoid a suspected partial-failure wipe`;
      console.warn(`[ingest] ${src.id}: ${error}`);
      await upsertSourceStatus(deps.sql, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
  }

  // atomicSwap writes the success source_status row itself, inside the same
  // transaction as the swap (see its doc comment) — this is what closes the
  // race where a brand-new source's rows commit before its status row exists
  // and the 5-min orphan sweep, keyed off source_status, deletes them again.
  const swapCounts = await atomicSwap(deps.sql, src.id, toWrite, src.freshnessWindowSec);

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
  console.info(
    `[ingest] ${src.id}: swap inserted=${swapCounts.inserted} updated=${swapCounts.updated} ` +
      `deleted=${swapCounts.deleted} of ${toWrite.length} fresh rows in ${durationMs}ms${dropNote}`
  );
  return { count: swapCounts.inserted + swapCounts.updated, durationMs };
}
