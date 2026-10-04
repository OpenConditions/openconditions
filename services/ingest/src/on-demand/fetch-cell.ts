import type {
  CatalogFeed,
  Cell,
  Env,
  LookupFn,
  RecordDraft,
} from "@openconditions/ingest-framework";
import { fetchEndpoint, guardOptionsFromEnv } from "@openconditions/ingest-framework";
import type { Registry } from "@openconditions/model";
import { writeSnapshotIn } from "@openconditions/storage";
import type postgres from "postgres";
import { domainOf, formatOf } from "../domains.js";
import { logRejections, stampAttribution } from "../pipeline/publish.js";
import { dataRoles, feedFetch } from "../pipeline/run.js";
import { openPollAttempt, upsertSourceStatus } from "../pipeline/source-status.js";
import { claimCell, markFailed, markFresh, releaseClaim, renewClaim } from "./ledger.js";
import { requestsPerCell, takeCellTokens } from "./limits.js";

type Rec = Record<string, unknown>;

/** What a cell fetch needs besides the database. */
export interface FetchCellDeps {
  /** undici's fetch in production: the egress guard pins its sockets. */
  fetch: typeof fetch;
  now: () => Date;
  registry: Registry;
  instanceId: string;
  /** Where credentials are read; defaults to `process.env`. */
  env?: Env;
  /** Overrides the DNS resolver of the egress guard; tests only. */
  lookup?: LookupFn;
}

/**
 * How a cell read ended: its answer is stored (`fresh`, by this fetch or
 * another's), the fetch `failed` (or failed recently and backs off), the
 * source's quota left no request (`limited`), or another process holds the
 * cell's claim and is fetching it (`busy`).
 */
export type CellOutcome = "fresh" | "failed" | "limited" | "busy";

/** Cells of one source fetched at once in this process. */
const FETCHES_PER_SOURCE = 2;

/** What a claim adds to the longest its requests may take: parsing and writing. */
const CLAIM_MARGIN_MS = 30_000;

/** A first-in, first-out gate letting `size` holders through at a time. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.size) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      // The slot passes straight to the next waiter, so none is overtaken.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** One gate per source, made on first use. */
function gates(size: number): (sourceId: string) => Gate {
  const bySource = new Map<string, Gate>();
  return (sourceId) => {
    let gate = bySource.get(sourceId);
    if (!gate) {
      gate = new Gate(size);
      bySource.set(sourceId, gate);
    }
    return gate;
  };
}

/**
 * A source's cells are claimed and given tokens one after the other, in the
 * order reads ask for them, so a read's cells take the tokens in id order.
 * These are two short statements; no upstream request waits here.
 */
const admission = gates(1);

/** A source's claimed cells are fetched at most this many at a time. */
const fetching = gates(FETCHES_PER_SOURCE);

/** The cell fetches in flight in this process, by source and cell. */
const inFlight = new Map<string, Promise<CellOutcome>>();

/**
 * How long a claim lasts: every request of the cell timing out, one after
 * the other, plus a margin. A claimant that crashed is replaced after that.
 */
function claimMs(feed: CatalogFeed): number {
  const { timeoutMs } = guardOptionsFromEnv();
  return requestsPerCell(feed) * timeoutMs + CLAIM_MARGIN_MS;
}

/**
 * Brings one cell of an on-demand source up to date. Concurrent calls for the
 * same cell share one fetch: in this process by the promise in flight, across
 * processes by the cell's claim in the ledger (`claimCell`), one statement
 * that only a cell neither fresh, backing off nor claimed by a running
 * fetcher passes. A cell still fresh answers `fresh`; one backing off from a
 * failure answers `failed`; one claimed elsewhere answers `busy`; a source
 * out of tokens answers `limited` and gives the claim back. Otherwise every
 * data endpoint is fetched for the cell, holding no database connection,
 * through the poll's guarded, authorized fetch, and parsed with no reference
 * data; the drafts are stamped with the catalogue's rights,
 * `accessMode: "on_demand"` and an expiry `ttlSec` after the fetch, and
 * written as a partial snapshot (nothing else of the source is withdrawn) in
 * one transaction under the source's lock with the ledger, which clears the
 * claim, and the source's status. The ledger and the write take effect only
 * while the claim is still this fetch's: one that outlived its claim, whose
 * cell another fetcher took, drops its answer (`busy`). A failed fetch,
 * parse or write keeps the stored rows, marks the cell failed with a backoff
 * (under the same claim), clears the claim and records the failure on the
 * source's status; it is logged, never thrown.
 */
export function fetchCell(
  sql: postgres.Sql,
  feed: CatalogFeed,
  cell: Cell,
  deps: FetchCellDeps,
): Promise<CellOutcome> {
  const key = `${feed.id}|${cell.id}`;
  const running = inFlight.get(key);
  if (running) return running;
  const flight = claimAndFetch(sql, feed, cell, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, flight);
  return flight;
}

/** What a lost claim answers. */
const LOST = { fresh: "fresh", backoff: "failed", busy: "busy" } as const;

async function claimAndFetch(
  sql: postgres.Sql,
  feed: CatalogFeed,
  cell: Cell,
  deps: FetchCellDeps,
): Promise<CellOutcome> {
  const admitted = await admission(feed.id).run(async () => {
    const now = deps.now();
    const claim = await claimCell(
      sql,
      feed.id,
      cell.id,
      now,
      new Date(now.getTime() + claimMs(feed)),
    );
    if (claim.result !== "won") return LOST[claim.result];
    if (!(await takeCellTokens(sql, feed, now))) {
      await releaseClaim(sql, feed.id, cell.id, claim.until);
      return "limited";
    }
    return claim.until;
  });
  if (!(admitted instanceof Date)) return admitted;
  return fetching(feed.id).run(async () => {
    // Waiting for a slot used up part of the claim: it starts over now, if
    // it was not taken over meanwhile.
    const now = deps.now();
    const until = new Date(now.getTime() + claimMs(feed));
    if (!(await renewClaim(sql, feed.id, cell.id, admitted, until))) return "busy";
    return fetchAndWrite(sql, feed, cell, deps, now, until);
  });
}

