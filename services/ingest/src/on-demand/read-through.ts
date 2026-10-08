import type { Scope } from "@openconditions/core";
import {
  type Catalog,
  type CatalogFeed,
  cellCount,
  cellsCovering,
  hasCredentials,
} from "@openconditions/ingest-framework";
import type { KindClass, Registry } from "@openconditions/model";
import type postgres from "postgres";
import { formatOf } from "../domains.js";
import type { InFlight } from "../shutdown.js";
import { type CellOutcome, type FetchCellDeps, fetchCell } from "./fetch-cell.js";
import { cellState, readLedger } from "./ledger.js";

type BBox = [number, number, number, number];

/** Why an on-demand source did not answer a read in full. */
export type OnDemandShortfall =
  | "too_many_cells"
  | "limited"
  | "failed"
  | "deadline"
  | "missing_configuration";

/** Which on-demand sources a read's area was complete for. */
export interface OnDemandCoverage {
  /**
   * True when any source that could answer was not complete; a source missing
   * its configuration is listed in `sources` with its reason but never makes
   * the read partial.
   */
  partial: boolean;
  sources: { id: string; complete: boolean; reason?: OnDemandShortfall }[];
}

/** What a read asks for: the area, the class it lists, and the kinds, properties or domain it filters by. */
export interface ReadThroughQuery {
  bbox: BBox;
  /** The class of the records the read lists. */
  class: "feature" | "offer" | "observation";
  kinds?: readonly string[];
  properties?: readonly string[];
  domain?: string;
  /** Only these sources, when the read names any. */
  sources?: readonly string[];
  /** The instant the read is for; one in the past reads storage only. */
  at?: Date;
  /** Who the read is for: a public read never fetches a restricted source. */
  scope: Scope;
}

export interface ReadThroughDeps extends FetchCellDeps {
  /** How long the read waits for its fetches before it answers from storage. */
  deadlineMs: number;
  /** Tracks each cell fetch, so shutdown waits for one the read left running. */
  inFlight?: Pick<InFlight, "track">;
}

/** The default of `OPENCONDITIONS_ON_DEMAND_DEADLINE_MS`. */
export const DEFAULT_DEADLINE_MS = 3000;

/** `OPENCONDITIONS_ON_DEMAND_DEADLINE_MS`, a positive integer; unset, blank or invalid is the default. */
export function onDemandDeadlineMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["OPENCONDITIONS_ON_DEMAND_DEADLINE_MS"];
  if (raw == null || raw.trim() === "") return DEFAULT_DEADLINE_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DEADLINE_MS;
}

/** Whether the query's interval `[a0, a1]` meets the source's `[b0, b1]`: overlaps it, or a point query lies on it. */
function meets(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 === a1 ? a0 >= b0 && a0 <= b1 : a0 < b1 && a1 > b0;
}

/** The part of the query's area inside the source's coverage, or undefined when they do not meet. */
function clip(query: BBox, coverage: BBox): BBox | undefined {
  const [w, s, e, n] = query;
  const [cw, cs, ce, cn] = coverage;
  if (!meets(w, e, cw, ce) || !meets(s, n, cs, cn)) return undefined;
  return [Math.max(w, cw), Math.max(s, cs), Math.min(e, ce), Math.min(n, cn)];
}

/** The registry classes of the kinds a read of each class lists. */
const LISTED_KIND_CLASSES = {
  feature: ["feature", "component"],
  offer: ["offer"],
  observation: [],
} as const satisfies Record<ReadThroughQuery["class"], readonly KindClass[]>;

/**
 * Whether an on-demand source answers what a read filters by. Only what the
 * source's format produces of the read's class counts: the kinds of the
 * records it lists (feature and component kinds for a feature read, offer
 * kinds for an offer read) and, for a reading read, the properties. Every
 * filter the read names must match, as the reader applies them all: one of
 * its kinds or properties is one of those, and its domain is the registry
 * domain of one of them. A read naming none of them fetches nothing.
 */
function answers(feed: CatalogFeed, q: ReadThroughQuery, registry: Registry): boolean {
  const produces = formatOf(feed).produces;
  if (produces === undefined) return false;
  if (q.kinds === undefined && q.properties === undefined && q.domain === undefined) return false;
  const listed = LISTED_KIND_CLASSES[q.class].flatMap((cls) => registry.kinds(cls));
  const kinds = listed.filter((e) => produces.kinds.includes(e.code));
  const properties = q.class === "observation" ? produces.properties : [];
  if (q.kinds !== undefined && !q.kinds.some((k) => kinds.some((e) => e.code === k))) return false;
  if (q.properties !== undefined && !q.properties.some((p) => properties.includes(p))) {
    return false;
  }
  if (q.domain !== undefined) {
    const inDomain =
      kinds.some((e) => e.domain === q.domain) ||
      properties.some((p) => registry.property(p)?.domain === q.domain);
    if (!inDomain) return false;
  }
  return true;
}

/** A cell fetch whose outcome is known once it settles. */
interface Pending {
  outcome?: CellOutcome;
  settled: Promise<void>;
}

/** What one source's part of a read came to: its report now, or the cells it waits for. */
type Plan =
  | { id: string; report: OnDemandShortfall | "complete" }
  | { id: string; pending: Pending[]; backoff: boolean };

