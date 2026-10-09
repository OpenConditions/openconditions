import type { RawTier } from "@openconditions/core/server";
import { parseXmlDocument } from "@openconditions/datex2";
import type {
  CatalogFeed,
  Env,
  FeedPayloads,
  HeldPayload,
  ImpersonationOptions,
  KeptItems,
  LookupFn,
  ParseOutput,
  RecordDraft,
  StatusIndex,
  StatusOutput,
} from "@openconditions/ingest-framework";
import {
  dueRoles,
  feedSecretValues,
  fetchEndpoint,
  guardedFetch,
  guardOptionsFromEnv,
  heldBuffer,
  heldBuffers,
  heldBytes,
  holdPayload,
  makeAuthorizedFetch,
  redactSecrets,
  redactUrl,
} from "@openconditions/ingest-framework";
import type { MapMatchClient } from "@openconditions/openlr";
import { createResolverClient } from "@openconditions/openlr";
import type { FlowOutput } from "@openconditions/roads";
import { drainSkippedNoGeometry, enrichReadings } from "@openconditions/roads";
import type { WriteSummary } from "@openconditions/storage";
import type postgres from "postgres";
import { domainOf, formatOf } from "../domains.js";
import type { RawArchive } from "../raw/archive.js";
import { archivingTee, digestOnlyTee, type StreamTeeFactory } from "../raw/stream-tee.js";
import { rawTierFor } from "../raw/tiers.js";
import { loadBaselineMap } from "./baseline-store.js";
import { bindRecords } from "./bind-records.js";
import { bodyStreamFrom } from "./body-stream.js";
import { streamFeed } from "./measured-data.js";
import { type ParseGate, payloadBytes } from "./parse-gate.js";
import {
  changedSituations,
  logRejections,
  type PollIdentity,
  publishFeatures,
  publishFlows,
  publishReadings,
  publishSituations,
  stampAttribution,
  type WriteModel,
  writeModel,
} from "./publish.js";
import { loadReference } from "./reference.js";
import { resolveOpenLr } from "./resolve.js";
import { tallyRestrictions } from "./restriction-tally.js";
import {
  getLastRowCount,
  openPollAttempt,
  type SourcePollOutcome,
  type SourceStatusUpdate,
  upsertSourceStatus,
} from "./source-status.js";

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

/**
 * The shrink tripwire: the previous count and the ratio when a fresh count of
 * a complete snapshot does not exceed that share of the source's last
 * published row count, else undefined.
 */
async function shrinkTripped(
  sql: Sql,
  sourceId: string,
  fresh: number,
): Promise<{ previous: number; ratio: number } | undefined> {
  const ratio = shrinkTripwireRatioFromEnv();
  const previous = await getLastRowCount(sql, sourceId);
  return previous != null && previous > 0 && fresh <= previous * ratio
    ? { previous, ratio }
    : undefined;
}

/** Fails a poll the shrink tripwire stopped, keeping the last good publication. */
function failShrunk(
  poll: PollContext,
  what: string,
  unit: string,
  fresh: number,
  { previous, ratio }: { previous: number; ratio: number },
): Promise<RunResult> {
  const error =
    `${what} feed shrank from ${previous} to ${fresh} ${unit} ` +
    `(tripwire ratio ${ratio}) — skipping the write to avoid a suspected partial-failure wipe`;
  console.warn(`[ingest] ${poll.src.id}: ${error}`);
  return fail(poll, "error", error);
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
  /**
   * Set when no endpoint was due, so nothing was fetched and no attempt opened:
   * not a poll, and not to be recorded as one.
   */
  notDue?: true;
  outcome?: SourcePollOutcome;
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
  /** Replaces the impersonating client of an `impersonate` endpoint; tests only. */
  impersonation?: ImpersonationOptions;
  /** The registry records are sealed against and the instance id they are written as. */
  model?: Partial<WriteModel>;
  /** Where credentials are read; defaults to `process.env`. */
  env?: Env;
  /**
   * What the feed's earlier polls fetched, which the scheduler keeps per feed:
   * with it, a poll fetches only the data roles whose cadence is due and
   * parses the others' latest payloads; without it, every data role is due.
   */
  roles?: RoleState;
  /**
   * Shared by the scheduler's feeds, so a large payload is parsed and written
   * while no other large one is; without it, polls never wait for each other.
   */
  parseGate?: ParseGate;
}

/**
 * A feed's data roles across polls: when each was last fetched, its latest
 * payloads and, for a format that reads live states alone, where they
 * belong. Nothing a parse produced is kept besides that index.
 */
