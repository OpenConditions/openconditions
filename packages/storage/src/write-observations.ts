import {
  historyRowOf,
  readingOf,
  type SeriesKey,
  seriesKeyOf,
  templateHash,
  templateOf,
} from "@openconditions/core";
import {
  contentHash,
  historyEligible,
  jcs,
  type PropertyEntry,
  sealRecord,
} from "@openconditions/model";
import { type ColumnSpec, insertRows, type Sql, updateRows, upsertClause } from "./bulk.js";
import { partitionCovers, retentionDaysOf } from "./observation-partitions.js";
import { expiryOf } from "./record-rows.js";
import type { Rejection, WriteContext } from "./write-records.js";

type Rec = Record<string, unknown>;

export interface ObservationCounts {
  /** Readings that moved a series' latest row. */
  latest: number;
  /** Readings written to the history partitions. */
  history: number;
  /** Readings identical to what their series already holds. */
  unchanged: number;
  /** Readings not kept as history because their retention window or the look-ahead does not reach them. */
  outsideRetention: number;
  /**
   * Readings kept as history in a period their property's rollup has already
   * closed: they arrived after its lateness allowance and never reach it.
   */
  pastRollup: number;
}

/** The poll an observation came from, for its raw-payload reference. */
export interface PollRef {
  fetchId?: number;
  payloadHashes?: readonly string[];
}

export const SERIES_COLUMNS: ColumnSpec[] = [
  { name: "subject_key", type: "text" },
  { name: "property", type: "text" },
  { name: "qualifier_key", type: "text" },
  { name: "source_id", type: "text" },
  { name: "subject_kind", type: "text" },
  { name: "feature_id", type: "text" },
  { name: "component_key", type: "text" },
  { name: "situation_id", type: "text" },
  { name: "geom", type: "geometry", geometry: true },
  { name: "reading", type: "jsonb" },
  { name: "template", type: "jsonb" },
  { name: "template_hash", type: "text" },
  { name: "crowd_record_id", type: "text" },
  { name: "access_mode", type: "text" },
  { name: "result_type", type: "text" },
  { name: "value_num", type: "double precision" },
  { name: "value_money", type: "numeric" },
  { name: "value_text", type: "text" },
  { name: "unit", type: "text" },
  { name: "currency", type: "text" },
  { name: "effective_from", type: "timestamptz" },
  { name: "effective_until", type: "timestamptz" },
  { name: "since_at", type: "timestamptz" },
  { name: "expires_at", type: "timestamptz" },
  { name: "retention_days", type: "smallint" },
  { name: "updated_at", type: "timestamptz" },
];

export const SERIES_KEY = ["subject_key", "property", "qualifier_key", "source_id"];

/**
 * What a latest row's update sets when its series template did not change:
 * what a reading can change. The template stays as stored, out of line, and
 * the update carries only its pointer; what the template determines (the
 * subject, its geometry, the access mode) stays as it is. The result type is
 * the registry's, not the template's, so it is set with the reading.
 */
const TEMPLATE_DETERMINED = new Set([
  ...SERIES_KEY,
  "template",
  "template_hash",
  "subject_kind",
  "feature_id",
  "component_key",
  "situation_id",
  "geom",
  "access_mode",
]);
const READING_COLUMNS_OF_LATEST = SERIES_COLUMNS.filter((c) => !TEMPLATE_DETERMINED.has(c.name));

const HISTORY_COLUMNS: ColumnSpec[] = [
  { name: "series_id", type: "bigint" },
  { name: "retention_days", type: "smallint" },
  { name: "phenomenon_start", type: "timestamptz" },
  { name: "phenomenon_end", type: "timestamptz" },
  { name: "issued_at", type: "timestamptz" },
  { name: "result_time", type: "timestamptz" },
  { name: "valid_until", type: "timestamptz" },
  { name: "fetched_at", type: "timestamptz" },
  { name: "recorded_at", type: "timestamptz" },
  { name: "temporality", type: "text" },
  { name: "aggregation", type: "text" },
  { name: "value_num", type: "double precision" },
  { name: "value_money", type: "numeric" },
  { name: "value_text", type: "text" },
  { name: "value_json", type: "jsonb" },
  { name: "quality", type: "jsonb" },
  { name: "baseline", type: "jsonb" },
  { name: "fetch_id", type: "bigint" },
  { name: "raw_part", type: "smallint" },
  { name: "extra", type: "jsonb" },
];

