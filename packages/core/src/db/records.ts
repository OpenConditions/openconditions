import type { Registry } from "@openconditions/model";
import type postgres from "postgres";
import { recordFromHistory, type SeriesKey } from "../observation-codec.js";
import type { RevisionedClass } from "./record-schema.js";

type Rec = Record<string, unknown>;

/** A stored record's materialised evidence, merged back as `evidence` (situations only). */
export function withEvidence(row: Rec): Rec {
  const record = row["record"] as Rec;
  if (row["evidence_state"] == null) return record;
  return {
    ...record,
    evidence: {
      state: row["evidence_state"],
      confidenceScore: row["confidence_score"],
      routingEligible: row["routing_eligible"],
      corroborations: row["corroborations"],
      ...(row["flagged_at"] != null
        ? { flaggedAt: (row["flagged_at"] as Date).toISOString() }
        : {}),
    },
  };
}

export const EVIDENCE: Record<RevisionedClass, string> = {
  situation: ", evidence_state, confidence_score, routing_eligible, corroborations, flagged_at",
  feature: "",
  offer: "",
};

/** `cls` is interpolated into SQL, so it must be one of the record tables. */
function assertRecordClass(cls: string): void {
  if (!Object.hasOwn(EVIDENCE, cls))
    throw new Error(`${JSON.stringify(cls)} is not a record class`);
}

/**
 * One stored record by id, tombstoned or not, as the record table holds it
 * (with its evidence summary when it has one); undefined when there is none.
 */
export async function readRecord(
  sql: postgres.Sql,
  cls: RevisionedClass,
  id: string,
): Promise<Rec | undefined> {
  assertRecordClass(cls);
  const [row] = await sql.unsafe<Rec[]>(
    `SELECT record${EVIDENCE[cls]} FROM conditions.${cls} WHERE id = $1`,
    [id],
  );
  return row === undefined ? undefined : withEvidence(row);
}

export interface Revision {
  revision: number;
  recordedAt: string;
  changeKinds: string[];
  record: Rec;
}

/** A record's revisions, oldest first: what changed and the record as it stood. */
export async function readRevisions(
  sql: postgres.Sql,
  cls: RevisionedClass,
  id: string,
): Promise<Revision[]> {
  assertRecordClass(cls);
  const rows = await sql.unsafe<
    { revision: number; recorded_at: Date; change_kinds: string[]; snapshot: Rec }[]
  >(
    `SELECT revision, recorded_at, change_kinds, snapshot FROM conditions.${cls}_revision
      WHERE ${cls}_id = $1 ORDER BY revision`,
    [id],
  );
  return rows.map((r) => ({
    revision: r.revision,
    recordedAt: r.recorded_at.toISOString(),
    changeKinds: r.change_kinds,
    record: r.snapshot,
  }));
}

type Runner = postgres.Sql | postgres.TransactionSql;

/**
 * Every live (not tombstoned) record of a class, with its evidence summary, a
 * page at a time in id order — the archive's read. Run it inside one
 * repeatable-read transaction for a consistent snapshot.
 */
export async function* scanRecords(
  sql: Runner,
  cls: RevisionedClass,
  opts: { pageSize?: number } = {},
): AsyncGenerator<Rec[]> {
  assertRecordClass(cls);
  const pageSize = opts.pageSize ?? 1000;
  let after = "";
  for (;;) {
    const rows = await sql.unsafe<Rec[]>(
      `SELECT id, record${EVIDENCE[cls]} FROM conditions.${cls}
        WHERE tombstoned_at IS NULL AND id > $1 ORDER BY id LIMIT $2`,
      [after, pageSize],
    );
    if (rows.length === 0) return;
    yield rows.map(withEvidence);
    if (rows.length < pageSize) return;
    after = rows[rows.length - 1]!["id"] as string;
  }
}

/** The latest reading of every series, a page at a time in series order — the archive's read. */
export async function* scanLatestObservations(
  sql: Runner,
  opts: { pageSize?: number } = {},
): AsyncGenerator<Rec[]> {
  const pageSize = opts.pageSize ?? 1000;
  let after = 0;
  for (;;) {
    const rows = await sql<{ series_id: string; record: Rec }[]>`
      SELECT series_id::text AS series_id, record FROM conditions.observation_latest
      WHERE series_id > ${after} ORDER BY series_id LIMIT ${pageSize}`;
    if (rows.length === 0) return;
    yield rows.map((r) => r.record);
    if (rows.length < pageSize) return;
    after = Number(rows[rows.length - 1]!.series_id);
  }
}

/** The reading of a series in effect now (with `sinceAt`), or undefined. */
export async function readLatestObservation(
  sql: postgres.Sql,
  key: SeriesKey,
): Promise<Rec | undefined> {
  const [row] = await sql<{ record: Rec }[]>`
    SELECT record FROM conditions.observation_latest
     WHERE subject_key = ${key.subjectKey} AND property = ${key.property}
       AND qualifier_key = ${key.qualifierKey} AND source_id = ${key.sourceId}`;
  return row?.record;
}

/**
 * A series' readings whose phenomenon starts in [from, to), oldest first,
 * each rebuilt as the stored observation it was written from.
 */
export async function readObservationHistory(
  sql: postgres.Sql,
  registry: Registry,
  key: SeriesKey,
  range: { from: string; to: string },
): Promise<Rec[]> {
  const rows = await sql<(Rec & { template: Rec; payload_hashes: string[] | null })[]>`
    SELECT o.*, l.template, a.payload_hashes
      FROM conditions.observation_latest l
      JOIN conditions.observation o ON o.series_id = l.series_id
      LEFT JOIN conditions.source_poll_attempt a ON a.id = o.fetch_id
     WHERE l.subject_key = ${key.subjectKey} AND l.property = ${key.property}
       AND l.qualifier_key = ${key.qualifierKey} AND l.source_id = ${key.sourceId}
       AND o.phenomenon_start >= ${range.from} AND o.phenomenon_start < ${range.to}
     ORDER BY o.phenomenon_start, o.issued_at`;
  return rows.map((row) =>
    recordFromHistory(registry, row.template, row, row.payload_hashes ?? []),
  );
}