export interface RoleState {
  /** Epoch ms of each role's last fetch. */
  lastFetchedAt: Record<string, number>;
  /**
   * Each role's latest payloads, kept only for a feed with more than one data
   * role, whose roles fall due apart: a single-role poll holds them all. A
   * large one is kept gzipped and read back only when a poll parses it.
   */
  payloads: Record<string, readonly HeldPayload[]>;
  /**
   * The URL each held payload came from, same order: where a role that walks
   * another's listings resolves their links.
   */
  urls: Record<string, readonly string[]>;
  /**
   * A per-item role's items kept between polls, by URL: items not asked
   * again while kept, and walked listings and files not asked again while
   * their version stands. Replaced at each fetch by the items it named.
   */
  items: Record<string, KeptItems>;
  /** The roles whose last fetch failed and fell back to a held payload, so an outage warns once. */
  failing: Record<string, true>;
  /**
   * Each URL's latest answer of a tolerant `urls` role, by role and URL, and
   * when it came: the stand-in for that URL while it fails.
   */
  answers: Record<string, Record<string, { at: number; body: HeldPayload }>>;
  /**
   * The status index of the last full parse that published, for a feed with
   * a live status role: a poll that fetches only live states reads them
   * through it, without the snapshot.
   */
  statusIndex?: StatusIndex;
}

export function createRoleState(): RoleState {
  return { lastFetchedAt: {}, payloads: {}, urls: {}, items: {}, failing: {}, answers: {} };
}

/**
 * The fetch every egress of a feed goes through: guarded at one seam
 * (validate URL and DNS, re-check each redirect hop, cap size and time) and
 * authorized with the feed's credentials on top. The guard pins the socket to
 * the validated IP via an undici dispatcher, which only undici's fetch
 * honours, so `deps.fetch` must be undici's fetch in production. Tests inject
 * a fake fetch that serves fixtures and ignores the dispatcher.
 */
export function feedFetch(
  src: CatalogFeed,
  deps: { fetch: typeof fetch; lookup?: LookupFn; env?: Env },
): typeof fetch {
  return makeAuthorizedFetch(src, guardedFeedFetch(deps), deps.env ?? process.env);
}

/**
 * The guarded fetch without any credential. `fetchEndpoint` takes this one and
 * authorizes it itself, so a followed URL never receives the feed's
 * authorization.
 */
export function guardedFeedFetch(deps: { fetch: typeof fetch; lookup?: LookupFn }): typeof fetch {
  return guardedFetch(deps.fetch, guardOptionsFromEnv(), {}, deps.lookup);
}

/** The data endpoints of a feed: those its format parses itself, not reference data. */
export function dataRoles(src: CatalogFeed): string[] {
  return Object.entries(src.endpoints)
    .filter(([, endpoint]) => endpoint.decoder === undefined)
    .map(([role]) => role);
}

/**
 * The seconds between a feed's scheduler ticks: its cadence, at most an hour.
 * Cron steps cannot span more than an hour of minutes, so a feed slower than
 * that ticks hourly and polls on the tick its cadence ends.
 */
export function pollTickSec(cadenceSec: number): number {
  return Math.min(cadenceSec, 3600);
}

/**
 * The data roles due this poll. A cron tick fires a little after its slot, so
 * a role counts as due half a tick early: the roles on the feed's own cadence
 * are due every tick, and a slower role on the tick its cadence ends.
 */
function rolesDue(src: CatalogFeed, roles: RoleState | undefined, now: number): string[] {
  if (!roles) return dataRoles(src);
  return dueRoles(src, roles.lastFetchedAt, now + pollTickSec(src.cadenceSec) * 500);
}

/**
 * The due roles in fetch order: a role another role reads its ids from
 * (`each`) comes first, so the same poll's payload is the one they use; then
 * the plain roles; the per-item roles last. A per-item sweep can take minutes
 * (one request per id under the feed's rate limit), and the poll is read as
 * of its start, so a role fetched after the sweep would carry states newer
 * than the time they are dated to. The order within each group is the feed's
 * own.
 */