const HISTORY_KEY = ["series_id", "phenomenon_start", "issued_at", "retention_days"];

// A map key within one write: none of the four parts holds a NUL.
const keyString = (k: SeriesKey) =>
  `${k.subjectKey}\u0000${k.property}\u0000${k.qualifierKey}\u0000${k.sourceId}`;

const startOf = (o: Rec) => {
  const t = o["phenomenonTime"] as { instant?: string; start?: string };
  return Date.parse((t.instant ?? t.start)!);
};

const sameResult = (a: unknown, b: unknown) => jcs(a) === jcs(b);

/** An instant as the database compares it; `-infinity` (no issue time) as it is. */
const instantKey = (t: unknown) => {
  const ms = Date.parse(t as string);
  return Number.isNaN(ms) ? t : ms;
};

interface Latest {
  series_id: number;
  effective_from: Date;
  since_at: Date;
  result: unknown;
  content_hash: string;
  template_hash: string;
  expires_at: Date | null;
}

/**
 * Writes one source's observations: each reading moves its series' latest
 * row when it is newer (or corrects the reading in effect), and is kept as history as its property says — every
 * reading, only changes (`changeOnly`), or none (`latestOnly`, on-demand
 * rows, and readings about a component of a property that keeps no
 * component history). A reading identical to its series' latest is not
 * written at all. A history reading in a period the property's rollup has
 * already closed is counted (`pastRollup`).
 * A reading its series' retention window or the partition look-ahead does
 * not reach is counted and kept from history; it still updates the latest
 * row when it is the newest. `stage` says whether the inputs are drafts to
 * seal here or records another instance already sealed.
 */
