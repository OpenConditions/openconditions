/**
 * Federation of model records: the snapshot the outbox may carry, and the
 * subscriber filter applied at source to every page of records before it
 * leaves the instance. Federation is always public scope: only records whose
 * licence is public leave, whatever the subscriber asks. Crowd records pass
 * once corroborated by default, and a delete tombstone always passes,
 * because a retraction must reach every subscriber that might still hold
 * the record.
 */
import {
  type EgressRecord,
  publicRecords,
  withoutReporter,
} from "@openconditions/ingest-framework";
import { federationEligible, type RecordClass } from "@openconditions/model";
import type { Geometry } from "geojson";
import { intersectsBbox } from "./bbox.js";
import type { OutboxOperation } from "./outbox.js";

/** The evidence tiers a subscriber can ask for, weakest first. */
export const EVIDENCE_TIERS = ["self_reported", "corroborated", "externally_resolved"] as const;

/** Crowd records reach a subscriber once corroborated, unless it asks for less. */
export const DEFAULT_MIN_EVIDENCE_TIER = "corroborated";

/** The parts of a stored model record federation reads. */
export interface FederatedRecord extends EgressRecord {
  id: string;
  class: RecordClass;
  kind: string;
  domain: string;
  property?: string;
  location: { geometry: unknown };
  provenance: EgressRecord["provenance"] & {
    origin: string;
    sourceId: string;
    accessMode: string;
    sourceUpdatedAt?: string;
    privacy: { class: string };
  };
  freshness: { fetchedAt: string };
  evidence?: { state: string };
  phenomenonTime?: { instant: string } | { start: string; end: string };
  extras?: Record<string, unknown>;
}

/** One outbox entry of a model record; the journal's columns say what it is without reading it. */
export interface RecordOutboxEntry<R extends FederatedRecord = FederatedRecord> {
  seq: number;
  txid: string;
  operation: OutboxOperation;
  recordClass: RecordClass;
  recordId: string;
  canonicalId: string | null;
  kind: string;
  domain: string;
  /** Observations: the property; `kind` is then "observation". */
  property?: string;
  createdAt: string;
  /** The point-in-time record; absent on delete entries. */
  record?: R;
  tombstone?: true;
  reason?: string;
}

/**
 * One outbox entry saying that this instance polled a source successfully
 * (`polledAt`): the peer's unchanged readings of the source still hold. Only
 * a subscriber that asks for them (`sourceLiveness`) is served these.
 */
export interface SourceLivenessEntry {
  seq: number;
  txid: string;
  operation: "liveness";
  sourceId: string;
  /** The source's domain. */
  domain: string;
  polledAt: string;
  createdAt: string;
}

/** One entry of an outbox page. */
export type OutboxEntry<R extends FederatedRecord = FederatedRecord> =
  | RecordOutboxEntry<R>
  | SourceLivenessEntry;

export interface RecordFilter {
  /** [west, south, east, north]; kept when the geometry's bbox intersects. */
  bbox?: [number, number, number, number];
  classes?: RecordClass[];
  /** Kinds of features, situations and offers; with `properties`, what a subscriber names is all it gets. */
  kinds?: string[];
  domains?: string[];
  /** Properties of observations. */
  properties?: string[];
  privacyClasses?: string[];
  /**
   * Weakest crowd evidence to pass (default "corroborated"); feed records are
   * never gated by it, and neither is a negated or expired crowd record.
   */
  minEvidenceTier?: string;
  /** Drop records last stated (a reading: stated or journalled) more than this many seconds ago. */
  maxAgeSec?: number;
  /**
   * Also serve the liveness of the sources whose readings the filter admits
   * (of its domains, when it names them). An instance that predates these
   * entries ignores the field, and its subscribers never ask for it.
   */
  sourceLiveness?: boolean;
}

/**
 * Crowd states that withdraw a report. They have no tier rank, yet must pass
 * the tier gate: the filter cannot know whether the subscriber holds the
 * corroborated copy, and a subscriber that does would otherwise keep showing
 * it until the origin's delete arrives. A withdrawn report claims nothing a
 * subscriber could act on, so passing it to one that never held it is harmless.
 */
const WITHDRAWN_STATES = new Set(["negated", "expired"]);

const TIER_RANK = new Map<string, number>(EVIDENCE_TIERS.map((tier, rank) => [tier, rank]));

/**
 * What the outbox carries of a record, or undefined for a record that never
 * leaves the instance: an on-demand answer or a fused row. The reporter is
 * stripped, and the source's allow-listed extras ride along only when the
 * source opted in to federating them.
 */
