import { historyRowOf, type SeriesKey, seriesKeyOf, templateOf } from "@openconditions/core";
import {
  contentHash,
  historyEligible,
  jcs,
  type PropertyEntry,
  sealRecord,
} from "@openconditions/model";
import { type ColumnSpec, insertRows, type Sql, upsertClause } from "./bulk.js";
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
}

/** The poll an observation came from, for its raw-payload reference. */
export interface PollRef {
  fetchId?: number;
  payloadHashes?: readonly string[];
}

const SERIES_COLUMNS: ColumnSpec[] = [
  { name: "subject_key", type: "text" },
  { name: "property", type: "text" },
  { name: "qualifier_key", type: "text" },
  { name: "source_id", type: "text" },
  { name: "subject_kind", type: "text" },
  { name: "feature_id", type: "text" },
  { name: "component_key", type: "text" },
  { name: "situation_id", type: "text" },
  { name: "geom", type: "geometry", geometry: true },
  { name: "record", type: "jsonb" },
  { name: "template", type: "jsonb" },
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

const SERIES_KEY = ["subject_key", "property", "qualifier_key", "source_id"];

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

const keyString = (k: SeriesKey) => jcs([k.subjectKey, k.property, k.qualifierKey, k.sourceId]);

const startOf = (o: Rec) => {
  const t = o["phenomenonTime"] as { instant?: string; start?: string };
  return Date.parse((t.instant ?? t.start)!);
};

const sameResult = (a: unknown, b: unknown) => jcs(a) === jcs(b);

interface Latest {
  series_id: number;
  effective_from: Date;
  since_at: Date;
  result: unknown;
  content_hash: string;
  expires_at: Date | null;
}

/**
 * Writes one source's observations: each reading moves its series' latest
 * row when it is newer, and is kept as history as its property says — every
 * reading, only changes (`changeOnly`), or none (`latestOnly`, on-demand
 * rows). A reading identical to its series' latest is not written at all.
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
  const counts: ObservationCounts = { latest: 0, history: 0, unchanged: 0, outsideRetention: 0 };
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
              record = CASE WHEN n.expires_at IS NULL
                THEN l.record #- '{freshness,expiresAt}'
                ELSE jsonb_set(l.record, '{freshness,expiresAt}', to_jsonb(n.expires_at)) END
         FROM jsonb_to_recordset($1::text::jsonb) AS n(series_id bigint, expires_at text)
        WHERE l.series_id = n.series_id`,
      [JSON.stringify(expiryMoved)],
    );
  }

  const seriesRows: Rec[] = [];
  const history: { key: string; row: Rec }[] = [];
  for (const [k, { records }] of bySeries) {
    records.sort((a, b) => startOf(a) - startOf(b));
    const property = ctx.registry.property(records[0]!["property"] as string)!;
    const prev = latest.get(k);
    let result = prev?.result;
    let since = prev?.since_at.toISOString();
    let newest: Rec | undefined;
    const retentionDays = retentionDaysOf(property);
    for (const record of records) {
      const changed = result === undefined || !sameResult(result, record["result"]);
      const effective = effectiveFrom(record);
      if (changed) since = effective;
      if (prev === undefined || Date.parse(effective) > prev.effective_from.getTime()) {
        newest = { ...record, sinceAt: since };
      }
      if (
        retentionDays !== undefined &&
        historyEligible(record as unknown as Parameters<typeof historyEligible>[0]) &&
        (changed || !property.retention?.changeOnly)
      ) {
        if (partitionCovers(retentionDays, startOf(record), now)) {
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
    if (newest !== undefined)
      seriesRows.push(seriesRowOf(newest, property, retentionDays, ctx.now));
  }

  const written = await insertRows<{ series_id: number } & Record<string, string>>(
    tx,
    "observation_latest",
    SERIES_COLUMNS,
    seriesRows,
    upsertClause(SERIES_KEY, SERIES_COLUMNS),
    "series_id, subject_key, property, qualifier_key, source_id",
  );
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
  // One statement may not touch a row twice: a reading repeated in one poll keeps its last copy.
  const rows = new Map(
    history.map(({ key, row }) => [
      jcs([key, row["phenomenon_start"], row["issued_at"]]),
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

/** The latest row of a series, from the reading now in effect. */
function seriesRowOf(
  record: Rec,
  property: PropertyEntry,
  retentionDays: number | undefined,
  now: string,
): Rec {
  const key = seriesKeyOf(record);
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
    record,
    template: templateOf(record),
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

async function loadLatest(tx: Sql, keys: readonly SeriesKey[]): Promise<Map<string, Latest>> {
  if (keys.length === 0) return new Map();
  const rows = await tx.unsafe<(Latest & { k: SeriesKey })[]>(
    `SELECT l.series_id, l.effective_from, l.since_at, l.record->'result' AS result,
            l.record->>'contentHash' AS content_hash, l.expires_at,
            json_build_object('subjectKey', l.subject_key, 'property', l.property,
              'qualifierKey', l.qualifier_key, 'sourceId', l.source_id) AS k
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
  return new Map(rows.map((r) => [keyString(r.k), r]));
}