function fetchOrder(src: CatalogFeed, due: readonly string[]): string[] {
  const sources = new Set(
    Object.values(src.endpoints).flatMap((endpoint) => (endpoint.each ? [endpoint.each.role] : [])),
  );
  const perItem = (role: string) => src.endpoints[role]?.each !== undefined;
  return [
    ...due.filter((role) => sources.has(role)),
    ...due.filter((role) => !sources.has(role) && !perItem(role)),
    ...due.filter((role) => !sources.has(role) && perItem(role)),
  ];
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
  src: Pick<CatalogFeed, "snapshot">,
  buffers: readonly Buffer[],
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
 *   1. Load its reference data (site table, station registry) on the
 *      reference endpoints' own cadence.
 *   2. Fetch every data endpoint that is due (gunzip transparently), or
 *      stream the main endpoint when the format reads it as a stream.
 *   3. Parse the latest payloads of every data endpoint through the feed's
 *      format into record drafts.
 *   4. Resolve any OpenLR-only situations via the map-match service.
 *   5. Write the drafts as one complete snapshot: a situations format's
 *      situations, or a measurements format's sites, readings and derived
 *      situations in one transaction.
 *   6. Bind the situations that changed to the segment spine.
 *
 * A poll on which no data endpoint is due (the scheduler's role state says
 * each was fetched within its cadence) does nothing, opens no attempt and
 * returns `notDue`.
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
export async function runSource(src: CatalogFeed, deps: RunDeps): Promise<RunResult> {
  const attemptAt = deps.now();
  const due = rolesDue(src, deps.roles, Date.parse(attemptAt));
  if (due.length === 0) return { count: 0, durationMs: 0, notDue: true };
  const attempt: PollAttempt = {
    id: await openPollAttempt(deps.sql, src.id, attemptAt),
    at: attemptAt,
    closed: false,
  };
  try {
    return await runAttempt(src, deps, attempt, due);
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
  src: CatalogFeed,
  deps: RunDeps,
  attempt: PollAttempt,
  due: readonly string[],
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

  // Every egress path (feed, catalog, site-table, OAuth, mTLS) goes through
  // one guarded, authorized fetch; the scheduler passes undici's fetch.
  const env = deps.env ?? process.env;
  const fetchFn = feedFetch(src, { ...deps, env });
  const format = formatOf(src);
  const teeFor = (c: ReturnType<typeof capture>): StreamTeeFactory =>
    c ? archivingTee(c.archive, c.meta) : digestOnlyTee;

  // Discard whatever a PREVIOUS run left behind. Most failure paths below return
  // before the drain at the end, so without this reset a run that parsed and then
  // failed (shrink tripwire, fan-out threshold, write error) would carry its count
  // into the next successful run and report the two summed — reading as a sudden
  // doubling of the loss rather than the same loss counted twice.
  drainSkippedNoGeometry(src.id);

  // Load the reference data (a site table, a station registry) before the feed
  // fetch, so the streaming path has its join map ready. Each loads on its
  // endpoint's own cadence, through the same guarded fetch as the feed.
  const reference: Record<string, unknown> = {};
  for (const [role, endpoint] of Object.entries(src.endpoints)) {
    if (endpoint.decoder === undefined) continue;
    const data = await loadReference(src, role, fetchFn, Date.now, teeFor(referenceCapture), env);
    if (data !== undefined) {
      reference[role] = data;
      continue;
    }
    // A COLD failure of reference data the feed declares (none ever loaded,
    // not even stale) means its readings would lose their geometry, whether or
    // not the format requires the table. Treat it like a fetch failure: skip
    // the write and preserve the last good publication.
    const error = `${role} (${endpoint.decoder}) cold failure — no geometry map built`;
    console.warn(`[ingest] ${src.id}: ${error} — skipping the write, preserving last-good`);
    await recordStatus({ freshnessWindowSec: src.freshnessWindowSec, outcome: "error", error });
    return { count: 0, durationMs: Date.now() - start, error };
  }

  const ctx = { fetchedAt: attemptAt, cadenceSec: src.cadenceSec, reference };
  let acceptFetch: (() => void) | undefined;
  let snapshotInspection: ReturnType<typeof inspectSnapshotCompleteness> | undefined;
  // Whether any data payload had bytes: a streamed body is taken to have.
  let heldPayload = true;
  let warning: string | undefined;
  // An optional role that never answered was left out: its states are not in the parse.
  let leftOut = false;
  const pollContext = (): PollContext => ({
    src,
    deps,
    attempt,
    start,
    recordStatus,
    identity: { at: attemptAt, id: attemptId, ...(payloadHashes ? { payloadHashes } : {}) },
    ...(acceptFetch ? { acceptFetch } : {}),
    ...(warning ? { warning } : {}),
    statesComplete: !leftOut,
  });
  const finish = (parse: ParseOutput): Promise<RunResult> => {
    const poll = pollContext();
    if (format.kind === "features") return finishFeaturePoll(poll, parse, heldPayload);
    return format.kind === "measurements"
      ? finishFlowPoll(poll, {
          features: parse.features,
          observations: parse.observations,
          situations: parse.situations,
        })
      : finishEventPoll(poll, parse, snapshotInspection);
  };
  if (format.stream) {
    // A payload too large to buffer (NDW's ~50 MB DATEX flow document): stream
    // fetch → gunzip → SAX, so it is never buffered or DOM-parsed whole. An
    // HTTP error names the URL with the feed's secrets scrubbed, path included.
    const secrets = feedSecretValues(src, env);
    const redact = (s: string) => redactSecrets(redactUrl(s), secrets);
    let parsed: ParseOutput;
    try {
      const streamed = await streamFeed(
        src,
        format.stream,
        bodyStreamFrom(fetchFn, redact),
        ctx,
        teeFor(feedCapture),
        env,
      );
      payloadHashes = [streamed.payload.sha256];
      if (deps.roles) deps.roles.lastFetchedAt["main"] = Date.parse(attemptAt);
      parsed = streamed.output;
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
    return finish(parsed);
  } else {
    // Every due data role is fetched; a role not due this poll (or answering
    // 304) contributes the payloads of its latest fetch.
    const fresh: Record<string, readonly Buffer[]> = {};
    /** The URL of each fresh payload, same order. */
    const freshUrls: Record<string, readonly string[]> = {};
    const accepts: (() => void)[] = [];
    const keepPayloads = deps.roles !== undefined && dataRoles(src).length > 1;
    /** The data roles whose payloads changed this poll. */
    let fetched: string[] = [];
    // A due role that failed while its latest payload is held: the poll goes on
    // with that payload, and the role stays due for the next tick.
    const warnings: string[] = [];
    /** Due roles the network answered (fetched or not modified). */
    let answered = 0;
    const polledAt = Date.parse(attemptAt);
    // A payload older than its endpoint allows is not held at all: the role
    // that needs it to stand in has failed with nothing to show.
    const outlived = (role: string) => {
      const maxAge = src.endpoints[role]?.maxPayloadAgeSec;
      if (maxAge === undefined) return false;
      const fetchedAt = deps.roles?.lastFetchedAt[role];
      return fetchedAt === undefined || polledAt - fetchedAt > maxAge * 1000;
    };
    const holdsPayload = (role: string) => {
      if (!keepPayloads || deps.roles!.payloads[role] === undefined) return false;
      if (!outlived(role)) return true;
      delete deps.roles!.payloads[role];
      delete deps.roles!.urls[role];
      return false;
    };
    /**
     * A tolerant `urls` role is a union of independent answers (one country's
     * warnings each): every URL's latest answer is held, and one that fails is
     * stood in for by its held answer while that is no older than the
     * endpoint allows. Past that the URL contributes nothing, its records
     * leave, and the others still publish as a complete set. Returns the
     * role's payloads with the stand-ins, or undefined for any other role.
     */
    const withHeldAnswers = async (
      role: string,
      buffers: readonly Buffer[],
      urls: readonly string[],
      failedUrls: readonly string[],
    ): Promise<{ buffers: Buffer[]; urls: string[] } | undefined> => {
      const endpoint = src.endpoints[role];
      if (
        deps.roles === undefined ||
        endpoint?.fanout !== "tolerant" ||
        endpoint.urls === undefined ||
        endpoint.each !== undefined
      ) {
        return undefined;
      }
      const answers = deps.roles.answers[role] ?? {};
      deps.roles.answers[role] = answers;
      // A URL no longer asked (yesterday's date in it) leaves with its answer.
      const asked = new Set([...urls, ...failedUrls]);
      for (const url of Object.keys(answers)) if (!asked.has(url)) delete answers[url];
      for (const [i, url] of urls.entries()) {
        answers[url] = { at: polledAt, body: await holdPayload(buffers[i]!) };
      }
      const maxAge = endpoint.maxPayloadAgeSec;
      const out = { buffers: [...buffers], urls: [...urls] };
      let gone = 0;
      for (const url of failedUrls) {
        const held = answers[url];
        if (held !== undefined && (maxAge === undefined || polledAt - held.at <= maxAge * 1000)) {
          out.buffers.push(await heldBuffer(held.body));
          out.urls.push(url);
        } else {
          delete answers[url];
          gone++;
        }
      }
      if (failedUrls.length > 0) {
        const note = `${failedUrls.length}/${asked.size} URLs failed, ${failedUrls.length - gone} held answers stood in, ${gone} left out`;
        warnings.push(`${role}: ${note}`);
        console.warn(`[ingest] ${src.id}: ${role}: ${note}`, { feed: src.id, role });
      }
      return out;
    };
    const fallBack = (role: string, reason: string) => {
      warnings.push(`${role}: ${reason} (held payload used)`);
      if (!deps.roles!.failing[role]) {
        deps.roles!.failing[role] = true;
        console.warn(`[ingest] ${src.id}: ${role} failed, using its held payload: ${reason}`, {
          feed: src.id,
          role,
        });
      }
    };
    // The roles whose fetch failed: a role of changes failing past its
    // window has missed some, and its snapshot falls due again.
    const failed: string[] = [];
    const gap = (role: string) => failed.push(role);
    /** The roles the network answered this poll, fetched or not modified. */
    const renewed = new Set<string>();
    try {
      for (const role of fetchOrder(src, due)) {
        let result: Awaited<ReturnType<typeof fetchEndpoint>>;
        try {
          // A per-item role reads the ids of its source role: this poll's
          // payload when the source was fetched, else the source's held one;
          // with neither, fetchEndpoint fails the role.
          const eachRole = src.endpoints[role]?.each?.role;
          const heldSource = eachRole === undefined ? undefined : deps.roles?.payloads[eachRole];
          const eachSource =
            eachRole === undefined
              ? undefined
              : (fresh[eachRole] ?? (heldSource ? await heldBuffers(heldSource) : undefined));
          const eachSourceUrls =
            eachRole === undefined
              ? undefined
              : fresh[eachRole] !== undefined
                ? freshUrls[eachRole]
                : deps.roles?.urls[eachRole];
          const kept = deps.roles?.items[role];
          result = await fetchEndpoint(src, role, guardedFeedFetch(deps), {
            resolvers: domainOf(src).resolvers,
            env,
            at: polledAt,
            ...(eachSource ? { eachSource } : {}),
            ...(eachSourceUrls ? { eachSourceUrls } : {}),
            ...(kept ? { kept } : {}),
            ...(deps.impersonation ? { impersonation: deps.impersonation } : {}),
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          gap(role);
          // A tolerant `urls` role whose every URL failed stands in URL by URL,
          // each held answer judged by its own age: the role's held copy may
          // carry answers older than the poll that kept it.
          const byUrl = await withHeldAnswers(
            role,
            [],
            [],
            Object.keys(deps.roles?.answers[role] ?? {}),
          );
          if (byUrl !== undefined && byUrl.buffers.length > 0) {
            fresh[role] = byUrl.buffers;
            freshUrls[role] = byUrl.urls;
            fallBack(role, reason);
            continue;
          }
          if (byUrl === undefined && holdsPayload(role)) {
            fallBack(role, reason);
            continue;
          }
          // An optional role that never answered: the poll goes on without it,
          // and the role stays due.
          if (format.endpoints[role]?.required !== false) throw err;
          leftOut = true;
          warnings.push(`${role}: ${reason} (left out)`);
          console.warn(`[ingest] ${src.id}: optional ${role} failed, left out: ${reason}`, {
            feed: src.id,
            role,
          });
          continue;
        }
        // A per-item role's items are details of the records its source role
        // lists, not partitions of one snapshot: the items that answered are
        // this poll's payload, and the role is not asked again before its
        // cadence. A held copy would only be older, and a poll that ended here
        // would fetch every item again each tick and, holding nothing after a
        // restart, publish nothing until every item answered at once. A walk's
        // files are no such details but the snapshot itself: a subtree it
        // could not list is missing records, and its partial result stands
        // like any partial snapshot.
        const each = src.endpoints[role]?.each;
        const eachPartial =
          result.status === "partial" && each !== undefined && each.links === undefined;
        // A tolerant `urls` role completed by its URLs' held answers is a
        // complete set, published like a fetched one.
        let completed = false;
        if (result.status === "fetched" || result.status === "partial") {
          const merged = await withHeldAnswers(
            role,
            result.buffers,
            result.urls,
            result.failedUrls ?? [],
          );
          if (merged !== undefined && result.status === "partial") {
            result = { ...result, ...merged };
            completed = true;
          }
        }
        // The walk's kept items are renewed even when its snapshot is refused:
        // they are the publisher's answers, and the next poll builds on them.
        if (result.status === "partial" && deps.roles && result.kept) {
          deps.roles.items[role] = result.kept;
        }
        if (result.status === "partial" && eachPartial) {
          const { failed, total } = result.partitions;
          warnings.push(`${role}: ${failed}/${total} items failed (left out)`);
          console.warn(`[ingest] ${src.id}: ${role}: ${failed}/${total} items failed, left out`, {
            feed: src.id,
            role,
          });
        }
        if (result.status === "partial" && !eachPartial && !completed && holdsPayload(role)) {
          const { failed, total } = result.partitions;
          fallBack(role, `partial snapshot: ${failed}/${total} partitions failed`);
          continue;
        }
        if (result.status === "fetched" || result.status === "partial") {
          payloadHashes = [...(payloadHashes ?? []), ...result.payloads.map((p) => p.sha256)];
          if (feedCapture) {
            // The responses as received: an archive, not its entries; an
            // item asked this poll, not one kept from an earlier one.
            const responses = result.responses ?? result.buffers;
            for (const [i, payload] of result.payloads.entries()) {
              await feedCapture.archive.capture(
                { ...feedCapture.meta, url: payload.url },
                responses[i]!,
                payload,
              );
            }
          }
          // The items kept are the role's own cache of the publisher's
          // answers, renewed whatever becomes of this poll.
          if (deps.roles && result.kept) deps.roles.items[role] = result.kept;
        }
        if (result.status === "no-endpoint") {
          await recordStatus({
            freshnessWindowSec: src.freshnessWindowSec,
            outcome: "missing_configuration",
            attemptAt,
            networkValidated: false,
            durationMs: Date.now() - start,
          });
          return { count: 0, durationMs: Date.now() - start, outcome: "missing_configuration" };
        }
        if (result.status === "partial" && !eachPartial && !completed) {
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
        if (result.status === "fetched") accepts.push(result.accept);
        if (result.status === "fetched" || result.status === "partial") {
          fresh[role] = result.buffers;
          freshUrls[role] = result.urls;
        }
        answered++;
        renewed.add(role);
        if (deps.roles) {
          deps.roles.lastFetchedAt[role] = Date.parse(attemptAt);
          delete deps.roles.failing[role];
        }
      }
      for (const role of failed) {
        const spec = format.endpoints[role];
        const since = spec?.accumulatesSince;
        if (since === undefined || renewed.has(since)) continue;
        // Failing within the publisher's window loses nothing: the next
        // answer still reaches back to the last one that came, or to the
        // snapshot, which holds every change before it.
        const lastAnswer = deps.roles?.lastFetchedAt[role];
        const lastSnapshot = deps.roles?.lastFetchedAt[since];
        const last =
          lastAnswer === undefined && lastSnapshot === undefined
            ? undefined
            : Math.max(lastAnswer ?? 0, lastSnapshot ?? 0);
        const window = spec?.changesWindowSec;
        if (
          window === undefined ||
          last === undefined ||
          Date.parse(attemptAt) - last > window * 1000
        ) {
          delete deps.roles?.lastFetchedAt[since];
        }
      }
      fetched = Object.keys(fresh);
      if (keepPayloads) {
        for (const [role, spec] of Object.entries(format.endpoints)) {
          // A snapshot answered anew (or confirmed unchanged) starts its roles
          // of changes over, failed ones included.
          const since = spec.accumulatesSince;
          if (since !== undefined && renewed.has(since)) {
            deps.roles!.payloads[role] = await holdAll(fresh[role] ?? []);
            deps.roles!.urls[role] = freshUrls[role] ?? [];
          }
        }
        for (const [role, buffers] of Object.entries(fresh)) {
          // A role of changes keeps every answer since its snapshot was fetched.
          const since = format.endpoints[role]?.accumulatesSince;
          if (since !== undefined && renewed.has(since)) continue;
          const held = deps.roles!.payloads[role] ?? [];
          const kept = await holdAll(buffers);
          const urls = freshUrls[role] ?? [];
          deps.roles!.payloads[role] = since === undefined ? kept : [...held, ...kept];
          deps.roles!.urls[role] =
            since === undefined ? urls : [...(deps.roles!.urls[role] ?? []), ...urls];
        }
        // The held copies stand in from here: the fetched bodies are not kept
        // alive while the poll waits for the gate.
        for (const role of fetched) {
          delete fresh[role];
          delete freshUrls[role];
        }
      }
      if (answered === 0 && warnings.length > 0) {
        // Every due role failed and its held payload stood in: nothing was
        // validated against the network, so the source's freshness stays as it was.
        const error = warnings.join("; ");
        await recordStatus({
          freshnessWindowSec: src.freshnessWindowSec,
          outcome: "failed",
          attemptAt,
          networkValidated: false,
          durationMs: Date.now() - start,
          error,
        });
        return { count: 0, durationMs: Date.now() - start, outcome: "failed", error };
      }
      if (fetched.length === 0) {
        await recordStatus({
          freshnessWindowSec: src.freshnessWindowSec,
          outcome: "validated_unchanged",
          attemptAt,
          networkValidated: true,
          durationMs: Date.now() - start,
          ...(warnings.length > 0 ? { error: warnings.join("; ") } : {}),
        });
        return { count: 0, durationMs: Date.now() - start, outcome: "validated_unchanged" };
      }
      acceptFetch = () => {
        for (const accept of accepts) accept();
      };
      if (warnings.length > 0) warning = warnings.join("; ");
    } catch (err) {
      return failFetch(err);
    }

    // A role's latest payloads: the held ones of a feed that keeps them (every
    // answer since its snapshot, for a role of changes), else this poll's.
    const held = (role: string) => (keepPayloads ? deps.roles!.payloads[role] : undefined);
    const bytesOf = (roles: readonly string[]) =>
      roles.reduce((sum, role) => {
        const kept = held(role);
        if (kept !== undefined) return sum + heldBytes(kept);
        return sum + payloadBytes({ [role]: fresh[role] ?? [] });
      }, 0);
    const payloadOf = async (role: string): Promise<readonly Buffer[]> => {
      const kept = held(role);
      return kept !== undefined ? heldBuffers(kept) : (fresh[role] ?? []);
    };
    const payloadsOf = async (roles: readonly string[]): Promise<FeedPayloads> =>
      Object.fromEntries(
        await Promise.all(roles.map(async (role) => [role, await payloadOf(role)] as const)),
      );

    const live = liveRoles(src);
    const index = deps.roles?.statusIndex;
    // Only live states came: the snapshot the index was built from stands, so
    // its readings are written without parsing it again.
    if (
      keepPayloads &&
      index !== undefined &&
      format.kind === "features" &&
      format.parseStatus !== undefined &&
      due.every((role) => live.includes(role))
    ) {
      const parseStatus = format.parseStatus;
      const statusAndFinish = async (): Promise<RunResult> => {
        let output: StatusOutput;
        try {
          output = parseStatus(src, await payloadsOf(fetched), ctx, index);
        } catch (err) {
          return failParse(err);
        }
        return finishStatusPoll(pollContext(), output);
      };
      return deps.parseGate
        ? deps.parseGate.run(bytesOf(fetched), statusAndFinish, src.id)
        : statusAndFinish();
    }

    const roles = dataRoles(src);
    // The payloads live through the parse only: the write needs the drafts.
    const parseLatest = async (): Promise<{ parsed: ParseOutput } | { failed: RunResult }> => {
      let payloads: FeedPayloads;
      try {
        payloads = await payloadsOf(roles);
        snapshotInspection = inspectSnapshotCompleteness(src, payloads["main"] ?? []);
        heldPayload = Object.values(payloads).some((buffers) => buffers.some((b) => b.length > 0));
      } catch (err) {
        return { failed: await failFetch(err) };
      }
      // The index stands for the publication this parse replaces; a poll that
      // fails leaves none, so the next one parses in full again.
      if (deps.roles) delete deps.roles.statusIndex;
      try {
        // A complete-snapshot source is read through its format's reporting
        // path, which reconciles partitions by source identity and refuses a
        // candidate it cannot fully account for.
        return { parsed: format.parse(src, payloads, ctx) };
      } catch (err) {
        return { failed: await failParse(err) };
      }
    };
    const parseAndFinish = async (): Promise<RunResult> => {
      const latest = await parseLatest();
      if ("failed" in latest) return latest.failed;
      const { parsed } = latest;
      const result = await finish(parsed);
      if (keepPayloads && live.length > 0 && result.error === undefined && parsed.statusIndex) {
        deps.roles!.statusIndex = parsed.statusIndex;
      }
      return result;
    };
    // The drafts of a large payload stay on the heap until their write
    // commits, so the gate holds through the write, not just the parse.
    return deps.parseGate
      ? deps.parseGate.run(bytesOf(roles), parseAndFinish, src.id)
      : parseAndFinish();
  }

  async function failFetch(err: unknown): Promise<RunResult> {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] fetch failed for source ${src.id}:`, err);
    await recordStatus({ freshnessWindowSec: src.freshnessWindowSec, outcome: "error", error });
    return { count: 0, durationMs: Date.now() - start, error };
  }

  async function failParse(err: unknown): Promise<RunResult> {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] parse failed for source ${src.id}:`, err);
    await recordStatus({ freshnessWindowSec: src.freshnessWindowSec, outcome: "error", error });
    return { count: 0, durationMs: Date.now() - start, error };
  }
}

/** Keeps a role's payloads between polls, gzipped when large. */
const holdAll = (buffers: readonly Buffer[]): Promise<HeldPayload[]> =>
  Promise.all(buffers.map(holdPayload));

/** The data roles of a feed its format reads as live states only. */
function liveRoles(src: CatalogFeed): string[] {
  const format = formatOf(src);
  return dataRoles(src).filter((role) => format.endpoints[role]?.status === true);
}

/** What the poll's last stages share once its payloads are parsed. */
interface PollContext {
  src: CatalogFeed;
  deps: RunDeps;
  attempt: PollAttempt;
  start: number;
  recordStatus: (update: SourceStatusUpdate) => Promise<void>;
  identity: PollIdentity;
  acceptFetch?: () => void;
  /** A data role failed and its held payload stood in; shown on the attempt's status. */
  warning?: string;
  /** Every data role's states are in the parse: none was left out. */
  statesComplete: boolean;
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
  // Records the parser read but could not use. An accounted snapshot that
  // kept none of them says nothing about what is current (a publisher that
  // changed its shape): publishing it would withdraw the last publication.
  // Terminal records do not change that, since some feeds always carry them
  // (a type left to another feed); what stands is bounded by its records'
  // own expiry.
  const parseRejected = parse.rejected ?? 0;
  if (accounting !== undefined && accounting.accepted === 0 && parseRejected > 0) {
    const refused = await fail(
      poll,
      "failed",
      `every usable record of the snapshot was rejected (${parseRejected})`,
    );
    return { ...refused, rejected: parseRejected };
  }
  const situations = resolved.map((draft) => stampAttribution(draft, src));

  // Shrink tripwire: a complete snapshot withdraws every situation it does not
  // hold, so a suspiciously shrunk fresh set is as dangerous as a parse error.
  // An accounted snapshot needs no ratio heuristic: every input record has an
  // explicit disposition, and the unlocatable check inside the publication
  // transaction protects a still-published record.
  if (accounting === undefined && !inspection?.completeEmpty) {
    const shrunk = await shrinkTripped(deps.sql, src.id, situations.length);
    if (shrunk) return failShrunk(poll, "event", "situations", situations.length, shrunk);
  }

  const skippedNoGeometry = drainSkippedNoGeometry(src.id);
  const rejected = dropped + skippedNoGeometry + parseRejected;
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

/**
 * The last stages of a features feed's poll: refuse a payload that held bytes
 * but parsed to no feature, or a feature count the shrink tripwire calls
 * suspect; stamp the catalogue's rights on features, readings and offers;
 * publish the complete snapshot.
 */
async function finishFeaturePoll(
  poll: PollContext,
  parse: ParseOutput,
  heldPayload: boolean,
): Promise<RunResult> {
  const { src, deps } = poll;
  if (heldPayload && parse.features.length === 0) {
    const error =
      "features feed produced zero features from a non-empty payload — skipping the write to keep the last good publication";
    console.warn(`[ingest] ${src.id}: ${error}`);
    return fail(poll, "failed", error);
  }
  const shrunk = await shrinkTripped(deps.sql, src.id, parse.features.length);
  if (shrunk) return failShrunk(poll, "features", "features", parse.features.length, shrunk);

  const stamp = (drafts: readonly RecordDraft[]) => drafts.map((d) => stampAttribution(d, src));
  const output = {
    features: stamp(parse.features),
    observations: stamp(parse.observations),
    offers: stamp(parse.offers),
  };
  let published: Awaited<ReturnType<typeof publishFeatures>>;
  try {
    published = await publishFeatures(deps.sql, src, {
      output,
      rejected: parse.rejected ?? 0,
      poll: poll.identity,
      durationMs: Date.now() - poll.start,
      now: deps.now(),
      model: writeModel(deps.model),
      statesComplete: poll.statesComplete,
      ...(poll.warning ? { warning: poll.warning } : {}),
    });
    poll.attempt.closed = true;
  } catch (err) {
    console.error(`[ingest] publish failed for source ${src.id}:`, err);
    return fail(poll, "failed", err instanceof Error ? err.message : String(err));
  }
  const { summary, counts } = published;
  logRejections(src.id, summary);
  poll.acceptFetch?.();

  const durationMs = Date.now() - poll.start;
  console.info(
    `[ingest] ${src.id}: ${output.features.length} features, ${output.observations.length} readings, ` +
      `${output.offers.length} offers (${counts.inserted} inserted, ${counts.updated} updated, ` +
      `${counts.deleted} withdrawn, ${summary.observations.ended} readings ended) in ${durationMs}ms`,
  );
  return {
    count: counts.inserted + counts.updated,
    durationMs,
    outcome: output.features.length === 0 ? "complete_empty" : "changed",
    activeEvents: counts.activeEvents,
    inserted: counts.inserted,
    updated: counts.updated,
    deleted: counts.deleted,
    rejected: counts.rejected,
  };
}

/**
 * The last stages of a poll that read live states alone: stamp the
 * catalogue's rights on the readings and write them, the source's features
 * and offers untouched and nothing withdrawn; the poll is a success of the
 * source like any other.
 */
async function finishStatusPoll(poll: PollContext, output: StatusOutput): Promise<RunResult> {
  const { src, deps } = poll;
  const observations = output.observations.map((d) => stampAttribution(d, src));
  let published: Awaited<ReturnType<typeof publishReadings>>;
  try {
    published = await publishReadings(deps.sql, src, {
      observations,
      rejected: output.rejected,
      poll: poll.identity,
      durationMs: Date.now() - poll.start,
      now: deps.now(),
      model: writeModel(deps.model),
      ...(poll.warning ? { warning: poll.warning } : {}),
    });
    poll.attempt.closed = true;
  } catch (err) {
    console.error(`[ingest] publish failed for source ${src.id}:`, err);
    return fail(poll, "failed", err instanceof Error ? err.message : String(err));
  }
  const { summary, counts } = published;
  logRejections(src.id, summary);
  poll.acceptFetch?.();

  const durationMs = Date.now() - poll.start;
  const o = summary.observations;
  console.info(
    `[ingest] ${src.id}: status only, ${observations.length} readings ` +
      `(latest ${o.latest}, history ${o.history}, unchanged ${o.unchanged}), ` +
      `${output.rejected} statuses unplaced in ${durationMs}ms`,
  );
  return {
    count: counts.updated,
    durationMs,
    outcome: "changed",
    activeEvents: counts.activeEvents,
    inserted: 0,
    updated: counts.updated,
    deleted: 0,
    rejected: counts.rejected,
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
