import { Readable } from "node:stream";
import type postgres from "postgres";
import type { Observation } from "@openconditions/core";
import type { FeedSource, SiteGeometry, UnresolvedRoadEvent } from "@openconditions/roads";
import {
  drainSkippedNoGeometry,
  enrichEventSeverity,
  enrichFlowsWithBaseline,
  parseXmlDocument,
} from "@openconditions/roads";
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
import { bindObservations } from "./bind-observations.js";
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
   * Records the parser dropped this cycle because they carried no coordinate
   * geometry (DATEX Alert-C/TMC-only location references). Absent when nothing
   * was dropped. Surfaced per feed in `GET /feeds/status` so a source silently
   * losing its records to TMC-only encoding is visible rather than looking like
   * a healthy, quiet feed.
   */
  skippedNoGeometry?: number;
  /**
   * Set when the run swallowed a genuine failure (site-table cold failure,
   * streaming-flow error, or fetch error) rather than throwing. Absent for a
   * successful poll, including an unchanged (304/interval-gated) poll — that
   * is a successful no-op, not a failure. Callers that need "did this run
   * actually succeed" (e.g. the scheduler's status recording) must check
   * this field, not just whether the call threw.
   */
  error?: string;
  outcome?: import("./source-status.js").SourcePollOutcome;
  activeEvents?: number;
  inserted?: number;
  updated?: number;
  deleted?: number;
  rejected?: number;
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

const grantState = (value: boolean | null | undefined): "yes" | "no" | "unknown" =>
  value == null ? "unknown" : value ? "yes" : "no";

/** Stamps the concrete feed/child grant at the ingestion boundary so later
 * dedupe and projections never have to reconstruct child ownership by id. */
export function stampSourceEvidence<T extends Observation>(obs: T, src: DomainFeedSource): T {
  if (obs.origin.kind !== "feed") return obs;
  return {
    ...obs,
    origin: {
      ...obs.origin,
      attribution: {
        ...obs.origin.attribution,
        provider: src.attribution,
        license: src.license,
        url: src.licenseUrl ?? obs.origin.attribution?.url,
        parentSourceId: undefined,
        childSourceId: undefined,
        policyIds: src.policyIds,
        ...(src.parentSourceId
          ? {
              parentSourceId: src.parentSourceId,
              childSourceId: src.id,
              policyIds: src.policyIds ?? [src.parentSourceId, src.id],
            }
          : {}),
        rights: {
          source_redistribution: grantState(src.rights?.sourceRedistribution),
          derived_redistribution: grantState(src.rights?.derivedRedistribution),
          commercial_use: grantState(src.rights?.commercialUse),
          attribution_required: grantState(src.rights?.attributionRequired),
          retention: grantState(src.rights?.retention),
          evidence_origin: src.rights?.evidenceOrigin ?? null,
          evidence_version: src.rights?.evidenceVersion ?? null,
          reviewed_at: src.rights?.reviewedAt ?? null,
        },
      },
    },
  };
}

function valueAtPath(value: unknown, path: string): unknown {
  if (path === "$" || path === "") return value;
  let current = value;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function countXmlRecordElements(value: unknown, element: string): number {
  if (Array.isArray(value)) {
    return value.reduce((count, child) => count + countXmlRecordElements(child, element), 0);
  }
  if (value == null || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === element) count += Array.isArray(child) ? child.length : 1;
    else count += countXmlRecordElements(child, element);
  }
  return count;
}

function findXmlElements(value: unknown, element: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((child) => findXmlElements(child, element));
  if (value == null || typeof value !== "object") return [];
  const matches: unknown[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === element) matches.push(...(Array.isArray(child) ? child : [child]));
    matches.push(...findXmlElements(child, element));
  }
  return matches;
}

function xmlPublicationType(value: unknown): string | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)["@_type"];
  if (typeof raw !== "string") return undefined;
  return raw.slice(raw.lastIndexOf(":") + 1);
}

