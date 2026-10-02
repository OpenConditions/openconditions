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