/** A draft as an on-demand answer: stamped with the catalogue's rights, the access mode and its expiry. */
function onDemandDraft(draft: RecordDraft, feed: CatalogFeed, expiresAt: string): RecordDraft {
  const stamped = stampAttribution(draft, feed) as Rec;
  return {
    ...stamped,
    provenance: { ...(stamped["provenance"] as Rec), accessMode: "on_demand" },
    freshness: { ...(stamped["freshness"] as Rec), expiresAt },
  };
}

/** Fetches and writes a cell under the claim the caller set at `held`. */
async function fetchAndWrite(
  sql: postgres.Sql,
  feed: CatalogFeed,
  cell: Cell,
  deps: FetchCellDeps,
  now: Date,
  held: Date,
): Promise<CellOutcome> {
  const start = Date.now();
  const at = now.toISOString();
  const env = deps.env ?? process.env;
  const payloadHashes: string[] = [];
  let attemptId: number | undefined;
  try {
    attemptId = await openPollAttempt(sql, feed.id, at);
    const ttlSec = feed.onDemand?.ttlSec;
    if (ttlSec === undefined) throw new Error("not an on-demand feed: no onDemand block");
    const fetchFn = feedFetch(feed, { ...deps, env });
    const payloads: Record<string, readonly Buffer[]> = {};
    for (const role of dataRoles(feed)) {
      const result = await fetchEndpoint(feed, role, fetchFn, {
        resolvers: domainOf(feed).resolvers,
        env,
        cell,
      });
      if (result.status === "no-endpoint") throw new Error(`${role}: missing configuration`);
      if (result.status === "not-modified") throw new Error(`${role}: unexpected 304`);
      if (result.status === "partial") {
        const { failed, total } = result.partitions;
        throw new Error(`${role}: ${failed}/${total} requests failed`);
      }
      payloads[role] = result.buffers;
      payloadHashes.push(...result.payloads.map((p) => p.sha256));
    }
    const parse = formatOf(feed).parse(feed, payloads, {
      fetchedAt: at,
      cadenceSec: feed.cadenceSec,
      reference: {},
    });
    const expiresAt = new Date(now.getTime() + ttlSec * 1000);
    const stamp = (drafts: readonly RecordDraft[]) =>
      drafts.map((d) => onDemandDraft(d, feed, expiresAt.toISOString()));
    const output = {
      features: stamp(parse.features),
      observations: stamp(parse.observations),
      offers: stamp(parse.offers),
    };
    const empty =
      output.features.length === 0 &&
      output.observations.length === 0 &&
      output.offers.length === 0;
    const fetchId = attemptId;
    const written = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${feed.id}))`;
      if (!(await markFresh(tx, feed.id, cell.id, held, now, expiresAt))) {
        // The claim lapsed and another fetcher took the cell: its answer
        // stands, this one is dropped.
        await upsertSourceStatus(tx, feed.id, {
          freshnessWindowSec: feed.freshnessWindowSec,
          outcome: "skipped_overlap",
          attemptAt: at,
          networkValidated: false,
          durationMs: Date.now() - start,
          attemptId: fetchId,
        });
        return false;
      }
      const summary = await writeSnapshotIn(tx, feed.id, output, {
        registry: deps.registry,
        instanceId: deps.instanceId,
        now: at,
        complete: false,
        fetchId,
        ...(payloadHashes.length > 0 ? { payloadHashes } : {}),
      });
      logRejections(feed.id, summary);
      const [{ live }] = await tx<{ live: number }[]>`
        SELECT count(*)::int AS live FROM conditions.feature
         WHERE source_id = ${feed.id} AND tombstoned_at IS NULL`;
      const f = summary.counts.feature;
      const o = summary.counts.offer;
      const rejectedReadings = summary.rejected.filter((r) => r.class === "observation").length;
      const readings =
        output.observations.length - summary.observations.unchanged - rejectedReadings;
      await upsertSourceStatus(tx, feed.id, {
        freshnessWindowSec: feed.freshnessWindowSec,
        outcome: empty ? "complete_empty" : "changed",
        attemptAt: at,
        networkValidated: true,
        durationMs: Date.now() - start,
        attemptId: fetchId,
        ...(payloadHashes.length > 0 ? { payloadHashes } : {}),
        publication: {
          activeEvents: live,
          rowCount: live,
          inserted: f.created + f.restored + o.created + o.restored,
          updated: f.updated + o.updated + Math.max(0, readings),
          deleted: 0,
          rejected: summary.rejected.length,
        },
      });
      return true;
    });
    return written ? "fresh" : "busy";
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[on-demand] ${feed.id} cell ${cell.id} failed: ${error}`);
    try {
      await sql.begin(async (tx) => {
        await markFailed(tx, feed.id, cell.id, held, now);
        await upsertSourceStatus(tx, feed.id, {
          freshnessWindowSec: feed.freshnessWindowSec,
          outcome: "failed",
          attemptAt: at,
          networkValidated: false,
          durationMs: Date.now() - start,
          ...(attemptId !== undefined ? { attemptId } : {}),
          ...(payloadHashes.length > 0 ? { payloadHashes } : {}),
          error,
        });
      });
    } catch (recordErr) {
      console.error(
        `[on-demand] ${feed.id} cell ${cell.id}: could not record the failure`,
        recordErr,
      );
    }
    return "failed";
  }
}
