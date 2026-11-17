/**
 * Query-string parsing for GET /peer/outbox, /peer/backfill and /peer/state
 * (whose filter parameters are the same). Fail-closed:
 * any malformed or unknown parameter is a {@link OutboxQueryError} (the route
 * answers 400) rather than a silently-widened filter. Also rebuilds the
 * validated filter parameters as an encoded query-string so the page's `next`
 * link preserves the subscriber's filter across pagination.
 */
import {
  decodeOutboxCursor,
  EVIDENCE_TIERS,
  isRecordStateClass,
  OUTBOX_CURSOR_START,
  OUTBOX_MAX_LIMIT,
  type OutboxCursor,
  RECORD_FILTER_KEYS,
  RECORD_ID_MAX_BYTES,
  RECORD_STATE_CLASSES,
  RECORD_STATE_PAGE_LIMIT,
  type RecordFilter,
  type RecordStateClass,
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

/** The parameters a query may carry: the filter's, the cursor and the page size. */
const KNOWN_PARAMETERS: ReadonlySet<string> = new Set([...RECORD_FILTER_KEYS, "after", "limit"]);

export function parseOutboxQuery(query: Record<string, unknown>): ParsedOutboxQuery {
  // An unknown parameter is refused: ignoring a misspelt or newer filter would
  // serve more than the subscriber asked for.
  const unknown = Object.keys(query).find((name) => !KNOWN_PARAMETERS.has(name));
  if (unknown !== undefined) {
    throw new OutboxQueryError(`${unknown} is not a parameter this instance knows`);
  }

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

  const sourceLiveness = single(query, "sourceLiveness");
  if (sourceLiveness !== undefined) {
    if (sourceLiveness !== "true" && sourceLiveness !== "false") {
      throw new OutboxQueryError("sourceLiveness must be true or false");
    }
    if (sourceLiveness === "true") {
      filter.sourceLiveness = true;
      next.set("sourceLiveness", "true");
    }
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

export interface ParsedStateQuery {
  cls: RecordStateClass;
  /** The record id the listing continues after; absent from the start. */
  after?: string;
  limit?: number;
  filter?: RecordFilter;
  /** Encoded filter and limit params for the `next` link (no `class`, no `after`). */
  nextParams?: string;
}

/**
 * The query of GET /peer/state: the record `class` (a class the state routes
 * answer for), the record id to continue `after`, a `limit` of rows to scan,
 * and the filter parameters a journal read takes, parsed by the same rules.
 */
export function parseStateQuery(query: Record<string, unknown>): ParsedStateQuery {
  const { class: cls, after, limit: limitRaw, ...filterQuery } = query;
  if (!isRecordStateClass(cls)) {
    throw new OutboxQueryError(`class must be one of ${RECORD_STATE_CLASSES.join(", ")}`);
  }
  if (
    after !== undefined &&
    (typeof after !== "string" ||
      after.length === 0 ||
      Buffer.byteLength(after, "utf8") > RECORD_ID_MAX_BYTES)
  ) {
    throw new OutboxQueryError(`after must be a record id of at most ${RECORD_ID_MAX_BYTES} bytes`);
  }
  const parsed = parseOutboxQuery(filterQuery);
  const next = new URLSearchParams(parsed.nextParams);
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== "string") throw new OutboxQueryError("invalid limit");
    const value = nonNegativeInt(limitRaw, "limit");
    if (value < 1) throw new OutboxQueryError("limit must be at least 1");
    limit = Math.min(value, RECORD_STATE_PAGE_LIMIT);
    next.set("limit", String(limit));
  }
  const nextParams = next.size > 0 ? next.toString() : undefined;
  return {
    cls,
    ...(after !== undefined ? { after: after as string } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
    ...(nextParams !== undefined ? { nextParams } : {}),
  };
}
