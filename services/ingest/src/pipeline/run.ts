import { Readable } from "node:stream";
import type { RawTier } from "@openconditions/core/server";
import type { LookupFn, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import {
  digestPayload,
  fetchAll,
  guardedFetch,
  guardOptionsFromEnv,
  makeAuthorizedFetch,
} from "@openconditions/ingest-framework";
import type { MapMatchClient } from "@openconditions/openlr";
import { createResolverClient } from "@openconditions/openlr";
import type { FeedSource, FlowContext, FlowOutput, FlowSites } from "@openconditions/roads";
import { drainSkippedNoGeometry, enrichReadings, parseXmlDocument } from "@openconditions/roads";
import type { WriteSummary } from "@openconditions/storage";
import type postgres from "postgres";
import type { RawArchive } from "../raw/archive.js";
import { archivingTee, digestOnlyTee } from "../raw/stream-tee.js";
import { rawTierFor } from "../raw/tiers.js";
import { loadBaselineMap } from "./baseline-store.js";
import { bindRecords } from "./bind-records.js";
import { isStreamingFlowFeed, streamMeasuredData } from "./measured-data.js";
import { parseEventFeed, parseFlowFeed } from "./parse.js";
import {
  changedSituations,
  logRejections,
  type PollIdentity,
  publishFlows,
  publishSituations,
  stampAttribution,
  type WriteModel,
  writeModel,
} from "./publish.js";
import { resolveOpenLr } from "./resolve.js";
import { tallyRestrictions } from "./restriction-tally.js";
import type { SiteTableStreamFactory } from "./site-table.js";
import { loadSiteTable } from "./site-table.js";
import {
  getLastRowCount,
  openPollAttempt,
  type SourceStatusUpdate,
  upsertSourceStatus,
} from "./source-status.js";
import { loadStationRegistry } from "./station-registry.js";

type Sql = postgres.Sql;

/**
 * Ratio (0-1) of an event feed's previous `source_status.last_row_count` that
 * its fresh count must exceed, or the write is skipped as a suspected
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
   * Records actually written this cycle: new, changed and restored situations
   * of an event feed; new, changed and restored sites and situations and new
   * readings of a flow feed (an unchanged one counts toward neither). 0 for an
   * unchanged/304 poll and for every swallowed failure below — not the size of
   * the parsed set.
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
  /**
   * Readings of a flow feed kept as history in an hour or day the rollup had
   * already closed: they never reach it. Absent when none.
   */
  pastRollup?: number;
  /**
   * Per-run source-record accounting for a complete-snapshot source. Bounded
   * counts only — never record ids as metric labels and never record bodies.
   * Counted from the reconciled selected versions, so a record served by two
   * partitions is counted once. The restriction counts are of the effects the
   * written situations carry: vehicle-specific rules and their issue codes.
   */
  snapshot?: {
    inputCount: number;
    uniqueCount: number;
    accepted: number;
    terminal: number;
    unlocatable: number;
    duplicates: number;
    restrictionFacts: number;
    restrictionIssues: Record<string, number>;
  };
}

export interface RunDeps {
  sql: Sql;
  fetch: typeof fetch;
  now: () => string;
  openlrClient?: MapMatchClient | null;
  /** Where the poll's raw payloads are archived; absent, none are kept. */
  raw?: RawArchive;
  /**
   * Overrides the DNS resolver `guardedFetch` uses to pin egress connections.
   * Left unset in production (the scheduler doesn't set it), so `guardedFetch`
   * falls back to its default real `node:dns` lookup — pinning behavior is
   * unchanged. Tests inject a fake here so a fake `fetch` used to serve
   * fixtures doesn't still require live DNS to resolve the feed host first.
   */
  lookup?: LookupFn;
  /** The registry records are sealed against and the instance id they are written as. */
  model?: Partial<WriteModel>;
}

