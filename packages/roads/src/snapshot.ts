import type { RoadEvent, UnresolvedRoadEvent } from "./model.js";

/**
 * Per-run source-record accounting for parsers that declare a *complete*
 * snapshot. The point is exhaustiveness: every input record gets an explicit
 * disposition, so "we parsed nothing" can never be mistaken for "the publisher
 * withdrew everything". This is a value returned from one parse call — there is
 * deliberately no global registry, no quarantine service and no cross-source
 * state.
 */

export type SnapshotEvent = RoadEvent | UnresolvedRoadEvent;

/** What happened to exactly one input record. */
export interface RoadSnapshotRecord {
  /** Stable prefixed observation id. Never a counter-based substitute. */
  id: string;
  /** Numeric source version, or null when the source publishes none. */
  version: number | null;
  /** Source version timestamp, used only to break equal/absent versions. */
  versionTime: string | null;
  /** Canonical digest of the record's source/content fields. */
  fingerprint: string;
  disposition: "accepted" | "terminal" | "unlocatable";
  /** Present for accepted records; terminal/unlocatable ones may carry none. */
  event?: SnapshotEvent;
}

/** One partition's parse result. */
export interface RoadSnapshotReport {
  inputCount: number;
  records: RoadSnapshotRecord[];
  errors: Array<{ code: string; id: string | null; sourcePath: string }>;
}

/** The reconciled view across every partition of one source. */
export interface ReconciledRoadSnapshot {
  inputCount: number;
  uniqueCount: number;
  duplicates: number;
  observations: SnapshotEvent[];
  acceptedIds: string[];
  terminalIds: string[];
  unlocatableIds: string[];
}

const MAX_CANONICAL_DEPTH = 24;

/**
 * A deterministic string for a JSON value: object keys sorted, array order
 * retained. Used only to compare two records claiming the same identity and
 * version, so it must never include fetch time, evaluation time or anything
 * else that differs between two otherwise identical polls.
 */
export function canonicalSnapshotValue(value: unknown): string {
  return JSON.stringify(canonicalize(value, 0));
}

function canonicalize(value: unknown, depth: number): unknown {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error("snapshot fingerprint input exceeds the supported nesting depth");
  }
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("snapshot fingerprint input contains a nonfinite number");
    }
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "undefined") return null;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, depth + 1));
  if (typeof value === "object") {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error("snapshot fingerprint input contains a non-plain object");
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  throw new Error(`snapshot fingerprint input contains an unsupported ${typeof value} value`);
}

/**
 * The source/content fields that decide whether two records claiming the same
 * identity and version actually say the same thing. Fetch and evaluation
 * timestamps are excluded so the same record served by two endpoints collapses
 * instead of looking like a conflict.
 */
export function snapshotFingerprint(event: SnapshotEvent): string {
  const e = event as SnapshotEvent & Record<string, unknown>;
  return canonicalSnapshotValue({
    id: e.id,
    type: e["type"] ?? null,
    subtype: e["subtype"] ?? null,
    category: e["category"] ?? null,
    severity: e["severity"] ?? null,
    status: e["status"] ?? null,
    headline: e["headline"] ?? null,
    description: e["description"] ?? null,
    geometry: e["geometry"] ?? null,
    direction: e["direction"] ?? null,
    roads: e["roads"] ?? null,
    roadState: e["roadState"] ?? null,
    lanesAffected: e["lanesAffected"] ?? null,
    speedLimitKph: e["speedLimitKph"] ?? null,
    restrictions: e["restrictions"] ?? null,
    restrictionDetails: e["restrictionDetails"] ?? null,
    restrictionDetailsUnsupported: e["restrictionDetailsUnsupported"] ?? null,
    vehiclesAffected: e["vehiclesAffected"] ?? null,
    detour: e["detour"] ?? null,
    validFrom: e["validFrom"] ?? null,
    validTo: e["validTo"] ?? null,
    schedule: e["schedule"] ?? null,
    externalRefs: e["externalRefs"] ?? null,
    dataUpdatedAt: e["dataUpdatedAt"] ?? null,
  });
}

