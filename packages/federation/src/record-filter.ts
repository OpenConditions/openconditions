/**
 * Federation of model records: the snapshot the outbox may carry, and the
 * subscriber filter applied at source to every page of records before it
 * leaves the instance. As with observations, the default is the safe one —
 * crowd records only once corroborated, and only permissively licensed
 * records — and a delete tombstone always passes, because a retraction must
 * reach every subscriber that might still hold the record.
 */
import { federationEligible, type RecordClass } from "@openconditions/model";
import { type EgressRecord, permissiveRecords, withoutReporter } from "@openconditions/publishers";
import type { Geometry } from "geojson";
import { intersectsBbox } from "./bbox.js";
import { DEFAULT_MIN_EVIDENCE_TIER, EVIDENCE_TIERS } from "./filter.js";
import type { OutboxOperation } from "./outbox.js";

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
  /** Drop share-alike records (default true). */
  permissiveOnly?: boolean;
  /** Weakest crowd evidence to pass (default "corroborated"); feed records are never gated by it. */
  minEvidenceTier?: string;
  /** Drop records last stated more than this many seconds ago. */
  maxAgeSec?: number;
}

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
 * Applies a subscriber's filter to a page of record entries. Classes, kinds,
 * domains and properties are read from the journal columns; a record that
 * fails any constraint is dropped and leaves a gap in the sequence.
 */
export function applyRecordFilter<R extends FederatedRecord>(
  entries: readonly RecordOutboxEntry<R>[],
  filter: RecordFilter | undefined,
  now: string,
): RecordOutboxEntry<R>[] {
  const minRank =
    TIER_RANK.get(filter?.minEvidenceTier ?? DEFAULT_MIN_EVIDENCE_TIER) ??
    TIER_RANK.get(DEFAULT_MIN_EVIDENCE_TIER)!;
  const nowMs = Date.parse(now);
  const named = filter?.kinds !== undefined || filter?.properties !== undefined;
  const out: RecordOutboxEntry<R>[] = [];
  for (const entry of entries) {
    const record = entry.record;
    if (entry.operation === "delete" || record === undefined) {
      out.push(entry);
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
    if (isCrowd(record)) {
      const rank = TIER_RANK.get(record.evidence?.state ?? "");
      if (rank === undefined || rank < minRank) continue;
    }
    if (filter?.maxAgeSec !== undefined) {
      const at = statedAt(record);
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
    const [exported] =
      (filter?.permissiveOnly ?? true) ? permissiveRecords([record]) : [withoutReporter(record)];
    if (exported === undefined) continue;
    out.push({ ...entry, record: exported });
  }
  return out;
}