/**
 * Brings the on-demand sources a bbox read touches up to date before it is
 * answered from storage. A source takes part when it is enabled, visible in
 * the read's scope (a public read leaves a restricted source out, even one
 * it names: the reader withholds its records, so fetching them would spend
 * its quota for nothing and coverage would name it), among the read's
 * `sources` if it names any, its `coverage.bbox` meets the read's area and
 * it produces records of the read's class that the read asks for (see
 * `answers`); with none, or for a
 * read of a past instant, the answer is undefined and nothing is fetched.
 * For each:
 * - a source whose credentials are missing is not fetched
 *   (`missing_configuration`); it is listed with that reason but does not make
 *   the read `partial`, since waiting or a smaller area never helps it;
 * - an area inside its coverage of more grid cells than
 *   `onDemand.maxCellsPerRead` fetches none (`too_many_cells`), counted
 *   before any cell is built or the ledger read;
 * - otherwise the cells are read from the ledger, and every stale cell not
 *   backing off from a failure is fetched
 *   (`fetchCell`), in id order while the source's tokens last; the rest are
 *   `limited`; a failed or backing-off cell makes the source `failed`.
 * The read waits up to `deadlineMs`. A fetch still running then goes on and
 * writes when it lands; its source is reported `deadline`, as is a source
 * whose cell another process has claimed and is fetching. No upstream or
 * fetch error fails the read: each is logged and reported here.
 */
export async function readThrough(
  sql: postgres.Sql,
  catalog: Pick<Catalog, "feeds">,
  q: ReadThroughQuery,
  deps: ReadThroughDeps,
): Promise<OnDemandCoverage | undefined> {
  const now = deps.now();
  // What a source said in the past is not fetched now.
  if (q.at !== undefined && q.at < now) return undefined;
  const env = deps.env ?? process.env;
  const sources = catalog.feeds.flatMap((feed) => {
    if (feed.accessMode !== "on_demand" || feed.onDemand === undefined || feed.disabled) return [];
    if (q.scope !== "operator" && feed.restricted) return [];
    if (q.sources !== undefined && !q.sources.includes(feed.id)) return [];
    const bbox = feed.coverage.bbox;
    const area = bbox === undefined ? undefined : clip(q.bbox, bbox);
    if (area === undefined || !answers(feed, q, deps.registry)) return [];
    return [{ feed, area, onDemand: feed.onDemand }];
  });
  if (sources.length === 0) return undefined;

  const plans = await Promise.all(
    sources.map(async ({ feed, area, onDemand }): Promise<Plan> => {
      const id = feed.id;
      if (!hasCredentials(feed, env)) return { id, report: "missing_configuration" };
      if (cellCount(area, onDemand.cellDeg) > onDemand.maxCellsPerRead) {
        return { id, report: "too_many_cells" };
      }
      try {
        const cells = cellsCovering(area, onDemand.cellDeg);
        const ledger = await readLedger(
          sql,
          id,
          cells.map((c) => c.id),
        );
        const states = cells.map((cell) => ({ cell, state: cellState(ledger.get(cell.id), now) }));
        const stale = states.filter((s) => s.state !== "fresh");
        if (stale.length === 0) return { id, report: "complete" };
        const due = stale
          .filter((s) => s.state === "due")
          .map((s) => s.cell)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const pending = due.map((cell): Pending => {
          const p: Pending = { settled: Promise.resolve() };
          const fetched = fetchCell(sql, feed, cell, deps);
          p.settled = (deps.inFlight?.track(fetched) ?? fetched).then(
            (outcome) => {
              p.outcome = outcome;
            },
            (err: unknown) => {
              console.error(`[on-demand] ${id} cell ${cell.id}: fetch failed`, err);
              p.outcome = "failed";
            },
          );
          return p;
        });
        return { id, pending, backoff: stale.length > due.length };
      } catch (err) {
        console.error(`[on-demand] ${id}: read-through failed`, err);
        return { id, report: "failed" };
      }
    }),
  );

  const waiting = plans.flatMap((p) => ("pending" in p ? p.pending.map((c) => c.settled) : []));
  if (waiting.length > 0) await settledWithin(waiting, deps.deadlineMs);

  const reports = plans.map((plan): OnDemandCoverage["sources"][number] => {
    const reason = "report" in plan ? plan.report : shortfallOf(plan.pending, plan.backoff);
    return reason === "complete"
      ? { id: plan.id, complete: true }
      : { id: plan.id, complete: false, reason };
  });
  // A source that cannot run for want of configuration will not answer however
  // long the client waits or far it zooms in, so it is listed but is no gap.
  const partial = reports.some((r) => !r.complete && r.reason !== "missing_configuration");
  return { partial, sources: reports };
}

/**
 * Why a source's fetched cells fell short, or `complete`: a cell refused for
 * want of tokens first (it will not land soon), then a failed or backing-off
 * cell, then one still running at the deadline, here or in another process.
 */
function shortfallOf(cells: readonly Pending[], backoff: boolean): OnDemandShortfall | "complete" {
  if (cells.some((c) => c.outcome === "limited")) return "limited";
  if (backoff || cells.some((c) => c.outcome === "failed")) return "failed";
  if (cells.some((c) => c.outcome === undefined || c.outcome === "busy")) return "deadline";
  return "complete";
}

/** Waits until every promise settles or `ms` pass, leaving no timer behind. */
async function settledWithin(promises: readonly Promise<void>[], ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  try {
    await Promise.race([Promise.all(promises), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