export function federatedSnapshot<T extends FederatedRecord>(
  record: T,
  opts: { federateExtras: boolean },
): T | undefined {
  if (!federationEligible(record)) return undefined;
  const stripped = withoutReporter(record);
  if (opts.federateExtras || stripped.extras === undefined) return stripped;
  const { extras: _extras, ...rest } = stripped;
  return rest as T;
}

/** When a record was last stated: an observation's reading, else the publisher's or the fetch's time. */
function statedAt(record: FederatedRecord): number {
  const t = record.phenomenonTime;
  if (t !== undefined) return Date.parse("instant" in t ? t.instant : t.start);
  return Date.parse(record.provenance.sourceUpdatedAt ?? record.freshness.fetchedAt);
}

const isCrowd = (record: FederatedRecord) =>
  record.provenance.origin === "crowd" || record.provenance.privacy.class === "crowd_pseudonym";

/**
 * Whether a subscriber is served a source's liveness: it asked for it, and
 * would be served the source's readings by class and domain.
 */
function wantsLiveness(entry: SourceLivenessEntry, filter: RecordFilter | undefined): boolean {
  return (
    filter?.sourceLiveness === true &&
    (filter.classes === undefined || filter.classes.includes("observation")) &&
    (filter.domains === undefined || filter.domains.includes(entry.domain))
  );
}

/**
 * Applies a subscriber's filter to a page of entries. Classes, kinds,
 * domains and properties are read from the journal columns; a record that
 * fails any constraint is dropped and leaves a gap in the sequence, as does
 * a source's liveness nobody asked for.
 */
export function applyRecordFilter<E extends OutboxEntry>(
  entries: readonly E[],
  filter: RecordFilter | undefined,
  now: string,
): E[] {
  const minRank =
    TIER_RANK.get(filter?.minEvidenceTier ?? DEFAULT_MIN_EVIDENCE_TIER) ??
    TIER_RANK.get(DEFAULT_MIN_EVIDENCE_TIER)!;
  const nowMs = Date.parse(now);
  const named = filter?.kinds !== undefined || filter?.properties !== undefined;
  const out: E[] = [];
  for (const item of entries) {
    const entry = item as OutboxEntry;
    if (entry.operation === "liveness") {
      if (wantsLiveness(entry, filter)) out.push(item);
      continue;
    }
    const record = entry.record;
    if (entry.operation === "delete" || record === undefined) {
      out.push(item);
      continue;
    }
    if (filter?.classes !== undefined && !filter.classes.includes(entry.recordClass)) continue;
    if (filter?.domains !== undefined && !filter.domains.includes(entry.domain)) continue;
    if (named) {
      const listed =
        entry.recordClass === "observation"
          ? filter?.properties?.includes(entry.property ?? "")
          : filter?.kinds?.includes(entry.kind);
      if (!listed) continue;
    }
    if (isCrowd(record) && WITHDRAWN_STATES.has(record.evidence?.state ?? "")) {
      // A report the crowd withdrew goes out as a retraction: a subscriber
      // holding it ends its copy, and one the tier kept it from learns
      // nothing of what it said.
      const { record: _content, ...ref } = entry;
      out.push({
        ...ref,
        operation: "delete",
        tombstone: true,
        reason: record.evidence?.state === "expired" ? "expired" : "withdrawn",
      } as E);
      continue;
    }
    if (isCrowd(record)) {
      const rank = TIER_RANK.get(record.evidence?.state ?? "");
      if (rank === undefined || rank < minRank) continue;
    }
    if (filter?.maxAgeSec !== undefined) {
      // A reading is journalled when it changes, its time the publisher's: a
      // state stated days ago and first written now is news now.
      const stated = statedAt(record);
      const at =
        entry.recordClass === "observation"
          ? Math.max(stated, Date.parse(entry.createdAt))
          : stated;
      if (!Number.isFinite(at) || nowMs - at > filter.maxAgeSec * 1000) continue;
    }
    if (filter?.bbox !== undefined) {
      const geometry = record.location.geometry as Geometry | null;
      if (geometry === null || !intersectsBbox(geometry, filter.bbox)) continue;
    }
    if (
      filter?.privacyClasses !== undefined &&
      !filter.privacyClasses.includes(record.provenance.privacy.class)
    ) {
      continue;
    }
    // Federation is always public scope: no subscriber can ask for more.
    const [exported] = publicRecords([record]);
    if (exported === undefined) continue;
    out.push({ ...entry, record: exported } as E);
  }
  return out;
}