export async function writeObservationsIn(
  tx: Sql,
  sourceId: string,
  drafts: readonly Rec[],
  ctx: WriteContext & PollRef,
  rejected: Rejection[],
  stage: "draft" | "stored" = "draft",
): Promise<ObservationCounts> {
  const counts: ObservationCounts = {
    latest: 0,
    history: 0,
    unchanged: 0,
    outsideRetention: 0,
    pastRollup: 0,
  };
  if (drafts.length === 0) return counts;
  const now = Date.parse(ctx.now);

  const keyed: { draft: Rec; key: SeriesKey; hash: string }[] = [];
  for (const draft of drafts) {
    const id = typeof draft["id"] === "string" ? draft["id"] : undefined;
    try {
      if ((draft["provenance"] as Rec | undefined)?.["sourceId"] !== sourceId) {
        throw new TypeError(`an observation draft of source ${sourceId} is expected`);
      }
      keyed.push({ draft, key: seriesKeyOf(draft), hash: contentHash(draft) });
    } catch (err) {
      rejected.push({
        class: "observation",
        id,
        issues: [{ path: [], code: "custom", message: (err as Error).message }],
      });
    }
  }

  const latest = await loadLatest(
    tx,
    sourceId,
    keyed.map((k) => k.key),
  );
  const bySeries = new Map<string, { key: SeriesKey; records: Rec[] }>();
  const expiryMoved: { series_id: number; expires_at: unknown }[] = [];
  for (const { draft, key, hash } of keyed) {
    const held = latest.get(keyString(key));
    if (held?.content_hash === hash) {
      counts.unchanged++;
      if (expiryOf(draft) !== (held.expires_at?.getTime() ?? null)) {
        expiryMoved.push({
          series_id: held.series_id,
          expires_at: (draft["freshness"] as Rec | undefined)?.["expiresAt"] ?? null,
        });
      }
      continue;
    }
    // A stored observation (a peer's) was sealed by its own instance and is kept as it is.
    const sealed =
      stage === "stored"
        ? ctx.registry.validate(draft)
        : sealRecord(ctx.registry, draft, {
            instanceId: ctx.instanceId,
            revision: 1,
            recordedAt: ctx.now,
            contentHash: hash,
          });
    if (!sealed.ok) {
      rejected.push({ class: "observation", id: draft["id"] as string, issues: sealed.issues });
      continue;
    }
    const entry = bySeries.get(keyString(key)) ?? { key, records: [] };
    entry.records.push(sealed.value);
    bySeries.set(keyString(key), entry);
  }

  // A reading fetched again keeps its row; only the expiry its source now states moves.
  if (expiryMoved.length > 0) {
    await tx.unsafe(
      `UPDATE conditions.observation_latest l
          SET expires_at = n.expires_at::timestamptz,
              reading = CASE WHEN n.expires_at IS NULL
                THEN l.reading #- '{freshness,expiresAt}'
                ELSE jsonb_set(l.reading, '{freshness,expiresAt}', to_jsonb(n.expires_at)) END
         FROM jsonb_to_recordset($1::text::jsonb) AS n(series_id bigint, expires_at text)
        WHERE l.series_id = n.series_id`,
      [JSON.stringify(expiryMoved)],
    );
  }

  const frontiers = await rollupFrontiers(tx);
  const seriesRows: Rec[] = [];
  const readingRows: Rec[] = [];
  // The whole row of a series written by its reading alone, should its row have gone.
  const wholeRowOf = new Map<number, () => Rec>();
  const history: { key: string; row: Rec }[] = [];
  for (const [k, { records }] of bySeries) {
    records.sort((a, b) => startOf(a) - startOf(b));
    const property = ctx.registry.property(records[0]!["property"] as string)!;
    const prev = latest.get(k);
    let result = prev?.result;
    let since = prev?.since_at.toISOString();
    let newest: Rec | undefined;
    // A lane's or a vehicle class's readings of a property that keeps no
    // component history move the latest row only: the site's own series
    // carries the history, at a fraction of the rows.
    const component = (records[0]!["subject"] as Rec)["componentKey"] !== undefined;
    const retentionDays =
      component && property.retention?.componentHistory === false
        ? undefined
        : retentionDaysOf(property);
    const rollupPeriod = property.retention?.rollup?.period;
    const frontier = rollupPeriod === undefined ? undefined : frontiers.get(rollupPeriod);
    for (const record of records) {
      const changed = result === undefined || !sameResult(result, record["result"]);
      const effective = effectiveFrom(record);
      if (changed) since = effective;
      // A changed reading of the instant in effect is a correction of it (a
      // baseline applied later, a source revising its value): it replaces it.
      if (prev === undefined || Date.parse(effective) >= prev.effective_from.getTime()) {
        newest = { ...record, sinceAt: since };
      }
      if (
        retentionDays !== undefined &&
        historyEligible(record as unknown as Parameters<typeof historyEligible>[0]) &&
        (changed || !property.retention?.changeOnly)
      ) {
        if (partitionCovers(retentionDays, startOf(record), now)) {
          if (frontier !== undefined && startOf(record) < frontier) counts.pastRollup++;
          history.push({
            key: k,
            row: {
              retention_days: retentionDays,
              // Poll attempts outlive finite history only; a keep-everything row
              // keeps its payload hash itself.
              ...historyRowOf(record, property.result, retentionDays > 0 ? ctx : {}),
            },
          });
        } else {
          counts.outsideRetention++;
        }
      }
      result = record["result"];
    }
    if (newest !== undefined) {
      const row = seriesRowOf(newest, property, retentionDays, ctx.now, prev?.template_hash);
      if (row["template"] === null) {
        readingRows.push({ ...row, series_id: prev!.series_id });
        const record = newest;
        wholeRowOf.set(Number(prev!.series_id), () =>
          seriesRowOf(record, property, retentionDays, ctx.now),
        );
      } else {
        seriesRows.push(row);
      }
    }
  }

  const returning = "series_id, subject_key, property, qualifier_key, source_id";
  type Written = { series_id: number } & Record<string, string>;
  const upsert = (rows: readonly Rec[]) =>
    insertRows<Written>(
      tx,
      "observation_latest",
      SERIES_COLUMNS,
      rows,
      upsertClause(SERIES_KEY, SERIES_COLUMNS),
      returning,
    );
  // A series whose template did not change: only its reading moves.
  const moved = await updateRows<Written>(
    tx,
    "observation_latest",
    { name: "series_id", type: "bigint" },
    READING_COLUMNS_OF_LATEST,
    readingRows,
    returning,
  );
  // A row removed since it was read (an operator, a purge) has nothing to
  // move: its series is written whole again, under a new series id.
  const movedIds = new Set(moved.map((w) => Number(w.series_id)));
  const gone = readingRows
    .map((r) => Number(r["series_id"]))
    .filter((id) => !movedIds.has(id))
    .map((id) => wholeRowOf.get(id)!());
  const written = [...(await upsert([...seriesRows, ...gone])), ...moved];
  counts.latest = written.length;
  const ids = new Map([...latest].map(([k, l]) => [k, l.series_id]));
  for (const w of written) {
    ids.set(
      keyString({
        subjectKey: w["subject_key"]!,
        property: w["property"]!,
        qualifierKey: w["qualifier_key"]!,
        sourceId: w["source_id"]!,
      }),
      Number(w.series_id),
    );
  }
  // One statement may not touch a row twice: a reading repeated in one poll
  // keeps its last copy, however its source spelled the instants.
  const rows = new Map(
    history.map(({ key, row }) => [
      jcs([key, instantKey(row["phenomenon_start"]), instantKey(row["issued_at"])]),
      { ...row, series_id: ids.get(key) },
    ]),
  );
  const stored = await insertRows(
    tx,
    "observation",
    HISTORY_COLUMNS,
    [...rows.values()],
    `${upsertClause(HISTORY_KEY, HISTORY_COLUMNS)} WHERE ${HISTORY_CHANGED}`,
    "series_id",
  );
  counts.history = stored.length;
  return counts;
}