/**
 * A FeedSource annotated with its domain name so the pipeline can dispatch
 * to the correct domain plugin without coupling FeedSource to ingest internals.
 */
export interface DomainFeedSource extends FeedSource {
  domain: string;
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
  buffers: Buffer[],
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
          `snapshot completeness: expected ${contract.publicationType} ${contract.publicationElement}`,
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
        `snapshot completeness: ${contract.recordsPath} cannot be read from invalid JSON`,
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
          `snapshot completeness: ${contract.totalCountPath} must be a non-negative integer`,
        );
      }
      declaredTotal ??= total;
      if (declaredTotal !== total)
        throw new Error("snapshot completeness: inconsistent declared totals");
    }
  }
  if (declaredTotal != null && declaredTotal !== inputRecords) {
    throw new Error(
      `snapshot completeness: source declared ${declaredTotal} records but retrieved ${inputRecords}`,
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
 *   2. Parse the payloads into situation drafts (and, for a flow feed,
 *      measurement sites and their readings).
 *   3. Resolve any OpenLR-only situations via the map-match service.
 *   4. Write the situations as one complete snapshot (a flow feed's sites and
 *      readings in the same transaction).
 *   5. Bind the situations that changed to the segment spine.
 *
 * Feed-downtime safety: if fetching throws, nothing is written and the
 * source's published records are left intact (last-good behavior). The error
 * is logged and the function returns {count:0, durationMs, error} so callers
 * can distinguish a swallowed failure from a genuinely successful (including
 * unchanged/304) poll.
 *
 * The same last-good guarantee also covers a parse that "succeeds" but yields
 * an empty or suspiciously-shrunk fresh set (a hard parse failure, a
 * 200-with-garbage body, a dormant feed resolving zero URLs, an event feed's
 * count collapsing relative to its last successful cycle, or a tolerant
 * fan-out whose failure ratio is at/above `OPENCONDITIONS_FANOUT_FAIL_SKIP_RATIO`)
 * — every one of these skips the write instead of handing a complete snapshot
 * an empty/shrunk/unreliable set, which would withdraw every record missing
 * from it.
 *
 * The poll's attempt row is opened before anything is fetched (its id is the
 * fetch id the poll's raw payloads are filed under). A poll that throws
 * closes it as an error on the way out, so no attempt stays `running`.
 */
export async function runSource(src: DomainFeedSource, deps: RunDeps): Promise<RunResult> {
  const attemptAt = deps.now();
  const attempt: PollAttempt = {
    id: await openPollAttempt(deps.sql, src.id, attemptAt),
    at: attemptAt,
    closed: false,
  };
  try {
    return await runAttempt(src, deps, attempt);
  } catch (err) {
    if (!attempt.closed) {
      await upsertSourceStatus(deps.sql, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        attemptAt,
        attemptId: attempt.id,
        error: err instanceof Error ? err.message : String(err),
      }).catch((closeErr) =>
        console.error(`[ingest] ${src.id}: could not close poll attempt ${attempt.id}`, closeErr),
      );
    }
    throw err;
  }
}

/** A poll's open attempt row, and whether a status update has closed it yet. */
interface PollAttempt {
  id: number;
  at: string;
  closed: boolean;
}

async function runAttempt(
  src: DomainFeedSource,
  deps: RunDeps,
  attempt: PollAttempt,
): Promise<RunResult> {
  const start = Date.now();
  const attemptAt = attempt.at;
  const attemptId = attempt.id;
  // What this attempt downloaded: set once the fetch returns, then carried on
  // every poll fact recorded after it (the raw-payload
  // identity an archived blob will be filed under).
  let payloadHashes: string[] | undefined;
  const recordStatus = async (update: SourceStatusUpdate) => {
    await upsertSourceStatus(deps.sql, src.id, {
      ...update,
      attemptId,
      ...(payloadHashes ? { payloadHashes } : {}),
    });
    attempt.closed = true;
  };
  const capture = (tier: RawTier | undefined) =>
    deps.raw !== undefined && tier !== undefined
      ? {
          archive: deps.raw,
          meta: { sourceId: src.id, fetchId: attemptId, fetchedAt: new Date(attemptAt), tier },
        }
      : undefined;
  const feedCapture = capture(rawTierFor(src, "feed"));
  const referenceCapture = capture(rawTierFor(src, "reference"));

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
  // failed (shrink tripwire, fan-out threshold, write error) would carry its count
  // into the next successful run and report the two summed — reading as a sudden
  // doubling of the loss rather than the same loss counted twice.
  drainSkippedNoGeometry(src.id);

  // Load the companion site table (cached, tolerant of failure) so flow feeds
  // that key measurements by site id can resolve geometry. Loaded before the feed
  // fetch so the streaming flow path has the join map ready.
  let sites: FlowSites | undefined;
  if (src.siteTable) {
    sites = await loadSiteTable(
      src,
      streamFactoryFromFetch(fetchFn),
      Date.now,
      referenceCapture
        ? archivingTee(referenceCapture.archive, referenceCapture.meta)
        : digestOnlyTee,
    );
    // A COLD site-table failure (no table ever loaded, not even stale) means
    // every measurement would lose its geometry and be skipped. Treat this like
    // a fetch failure: skip the write and preserve the last good publication.
    if (sites === undefined) {
      const error = "site-table cold failure — no geometry map built";
      console.warn(`[ingest] ${src.id}: ${error} — skipping the write, preserving last-good`);
      await recordStatus({
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
    sites = await loadStationRegistry(
      src,
      fetchFn,
      Date.now,
      referenceCapture
        ? (body, url) =>
            referenceCapture.archive.capture(
              { ...referenceCapture.meta, url },
              body,
              digestPayload(url, body),
            )
        : undefined,
    );
    if (sites === undefined) {
      const error = "station-registry cold failure — no geometry map built";
      console.warn(`[ingest] ${src.id}: ${error} — skipping the write, preserving last-good`);
      await recordStatus({
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
  }

  // A flow reading the source does not date is dated by the poll, floored to the cadence.
  const flowContext: FlowContext = { now: attemptAt, cadenceSec: src.cadenceSec };
  let acceptFetch: (() => void) | undefined;
  let flowParse: FlowOutput | undefined;
  let eventParse: ParseOutput | undefined;
  let snapshotInspection: ReturnType<typeof inspectSnapshotCompleteness> | undefined;
  if (isStreamingFlowFeed(src)) {
    // Large DATEX flow feed: stream fetch → gunzip → SAX so the ~50 MB document
    // is never buffered or DOM-parsed (the memory-cap OOM this path replaces).
    try {
      const { payload, ...streamed } = await streamMeasuredData(
        src,
        streamFactoryFromFetch(fetchFn),
        sites,
        flowContext,
        feedCapture ? archivingTee(feedCapture.archive, feedCapture.meta) : digestOnlyTee,
      );
      flowParse = streamed;
      payloadHashes = [payload.sha256];
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] stream failed for source ${src.id}:`, err);
      await recordStatus({
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
      if (result.status === "fetched" || result.status === "partial") {
        payloadHashes = result.payloads.map((payload) => payload.sha256);
        if (feedCapture) {
          for (const [i, payload] of result.payloads.entries()) {
            await feedCapture.archive.capture(
              { ...feedCapture.meta, url: payload.url },
              result.buffers[i]!,
              payload,
            );
          }
        }
      }
      if (result.status === "not-modified") {
        await recordStatus({
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
        await recordStatus({
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
        await recordStatus({
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
      await recordStatus({
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
    try {
      // A complete-snapshot source is read through its format's reporting
      // path, which reconciles partitions by source identity and refuses a
      // candidate it cannot fully account for.
      if (src.produces === "flow") flowParse = parseFlowFeed(src, buffers, sites, flowContext);
      else eventParse = parseEventFeed(src, buffers, { fetchedAt: attemptAt });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] parse failed for source ${src.id}:`, err);
      await recordStatus({
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: "error",
        error,
      });
      return { count: 0, durationMs: Date.now() - start, error };
    }
  }

  const poll: PollContext = {
    src,
    deps,
    attempt,
    start,
    recordStatus,
    identity: { at: attemptAt, id: attemptId, ...(payloadHashes ? { payloadHashes } : {}) },
    ...(acceptFetch ? { acceptFetch } : {}),
  };
  return flowParse !== undefined
    ? finishFlowPoll(poll, flowParse)
    : finishEventPoll(poll, eventParse!, snapshotInspection);
}

/** What the poll's last stages share once its payloads are parsed. */
interface PollContext {
  src: DomainFeedSource;
  deps: RunDeps;
  attempt: PollAttempt;
  start: number;
  recordStatus: (update: SourceStatusUpdate) => Promise<void>;
  identity: PollIdentity;
  acceptFetch?: () => void;
}

/** Records a failure that keeps the last good publication, and the run's result for it. */
async function fail(
  poll: PollContext,
  outcome: "failed" | "error",
  error: string,
): Promise<RunResult> {
  await poll.recordStatus({
    freshnessWindowSec: poll.src.freshnessWindowSec,
    outcome,
    attemptAt: poll.identity.at,
    networkValidated: false,
    durationMs: Date.now() - poll.start,
    error,
  });
  return {
    count: 0,
    durationMs: Date.now() - poll.start,
    ...(outcome === "failed" ? { outcome } : {}),
    error,
  };
}

/**
 * Binds the situations a poll changed. Graph binding is derived and
 * best-effort: it runs after the publication committed so a slow resolve never
 * holds the source's lock, and a failure here never fails the poll — the
 * work stays queued and the scheduler drains it.
 */
async function bindChanged(poll: PollContext, summary: WriteSummary): Promise<void> {
  const ids = changedSituations(summary);
  if (ids.length === 0) return;
  try {
    const bound = await bindRecords(poll.deps.sql, ids, { now: poll.deps.now });
    if (bound.attempted > 0 || bound.cleared > 0) {
      console.info(
        `[ingest] ${poll.src.id}: bound ${bound.bound}/${bound.attempted} situations ` +
          `(cleared ${bound.cleared}, write errors ${bound.writeErrors}) ` +
          JSON.stringify(bound.byStatus),
      );
    }
  } catch (err) {
    console.warn(`[ingest] ${poll.src.id}: graph binding failed:`, err);
  }
}

/**
 * The last stages of an event feed's poll: place OpenLR-only situations,
 * refuse a result the tripwires call suspect, stamp the catalogue's rights,
 * publish the complete snapshot, bind what changed.
 */
async function finishEventPoll(
  poll: PollContext,
  parse: ParseOutput,
  inspection: ReturnType<typeof inspectSnapshotCompleteness> | undefined,
): Promise<RunResult> {
  const { src, deps } = poll;
  const { resolved, dropped, failed, unlocatable } = await resolveOpenLr(
    parse.situations,
    deps.openlrClient ?? null,
  );
  const accounting = parse.records;
  // A situation the resolver could not place is unlocatable only when the
  // resolver itself did not fail: a transport/validation failure means we do
  // not know where it is, which is a whole-source failure, not a disposition.
  const unlocatableSituations =
    accounting === undefined
      ? undefined
      : [...new Set([...accounting.unlocatableSituations, ...(failed > 0 ? [] : unlocatable)])];
  // For an accounted snapshot the record accounting — not the raw input count —
  // decides whether an empty result is real: a snapshot of only terminal or
  // unplaceable records legitimately publishes no situations.
  const zeroResult =
    accounting === undefined
      ? (inspection?.inputRecords ?? 0) > 0 && resolved.length === 0
      : accounting.accepted > 0 && resolved.length === 0 && unlocatable.length === 0;
  if (failed > 0) return fail(poll, "failed", `OpenLR resolution failed for ${failed} request(s)`);
  if (zeroResult) {
    return fail(poll, "failed", "structurally non-empty snapshot produced zero usable situations");
  }
  const situations = resolved.map((draft) => stampAttribution(draft, src));

  // Shrink tripwire: a complete snapshot withdraws every situation it does not
  // hold, so a suspiciously shrunk fresh set is as dangerous as a parse error.
  // An accounted snapshot needs no ratio heuristic: every input record has an
  // explicit disposition, and the unlocatable check inside the publication
  // transaction protects a still-published record.
  if (accounting === undefined && !inspection?.completeEmpty) {
    const ratio = shrinkTripwireRatioFromEnv();
    const previous = await getLastRowCount(deps.sql, src.id);
    if (previous != null && previous > 0 && situations.length <= previous * ratio) {
      const error =
        `event feed shrank from ${previous} to ${situations.length} situations ` +
        `(tripwire ratio ${ratio}) — skipping the write to avoid a suspected partial-failure wipe`;
      console.warn(`[ingest] ${src.id}: ${error}`);
      return fail(poll, "error", error);
    }
  }

  const skippedNoGeometry = drainSkippedNoGeometry(src.id);
  const rejected = dropped + skippedNoGeometry;
  let summary: WriteSummary;
  try {
    summary = await publishSituations(deps.sql, src, {
      situations,
      ...(unlocatableSituations
        ? {
            unlocatable: unlocatableSituations,
            unlocatableRecords: accounting?.unlocatableRecords ?? [],
          }
        : {}),
      rejected,
      poll: poll.identity,
      durationMs: Date.now() - poll.start,
      now: deps.now(),
      model: writeModel(deps.model),
    });
    // The publication's transaction closed the attempt with the poll's success.
    poll.attempt.closed = true;
  } catch (err) {
    console.error(`[ingest] publish failed for source ${src.id}:`, err);
    return fail(poll, "failed", err instanceof Error ? err.message : String(err));
  }
  logRejections(src.id, summary);
  poll.acceptFetch?.();
  await bindChanged(poll, summary);

  const c = summary.counts.situation;
  const durationMs = Date.now() - poll.start;
  // Records the parser dropped for want of a coordinate, drained per run so the
  // status page shows what this cycle lost.
  const dropNote = dropped > 0 ? ` (${dropped} dropped — no geometry)` : "";
  console.info(
    `[ingest] ${src.id}: situations created=${c.created} updated=${c.updated} ` +
      `restored=${c.restored} withdrawn=${c.withdrawn} unchanged=${c.unchanged} ` +
      `of ${situations.length} in ${durationMs}ms${dropNote}`,
  );
  return {
    count: c.created + c.updated + c.restored,
    durationMs,
    outcome: situations.length === 0 ? "complete_empty" : "changed",
    activeEvents: situations.length - summary.rejected.length,
    inserted: c.created + c.restored,
    updated: c.updated,
    deleted: c.withdrawn,
    rejected: rejected + summary.rejected.length,
    ...(skippedNoGeometry > 0 ? { skippedNoGeometry } : {}),
    ...(accounting !== undefined
      ? {
          snapshot: snapshotCounts(accounting, failed > 0 ? [] : unlocatable, situations),
        }
      : {}),
  };
}

/**
 * The last stages of a flow feed's poll: apply the stored free-flow
 * baselines, stamp the catalogue's rights, write the measurement sites, their
 * readings and the derived congestion situations in one transaction with the
 * poll's status, then bind what changed.
 */
async function finishFlowPoll(poll: PollContext, parse: FlowOutput): Promise<RunResult> {
  const { src, deps } = poll;
  let output = parse;
  // Best-effort: a baseline-load failure must never throw away a good fetch —
  // fall back to the unenriched readings rather than reverting the feed. The
  // poll then cannot tell a cleared queue from an unknown one, so it keeps the
  // congestion it derived last instead of withdrawing it.
  let baselinesLoaded = true;
  try {
    const baselines = await loadBaselineMap(deps.sql, src.id);
    if (baselines.size > 0) output = enrichReadings(src, output, baselines);
  } catch (err) {
    baselinesLoaded = false;
    console.warn(`[ingest] ${src.id}: baseline-map load failed, skipping enrichment:`, err);
  }
  // A sensor network never legitimately vanishes to zero — this also covers a
  // 200-with-garbage body (parses to nothing) and any parse path that yields an
  // empty set without throwing.
  if (output.observations.length === 0) {
    const error = `flow feed produced zero measurements this cycle — skipping the write to keep the last good publication`;
    console.warn(`[ingest] ${src.id}: ${error}`);
    return fail(poll, "error", error);
  }
  const stamp = (drafts: readonly RecordDraft[]) => drafts.map((d) => stampAttribution(d, src));
  const stamped: FlowOutput = {
    features: stamp(output.features),
    observations: stamp(output.observations),
    situations: stamp(output.situations),
  };
  const skippedNoGeometry = drainSkippedNoGeometry(src.id);
  let published: Awaited<ReturnType<typeof publishFlows>>;
  try {
    published = await publishFlows(deps.sql, src, {
      output: stamped,
      situationsComplete: baselinesLoaded,
      rejected: skippedNoGeometry,
      poll: poll.identity,
      durationMs: Date.now() - poll.start,
      now: deps.now(),
      model: writeModel(deps.model),
    });
    poll.attempt.closed = true;
  } catch (err) {
    console.error(`[ingest] publish failed for source ${src.id}:`, err);
    return fail(poll, "failed", err instanceof Error ? err.message : String(err));
  }
  const { summary, counts } = published;
  logRejections(src.id, summary);
  poll.acceptFetch?.();
  await bindChanged(poll, summary);

  const { pastRollup } = summary.observations;
  if (pastRollup > 0) {
    console.warn(`[ingest] ${src.id}: ${pastRollup} reading(s) arrived after their rollup closed`);
  }
  const durationMs = Date.now() - poll.start;
  const o = summary.observations;
  console.info(
    `[ingest] ${src.id}: ${stamped.features.length} sites, ${stamped.observations.length} readings ` +
      `(latest ${o.latest}, history ${o.history}, unchanged ${o.unchanged}), ` +
      `${counts.activeEvents} congestion situations in ${durationMs}ms`,
  );
  return {
    count: counts.inserted + counts.updated,
    durationMs,
    outcome: "changed",
    activeEvents: counts.activeEvents,
    inserted: counts.inserted,
    updated: counts.updated,
    deleted: counts.deleted,
    rejected: counts.rejected,
    ...(skippedNoGeometry > 0 ? { skippedNoGeometry } : {}),
    ...(pastRollup > 0 ? { pastRollup } : {}),
  };
}

/** Bounded per-run counts for a complete-snapshot source. */
function snapshotCounts(
  accounting: NonNullable<ParseOutput["records"]>,
  unplacedSituations: readonly string[],
  written: readonly RecordDraft[],
): NonNullable<RunResult["snapshot"]> {
  const restrictions = tallyRestrictions(written);
  // The resolver drops situations; the accounting counts records.
  const unplaced = unplacedSituations.reduce(
    (sum, id) => sum + (accounting.situationRecords[id] ?? 1),
    0,
  );
  return {
    inputCount: accounting.inputCount,
    uniqueCount: accounting.uniqueCount,
    accepted: Math.max(0, accounting.accepted - unplaced),
    terminal: accounting.terminal,
    unlocatable: accounting.unlocatable + unplaced,
    duplicates: accounting.duplicates,
    restrictionFacts: restrictions.effects,
    restrictionIssues: restrictions.issues,
  };
}