export function inspectSnapshotCompleteness(
  src: DomainFeedSource,
  buffers: Buffer[]
): { complete: boolean; inputRecords?: number; completeEmpty: boolean } {
  const contract = src.snapshot;
  if (!contract) return { complete: false, completeEmpty: false };
  if (contract.recordElement) {
    let inputRecords = 0;
    for (const buffer of buffers) {
      const document = parseXmlDocument(buffer, {
        removeNSPrefix: true,
        validate: true,
        isArray: () => false,
      });
      const roots = findXmlElements(document, contract.rootElement!);
      if (roots.length === 0) {
        throw new Error(`snapshot completeness: expected XML ${contract.rootElement} element`);
      }
      const publications = roots
        .flatMap((root) => findXmlElements(root, contract.publicationElement!))
        .filter((publication) => xmlPublicationType(publication) === contract.publicationType);
      if (publications.length === 0) {
        throw new Error(
          `snapshot completeness: expected ${contract.publicationType} ${contract.publicationElement}`
        );
      }
      for (const publication of publications) {
        inputRecords += countXmlRecordElements(publication, contract.recordElement);
      }
    }
    return { complete: true, inputRecords, completeEmpty: inputRecords === 0 };
  }
  if (!contract.recordsPath) return { complete: true, completeEmpty: buffers.length === 0 };

  let inputRecords = 0;
  let declaredTotal: number | undefined;
  for (const buffer of buffers) {
    let document: unknown;
    try {
      document = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new Error(
        `snapshot completeness: ${contract.recordsPath} cannot be read from invalid JSON`
      );
    }
    const records = valueAtPath(document, contract.recordsPath);
    if (!Array.isArray(records)) {
      throw new Error(`snapshot completeness: ${contract.recordsPath} must be an array`);
    }
    inputRecords += records.length;
    if (contract.totalCountPath) {
      const total = valueAtPath(document, contract.totalCountPath);
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
        throw new Error(
          `snapshot completeness: ${contract.totalCountPath} must be a non-negative integer`
        );
      }
      declaredTotal ??= total;
      if (declaredTotal !== total)
        throw new Error("snapshot completeness: inconsistent declared totals");
    }
  }
  if (declaredTotal != null && declaredTotal !== inputRecords) {
    throw new Error(
      `snapshot completeness: source declared ${declaredTotal} records but retrieved ${inputRecords}`
    );
  }
  return { complete: true, inputRecords, completeEmpty: inputRecords === 0 };
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
 * zero URLs, an event feed's row count collapsing relative to its last
 * successful cycle, or a tolerant fan-out whose failure ratio is at/above
 * `OPENCONDITIONS_FANOUT_FAIL_SKIP_RATIO`) — every one of these skips the
 * swap instead of handing `atomicSwap` an empty/shrunk/unreliable set, since
 * its delete-missing step would otherwise delete every row absent from that
 * set.
 */