/**
 * Whether a history row a poll sends again says something new. When and in
 * which poll it was fetched does not count, nor where its payload is kept:
 * a reading a feed re-sends unchanged is left as it is.
 */
const READING_COLUMNS = [
  "phenomenon_end",
  "result_time",
  "valid_until",
  "temporality",
  "aggregation",
  "value_num",
  "value_money",
  "value_text",
  "value_json",
  "quality",
  "baseline",
];
const reading = (table: string) =>
  `(${READING_COLUMNS.map((c) => `${table}.${c}`).join(", ")},
    (${table}.extra #- '{provenance,rawRef}'::text[]) - 'freshness'::text)`;
const HISTORY_CHANGED = `${reading("observation")} IS DISTINCT FROM ${reading("excluded")}`;

function effectiveFrom(record: Rec): string {
  const t = record["phenomenonTime"] as { instant?: string; start?: string };
  return new Date((t.instant ?? t.start)!).toISOString();
}

/**
 * The latest row of a series, from the reading now in effect. Its template
 * is left out (null) when `storedTemplateHash` says the row already holds it.
 */
export function seriesRowOf(
  record: Rec,
  property: PropertyEntry,
  retentionDays: number | undefined,
  now: string,
  storedTemplateHash?: string,
): Rec {
  const key = seriesKeyOf(record);
  const template = templateOf(record);
  const hash = templateHash(template);
  const subject = record["subject"] as Rec;
  const result = record["result"] as Rec;
  const time = record["phenomenonTime"] as { end?: string };
  const type = result["type"] as string;
  return {
    subject_key: key.subjectKey,
    property: key.property,
    qualifier_key: key.qualifierKey,
    source_id: key.sourceId,
    subject_kind: subject["kind"],
    feature_id: subject["featureId"] ?? null,
    component_key: subject["componentKey"] ?? null,
    situation_id: subject["situationId"] ?? null,
    geom: (record["location"] as Rec)["geometry"] ?? null,
    reading: readingOf(record),
    template: hash === storedTemplateHash ? null : template,
    template_hash: hash,
    crowd_record_id: key.sourceId === "crowd" ? record["id"] : null,
    access_mode: (record["provenance"] as Rec)["accessMode"],
    result_type: property.result.type,
    value_num: type === "quantity" || type === "count" ? result["value"] : null,
    value_money: type === "money" ? result["amount"] : null,
    value_text:
      type === "category" ? result["value"] : type === "boolean" ? String(result["value"]) : null,
    unit: (result["unit"] as string | undefined) ?? (result["per"] as string | undefined) ?? null,
    currency: (result["currency"] as string | undefined) ?? null,
    effective_from: effectiveFrom(record),
    effective_until: time.end ?? record["validUntil"] ?? null,
    since_at: record["sinceAt"],
    expires_at: (record["freshness"] as Rec)["expiresAt"] ?? null,
    retention_days: retentionDays ?? null,
    updated_at: now,
  };
}

