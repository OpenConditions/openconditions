import type { QueryRunner } from "./query-runner.js";
import { binder, type RecordFilters, recordFilterClauses } from "./record-filters.js";

type Rec = Record<string, unknown>;

export interface OfferQuery extends RecordFilters {
  /**
   * The instant offers are current at: not tombstoned, not past their expiry,
   * their validity not ended. Default now.
   */
  at?: Date;
  /** Only offers starting within this many days after `at`. */
  horizonDays?: number;
  /** The last id of the previous page. */
  cursor?: string;
  limit: number;
}

export interface OfferPage {
  records: Rec[];
  /** The cursor of the next page; null when this page is the last. */
  next: string | null;
}

/**
 * The live offers matching `q`, one keyset page ordered by id. Each page is
 * one statement, so a walk never returns an offer twice and never skips one
 * that exists throughout it.
 */
export async function listOffers(db: QueryRunner, q: OfferQuery): Promise<OfferPage> {
  const params: unknown[] = [(q.at ?? new Date()).toISOString()];
  const p = binder(params);
  const clauses = [
    "o.tombstoned_at IS NULL",
    "(o.expires_at IS NULL OR o.expires_at > $1::timestamptz)",
    "(o.valid_to IS NULL OR o.valid_to > $1::timestamptz)",
    ...recordFilterClauses("o", q, p),
  ];
  if (q.horizonDays !== undefined) {
    clauses.push(
      `(o.valid_from IS NULL OR o.valid_from <= $1::timestamptz + make_interval(days => ${p(q.horizonDays)}))`,
    );
  }
  if (q.cursor !== undefined) clauses.push(`o.id > ${p(q.cursor)}`);
  const rows = await db.execute<{ id: string; record: Rec }[]>(
    `SELECT o.id, o.record FROM conditions.offer o
      WHERE ${clauses.join(" AND ")}
      ORDER BY o.id
      LIMIT ${p(q.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  return {
    records: page.map((r) => r.record),
    next: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}
