/**
 * Query-string parsing for GET /peer/outbox. Fail-closed: any malformed
 * parameter is a {@link OutboxQueryError} (the route answers 400) rather than
 * a silently-widened filter. Also rebuilds the validated filter parameters as
 * an encoded query-string so the page's `next` link preserves the
 * subscriber's filter across pagination.
 */
import {
  decodeOutboxCursor,
  EVIDENCE_TIERS,
  OUTBOX_CURSOR_START,
  OUTBOX_MAX_LIMIT,
  type OutboxCursor,
  type RecordFilter,
} from "@openconditions/federation";
import { RECORD_CLASSES, type RecordClass } from "@openconditions/model";

export class OutboxQueryError extends Error {}

export interface ParsedOutboxQuery {
  after: OutboxCursor;
  limit?: number;
  filter?: RecordFilter;
  /** Encoded filter/limit params for the `next` link (no `after`). */
  nextParams?: string;
}

function single(query: Record<string, unknown>, name: string): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new OutboxQueryError(`invalid ${name}`);
  }
  return value;
}

function nonNegativeInt(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new OutboxQueryError(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new OutboxQueryError(`${name} out of range`);
  return parsed;
}

/** A comma-separated allow-list parameter, or undefined when absent. */
function list(query: Record<string, unknown>, name: string): string[] | undefined {
  const raw = single(query, name);
  if (raw === undefined) return undefined;
  const values = raw.split(",").filter((v) => v.length > 0);
  if (values.length === 0) throw new OutboxQueryError(`${name} must be a comma-separated list`);
  return values;
}

export function parseOutboxQuery(query: Record<string, unknown>): ParsedOutboxQuery {
  const filter: RecordFilter = {};
  const next = new URLSearchParams();

  const bbox = single(query, "bbox");
  if (bbox !== undefined) {
    const parts = bbox.split(",").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new OutboxQueryError("bbox must be four comma-separated numbers (w,s,e,n)");
    }
    filter.bbox = parts as [number, number, number, number];
    next.set("bbox", bbox);
  }

  const classes = list(query, "classes");
  if (classes !== undefined) {
    const unknown = classes.filter((c) => !(RECORD_CLASSES as readonly string[]).includes(c));
    if (unknown.length > 0) {
      throw new OutboxQueryError(`classes must name record classes (${RECORD_CLASSES.join(", ")})`);
    }
    filter.classes = classes as RecordClass[];
    next.set("classes", classes.join(","));
  }

  for (const name of ["kinds", "domains", "properties", "privacyClasses"] as const) {
    const values = list(query, name);
    if (values === undefined) continue;
    filter[name] = values;
    next.set(name, values.join(","));
  }

  const minEvidenceTier = single(query, "minEvidenceTier");
  if (minEvidenceTier !== undefined) {
    if (!(EVIDENCE_TIERS as readonly string[]).includes(minEvidenceTier)) {
      throw new OutboxQueryError(`minEvidenceTier must be one of ${EVIDENCE_TIERS.join(", ")}`);
    }
    filter.minEvidenceTier = minEvidenceTier;
    next.set("minEvidenceTier", minEvidenceTier);
  }

  const maxAgeSec = single(query, "maxAgeSec");
  if (maxAgeSec !== undefined) {
    filter.maxAgeSec = nonNegativeInt(maxAgeSec, "maxAgeSec");
    next.set("maxAgeSec", maxAgeSec);
  }

  const afterRaw = single(query, "after");
  let after = OUTBOX_CURSOR_START;
  if (afterRaw !== undefined) {
    const cursor = decodeOutboxCursor(afterRaw);
    if (cursor === null) {
      throw new OutboxQueryError('after must be a "<txid>.<seq>" composite cursor');
    }
    after = cursor;
  }

  const limitRaw = single(query, "limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const parsed = nonNegativeInt(limitRaw, "limit");
    if (parsed < 1) throw new OutboxQueryError("limit must be at least 1");
    limit = Math.min(parsed, OUTBOX_MAX_LIMIT);
    next.set("limit", String(limit));
  }

  const nextParams = next.size > 0 ? next.toString() : undefined;
  return {
    after,
    ...(limit !== undefined ? { limit } : {}),
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(nextParams !== undefined ? { nextParams } : {}),
  };
}