/** A record's comparable rank: numeric version first, then version timestamp. */
const rank = (r: RoadSnapshotRecord): [number, number] => [
  r.version ?? -1,
  r.versionTime === null ? -Infinity : Date.parse(r.versionTime),
];

/**
 * Order two records claiming the same identity: greater numeric version wins,
 * then the later valid version timestamp. 0 means equal-ranked, which callers
 * must treat as a conflict unless the content is identical.
 */
export const compareSnapshotRank = (a: RoadSnapshotRecord, b: RoadSnapshotRecord): number => {
  const [av, at] = rank(a);
  const [bv, bt] = rank(b);
  return av === bv ? (at === bt ? 0 : at > bt ? 1 : -1) : av > bv ? 1 : -1;
};

const compare = compareSnapshotRank;

function validateRecord(record: RoadSnapshotRecord): void {
  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw new Error("snapshot record has no stable source identity");
  }
  if (record.version !== null) {
    if (!Number.isSafeInteger(record.version) || record.version < 0) {
      throw new Error(`snapshot record ${record.id} has an invalid source version`);
    }
  }
  if (record.versionTime !== null && !Number.isFinite(Date.parse(record.versionTime))) {
    throw new Error(`snapshot record ${record.id} has an invalid source version timestamp`);
  }
}

/**
 * Reconcile every partition of one source into a single accounted snapshot.
 *
 * Deduplication is by source identity only: two distinct ids both survive no
 * matter how close, similar or coincident they are. Repeated ids are resolved
 * by the greater numeric version, then the later valid version timestamp;
 * identical duplicates collapse; equal-ranked records whose content differs
 * throw, because silently picking one would publish an arbitrary half of a
 * contradictory feed. Output order is by id so the result is independent of
 * partition and record order.
 */
export function reconcileRoadSnapshots(reports: RoadSnapshotReport[]): ReconciledRoadSnapshot {
  let inputCount = 0;
  const byId = new Map<string, RoadSnapshotRecord>();
  let duplicates = 0;

  for (const report of reports) {
    if (report.errors.length > 0) {
      const first = report.errors[0]!;
      throw new Error(
        `snapshot parse error ${first.code} at ${first.sourcePath}${first.id ? ` for ${first.id}` : ""}`
      );
    }
    if (report.inputCount !== report.records.length) {
      throw new Error(
        `snapshot accounting mismatch: ${report.inputCount} input record(s), ${report.records.length} accounted`
      );
    }
    inputCount += report.inputCount;
    for (const record of report.records) {
      validateRecord(record);
      const existing = byId.get(record.id);
      if (existing === undefined) {
        byId.set(record.id, record);
        continue;
      }
      duplicates++;
      const order = compare(record, existing);
      if (order > 0) {
        byId.set(record.id, record);
        continue;
      }
      if (order < 0) continue;
      if (existing.fingerprint !== record.fingerprint) {
        throw new Error(
          `snapshot version conflict for ${record.id}: equal-ranked records with different content`
        );
      }
      // Identical duplicate across partitions: keep the first, but prefer a
      // terminal disposition so an explicit cancellation is never lost.
      if (record.disposition === "terminal" && existing.disposition !== "terminal") {
        byId.set(record.id, record);
      }
    }
  }

  const selected = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const acceptedIds: string[] = [];
  const terminalIds: string[] = [];
  const unlocatableIds: string[] = [];
  const observations: SnapshotEvent[] = [];

  for (const record of selected) {
    switch (record.disposition) {
      case "terminal":
        // Terminal status outranks localization: an explicitly cancelled record
        // withdraws its predecessor whether or not it still carries geometry.
        terminalIds.push(record.id);
        break;
      case "unlocatable":
        unlocatableIds.push(record.id);
        break;
      default:
        acceptedIds.push(record.id);
        if (record.event !== undefined) observations.push(record.event);
        break;
    }
  }

  return {
    inputCount,
    uniqueCount: selected.length,
    duplicates,
    observations,
    acceptedIds,
    terminalIds,
    unlocatableIds,
  };
}