/** How far each rollup period has finalized, in ms since the epoch. */
async function rollupFrontiers(tx: Sql): Promise<Map<string, number>> {
  const rows = await tx<{ period: string; finalized_before: Date }[]>`
    SELECT period, finalized_before FROM conditions.observation_rollup_progress`;
  return new Map(rows.map((r) => [r.period, r.finalized_before.getTime()]));
}

/** Readings in one write above which comparing with all of the source's series is cheaper. */
const WHOLE_SOURCE_ABOVE = 1000;

const LATEST_COLUMNS = `l.series_id, l.effective_from, l.since_at, l.reading->'result' AS result,
            l.reading->>'contentHash' AS content_hash, l.template_hash, l.expires_at,
            l.subject_key, l.property, l.qualifier_key, l.source_id`;

async function loadLatest(
  tx: Sql,
  sourceId: string,
  keys: readonly SeriesKey[],
): Promise<Map<string, Latest>> {
  if (keys.length === 0) return new Map();
  type Row = Latest & {
    subject_key: string;
    property: string;
    qualifier_key: string;
    source_id: string;
  };
  const byKey = (rows: readonly Row[]) =>
    new Map(
      rows.map((r) => [
        keyString({
          subjectKey: r.subject_key,
          property: r.property,
          qualifierKey: r.qualifier_key,
          sourceId: r.source_id,
        }),
        r,
      ]),
    );
  // A poll writes most of its source's series: reading them all by source is
  // one index scan, where matching each key costs a join over every key.
  if (keys.length > WHOLE_SOURCE_ABOVE) {
    return byKey(
      await tx.unsafe<Row[]>(
        `SELECT ${LATEST_COLUMNS} FROM conditions.observation_latest l WHERE l.source_id = $1`,
        [sourceId],
      ),
    );
  }
  const rows = await tx.unsafe<Row[]>(
    `SELECT ${LATEST_COLUMNS}
       FROM conditions.observation_latest l
       JOIN jsonb_to_recordset($1::text::jsonb)
         AS r(subject_key text, property text, qualifier_key text, source_id text)
         USING (subject_key, property, qualifier_key, source_id)`,
    [
      JSON.stringify(
        keys.map((k) => ({
          subject_key: k.subjectKey,
          property: k.property,
          qualifier_key: k.qualifierKey,
          source_id: k.sourceId,
        })),
      ),
    ],
  );
  return byKey(rows);
}
