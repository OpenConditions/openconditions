/**
 * Query-string parsing for GET /peer/outbox. Fail-closed: any malformed
 * parameter is a {@link OutboxQueryError} (the route answers 400) rather than
 * a silently-widened filter. Also rebuilds the validated filter parameters as
 * an encoded query-string so the page's `next` link preserves the
 * subscriber's filter across pagination.
 */
import {
  EVIDENCE_TIERS,
  OUTBOX_CURSOR_START,
  OUTBOX_MAX_LIMIT,
  decodeOutboxCursor,
  type FederationFilter,
  type OutboxCursor,
} from "@openconditions/federation";

export class OutboxQueryError extends Error {}

export interface ParsedOutboxQuery {
  after: OutboxCursor;
  limit?: number;
  filter?: FederationFilter;
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

export function parseOutboxQuery(query: Record<string, unknown>): ParsedOutboxQuery {
  const filter: FederationFilter = {};
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

  const types = single(query, "types");
  if (types !== undefined) {
    const list = types.split(",").filter((t) => t.length > 0);
    if (list.length === 0) throw new OutboxQueryError("types must be a comma-separated list");
    filter.types = list;
    next.set("types", types);
  }

  const privacyClasses = single(query, "privacyClasses");
  if (privacyClasses !== undefined) {
    const list = privacyClasses.split(",").filter((c) => c.length > 0);
    if (list.length === 0) {
      throw new OutboxQueryError("privacyClasses must be a comma-separated list");
    }
    filter.privacyClasses = list;
    next.set("privacyClasses", privacyClasses);
  }

  const permissiveOnly = single(query, "permissiveOnly");
  if (permissiveOnly !== undefined) {
    if (permissiveOnly !== "true" && permissiveOnly !== "false") {
      throw new OutboxQueryError("permissiveOnly must be true or false");
    }
    filter.permissiveOnly = permissiveOnly === "true";
    next.set("permissiveOnly", permissiveOnly);
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