export async function runSource(src: DomainFeedSource, deps: RunDeps): Promise<RunResult> {
  const start = Date.now();
  const attemptAt = deps.now();

  // Guard every egress path (feed, catalog, site-table, OAuth, mTLS) at one seam:
  // validate URL + DNS, re-check each redirect hop, cap size + time. Authorize on top.
  // The guard pins the socket to the validated IP via an undici dispatcher, which
  // only undici's fetch honors — so `deps.fetch` MUST be undici's fetch in
  // production (the scheduler passes it). Tests inject a fake fetch that serves
  // fixtures and ignores the dispatcher, keeping the run path hermetic.
  const guarded = guardedFetch(deps.fetch, guardOptionsFromEnv(), {}, deps.lookup);
  const fetchFn = makeAuthorizedFetch(src, guarded);

  // Discard whatever a PREVIOUS run left behind. Most failure paths below return
  // before the drain at the end, so without this reset a run that parsed and then
  // failed (shrink tripwire, fan-out threshold, swap error) would carry its count
  // into the next successful run and report the two summed — reading as a sudden
  // doubling of the loss rather than the same loss counted twice.
  drainSkippedNoGeometry(src.id);

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

  let acceptFetch: (() => void) | undefined;
  let parsed: (Observation | UnresolvedRoadEvent)[];
  let snapshotInspection: ReturnType<typeof inspectSnapshotCompleteness> | undefined;
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
      if (result.status === "not-modified") {
        await upsertSourceStatus(deps.sql, src.id, {
          freshnessWindowSec: src.freshnessWindowSec,
          outcome: "validated_unchanged",
          attemptAt,
          networkValidated: true,
          durationMs: Date.now() - start,
        });
        return { count: 0, durationMs: Date.now() - start, outcome: "validated_unchanged" };
      }
      if (result.status === "skipped" || result.status === "no-endpoint") {
        const outcome = result.status === "skipped" ? "skipped_cadence" : "missing_configuration";
        await upsertSourceStatus(deps.sql, src.id, {
          freshnessWindowSec: src.freshnessWindowSec,
          outcome,
          attemptAt,
          networkValidated: false,
          durationMs: Date.now() - start,
        });
        return { count: 0, durationMs: Date.now() - start, outcome };
      }
      if (result.status === "partial") {
        const { failed, total } = result.partitions;
        const error = `partial snapshot: ${failed}/${total} partitions failed — preserving last-good publication`;
        console.warn(`[ingest] ${src.id}: ${error}`);
        await upsertSourceStatus(deps.sql, src.id, {
          freshnessWindowSec: src.freshnessWindowSec,
          outcome: "partial",
          attemptAt,
          networkValidated: false,
          durationMs: Date.now() - start,
          partitions: result.partitions,
          error,
        });
        return { count: 0, durationMs: Date.now() - start, outcome: "partial", error };
      }
      acceptFetch = result.accept;
      buffers = result.buffers;
      snapshotInspection = inspectSnapshotCompleteness(src, buffers);
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
  const { resolved, dropped, failed } = await resolveOpenLr(parsed, deps.openlrClient ?? null);
  if (failed > 0 || ((snapshotInspection?.inputRecords ?? 0) > 0 && resolved.length === 0)) {
    const error =
      failed > 0
        ? `OpenLR resolution failed for ${failed} request(s)`
        : `structurally non-empty snapshot produced zero usable observations`;
    await upsertSourceStatus(deps.sql, src.id, {
      freshnessWindowSec: src.freshnessWindowSec,
      outcome: "failed",
      attemptAt,
      networkValidated: false,
      durationMs: Date.now() - start,
      error,
    });
    return { count: 0, durationMs: Date.now() - start, outcome: "failed", error };
  }

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
      const baselineMap = await loadBaselineMap(deps.sql, src.id);
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
  toWrite = enrichEventSeverity(toWrite).map((obs) => stampSourceEvidence(obs, src));

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
  } else if (!snapshotInspection?.completeEmpty) {
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
  const skippedNoGeometry = drainSkippedNoGeometry(src.id);
  const rejected = dropped + skippedNoGeometry;
  const preSwapDurationMs = Date.now() - start;
  let swapCounts;
  try {
    swapCounts = await atomicSwap(deps.sql, src.id, toWrite, src.freshnessWindowSec, undefined, {
      attemptAt,
      rejected,
      durationMs: preSwapDurationMs,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] publish failed for source ${src.id}:`, err);
    await upsertSourceStatus(deps.sql, src.id, {
      freshnessWindowSec: src.freshnessWindowSec,
      outcome: "failed",
      attemptAt,
      networkValidated: false,
      durationMs: Date.now() - start,
      error,
    });
    return { count: 0, durationMs: Date.now() - start, outcome: "failed", error };
  }

  acceptFetch?.();

  if (src.produces === "flow") {
    // Append this cycle's speeds to the rolling per-sensor history (the raw
    // material the nightly baseline derivation consumes). Best-effort: a history
    // write must never fail the live swap that already succeeded.
    try {
      const samples = await writeSpeedSamples(deps.sql, src.id, toWrite, deps.now, src.cadenceSec);
      if (samples.rejectedLate > 0) {
        console.warn(`[ingest] ${src.id}: rejected ${samples.rejectedLate} late speed samples`);
      }
    } catch (err) {
      console.warn(`[ingest] ${src.id}: speed-sample write failed:`, err);
    }
  }

  if (src.produces !== "flow" && swapCounts.changedIds.length > 0) {
    // Graph binding is derived and best-effort: it runs after the swap has
    // committed so a slow resolve never holds the advisory lock, and a
    // failure here never fails the poll.
    try {
      const bound = await bindObservations(deps.sql, swapCounts.changedIds, { now: deps.now });
      if (bound.attempted > 0 || bound.cleared > 0) {
        console.info(
          `[ingest] ${src.id}: bound ${bound.bound}/${bound.attempted} events ` +
            `(cleared ${bound.cleared}, write errors ${bound.writeErrors}) ` +
            JSON.stringify(bound.byStatus)
        );
      }
      if (bound.writeErrors > 0) {
        console.warn(
          `[ingest] ${src.id}: ${bound.writeErrors} binding writes failed; ` +
            `those events keep their previous binding until the next pass`
        );
      }
    } catch (err) {
      console.warn(`[ingest] ${src.id}: graph binding failed:`, err);
    }
  }

  const durationMs = Date.now() - start;
  // Records the parser dropped for want of a coordinate (DATEX Alert-C/TMC
  // only). Drained per run so the status page shows what this cycle lost, not
  // a total that keeps climbing after the cause is fixed.
  const dropNote = dropped > 0 ? ` (${dropped} dropped — no geometry)` : "";
  console.info(
    `[ingest] ${src.id}: swap inserted=${swapCounts.inserted} updated=${swapCounts.updated} ` +
      `deleted=${swapCounts.deleted} of ${toWrite.length} fresh rows in ${durationMs}ms${dropNote}`
  );
  return {
    count: swapCounts.inserted + swapCounts.updated,
    durationMs,
    outcome: toWrite.length === 0 ? "complete_empty" : "changed",
    activeEvents: toWrite.filter((row) => row.kind === "event").length,
    inserted: swapCounts.inserted,
    updated: swapCounts.updated,
    deleted: swapCounts.deleted,
    rejected,
    ...(skippedNoGeometry > 0 ? { skippedNoGeometry } : {}),
  };
}
