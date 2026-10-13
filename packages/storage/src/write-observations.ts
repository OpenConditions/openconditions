import {
  historyRowOf,
  readingOf,
  type SeriesKey,
  seriesKeyOf,
  templateHash,
  templateOf,
  validWhilePolled,
} from "@openconditions/core";
import {
  contentHash,
  historyEligible,
  jcs,
  type PropertyEntry,
  sealRecord,
  sha256Hex,
} from "@openconditions/model";
import { type ColumnSpec, insertRows, type Sql, updateRows, upsertClause } from "./bulk.js";
import { partitionCoverage, retentionDaysOf } from "./observation-partitions.js";
import { pause, RECORDS_PER_TURN } from "./pause.js";
import { expiryOf } from "./record-rows.js";
import { stepTimer } from "./steps.js";
import type { Rejection, WriteContext } from "./write-records.js";

type Rec = Record<string, unknown>;

export interface ObservationCounts {
  /** Readings that moved a series' latest row. */
  latest: number;
  /** Readings written to the history partitions. */
  history: number;
  /**
   * Readings their series already holds: identical, or for a polled feed's
   * change-only series a restated result or a state older than the one in effect.
   */
  unchanged: number;
  /** Readings not kept as history because their retention window or the look-ahead does not reach them. */
  outsideRetention: number;
  /**
   * Readings kept as history in a period their property's rollup has already
   * closed: they arrived after its lateness allowance and never reach it.
   */
  pastRollup: number;
  /** Polled change-only series a poll stating all of its source's readings did not state: ended now. */
  ended: number;
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
  { name: "contributor_receipt_id", type: "text" },
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

const creditProvenance = (record: Rec) => {
  const p = record["provenance"] as Rec;
  return { attribution: p["attribution"] ?? null, upstream: p["upstream"] ?? [] };
};

const sameResult = (a: unknown, b: unknown) => jcs(a) === jcs(b);

const withoutValidity = ({ validUntil: _validUntil, ...rest }: Rec): Rec => rest;

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
  credit_provenance: unknown;
  baseline: unknown;
  contributor_receipt_id: string | null;
  expires_at: Date | null;
  /** The reading states a `validUntil`: for a polled series, a complete poll ended it. */
  ended: boolean;
}

/** A reading of a transient property, with its property's entry. */
interface Transient {
  draft: Rec;
  property: PropertyEntry;
}

/** What a write learns from the rest of its poll. */
export interface ObservationWriteContext extends WriteContext, PollRef {
  /** Features this poll created or changed: a reading about one is written though its result held. */
  changedFeatures?: ReadonlySet<string>;
  /** Where the write's stages add their wall-clock ms, as `readings/<stage>`. */
  stepsMs?: Record<string, number>;
}

/**
 * Writes one source's observations: each reading moves its series' latest
 * row when it is newer (or corrects the reading in effect), and is kept as history as its property says — every
 * reading, only changes (`changeOnly`), or none (`latestOnly`, on-demand
 * rows, and readings about a component of a property that keeps no
 * component history). A reading identical to its series' latest is not
 * written at all, nor is a reading of a change-only property whose result
 * is the one in effect before it (its series' latest, or the poll's own
 * earlier reading): its series keeps its row and the time its result was
 * stated. A bulk feed's reading of a change-only property is stored without
 * its `validUntil`: it holds while its source polls (`withPolledValidity`,
 * when read). A history reading in a period the property's rollup has
 * already closed is counted (`pastRollup`).
 * A reading its series' retention window or the partition look-ahead does
 * not reach is counted and kept from history; it still updates the latest
 * row when it is the newest. `stage` says whether the inputs are drafts to
 * seal here or records another instance already sealed.
 * A reading of a transient property is appended apart from the rest
 * (`writeTransient`): its series is never compared with what is stored.
 */
export async function writeObservationsIn(
  tx: Sql,
  sourceId: string,
  drafts: readonly Rec[],
  ctx: ObservationWriteContext,
  rejected: Rejection[],
  stage: "draft" | "stored" = "draft",
): Promise<ObservationCounts> {
  const counts: ObservationCounts = {
    latest: 0,
    history: 0,
    unchanged: 0,
    outsideRetention: 0,
    pastRollup: 0,
    ended: 0,
  };
  if (drafts.length === 0) return counts;

  const lap = stepTimer(ctx.stepsMs);
  const pending = new Map<string, PendingSeries>();
  const transient = new Map<string, Transient>();
  let handled = 0;
  for (const input of drafts) {
    if (++handled % RECORDS_PER_TURN === 0) await pause();
    const id = typeof input["id"] === "string" ? input["id"] : undefined;
    try {
      if ((input["provenance"] as Rec | undefined)?.["sourceId"] !== sourceId) {
        throw new TypeError(`an observation draft of source ${sourceId} is expected`);
      }
      // Its source's polling, read with it, is how long such a reading holds.
      const draft =
        stage === "draft" &&
        input["validUntil"] !== undefined &&
        validWhilePolled(ctx.registry, input)
          ? withoutValidity(input)
          : input;
      const key = seriesKeyOf(draft);
      const k = keyString(key);
      const property = ctx.registry.property(key.property);
      if (property?.transient) {
        // One statement may not write a row twice: a poll's later reading of
        // a series stands for its earlier ones.
        const earlier = transient.get(k);
        if (earlier !== undefined) counts.unchanged++;
        if (earlier === undefined || startOf(draft) >= startOf(earlier.draft)) {
          transient.set(k, { draft, property });
        }
        continue;
      }
      const entry = pending.get(k) ?? { key, drafts: [] };
      entry.drafts.push(draft);
      pending.set(k, entry);
    } catch (err) {
      rejected.push({
        class: "observation",
        id,
        issues: [{ path: [], code: "custom", message: (err as Error).message }],
      });
    }
  }

  const frontiers = await rollupFrontiers(tx);
  lap("readings/group");
  const receipts = receiptCache();
  const write = { tx, ctx, rejected, stage, frontiers, counts, lap, receipts };
  let slice: [string, PendingSeries][] = [];
  for (const entry of pending) {
    slice.push(entry);
    if (slice.length === SERIES_PER_SLICE) {
      await writeSeries(write, slice);
      slice = [];
    }
  }
  if (slice.length > 0) await writeSeries(write, slice);
  await writeTransient(tx, [...transient.values()], ctx, counts, rejected, stage, receipts);
  lap("readings/transient");
  return counts;
}

/** One series of a write and the drafts of its readings. */
interface PendingSeries {
  key: SeriesKey;
  drafts: Rec[];
}

/**
 * Series a write compares and writes at a time. A poll of a large sensor
 * network holds hundreds of thousands of readings; sealed, compared with
 * their series and turned into rows all at once, they outgrow the heap.
 */
const SERIES_PER_SLICE = 1000;

/** Writes the readings of a slice of a write's series, keyed as `keyString` keys them. */
async function writeSeries(
  write: {
    tx: Sql;
    ctx: ObservationWriteContext;
    rejected: Rejection[];
    stage: "draft" | "stored";
    frontiers: Map<string, number>;
    counts: ObservationCounts;
    /** Ends the stage under way (`readings/<stage>`). */
    lap: (stage: string) => void;
    receipts: ReceiptCache;
  },
  slice: readonly (readonly [string, PendingSeries])[],
): Promise<void> {
  const { tx, ctx, rejected, stage, frontiers, counts, lap, receipts } = write;
  const now = Date.parse(ctx.now);
  const covers = partitionCoverage(now);
  const latest = await loadLatest(
    tx,
    slice.map(([, p]) => p.key),
  );
  lap("readings/lookup");
  const bySeries = new Map<string, { key: SeriesKey; records: Rec[] }>();
  const legacyAcquisitions: { row: Rec; provenance: Rec }[] = [];
  const expiryMoved = new Map<number, unknown>();
  let handled = 0;
  for (const [k, { key, drafts: series }] of slice) {
    const held = latest.get(k);
    // A polled feed's change-only series takes a reading only where its
    // result changes: one restating the result in effect before it, or one
    // older than the state in effect, is not written at all. A crowd report
    // is a claim of its own, an on-demand answer states its own lifetime.
    const first = series[0]!;
    const polled = validWhilePolled(ctx.registry, first);
    if (polled) series.sort((a, b) => startOf(a) - startOf(b));
    // A series a complete poll ended, or whose site this poll changed (moved,
    // credited anew), takes its reading again.
    const subject = first["subject"] as Rec;
    const renewed =
      polled &&
      held !== undefined &&
      (held.ended || ctx.changedFeatures?.has(subject["featureId"] as string) === true);
    let inEffect = renewed ? undefined : held?.result;
    let inEffectHash = renewed ? undefined : held?.content_hash;
    let inEffectAt = renewed ? -Infinity : (held?.effective_from.getTime() ?? -Infinity);
    let inEffectProvenance = renewed ? null : (held?.credit_provenance ?? null);
    let inEffectBaseline = renewed ? null : (held?.baseline ?? null);
    for (const draft of series) {
      if (++handled % RECORDS_PER_TURN === 0) await pause();
      const hash = contentHash(draft);
      // A peer's record that states a validity ends its series there: a change.
      const restated =
        polled &&
        inEffect !== undefined &&
        draft["validUntil"] === undefined &&
        sameResult(inEffect, draft["result"]) &&
        sameResult(inEffectProvenance, creditProvenance(draft)) &&
        sameResult(inEffectBaseline, draft["baseline"] ?? null);
      const superseded =
        polled && held !== undefined && !renewed && startOf(draft) < held.effective_from.getTime();
      if (inEffectHash === hash || restated || superseded) {
        counts.unchanged++;
        if (
          ctx.captureEvidence === "acquired" &&
          held !== undefined &&
          held.contributor_receipt_id === null &&
          !superseded
        ) {
          legacyAcquisitions.push({
            row: { series_id: held.series_id, content_hash: held.content_hash },
            provenance: draft["provenance"] as Rec,
          });
        }
        // A reading fetched again keeps its row; only the expiry its source now states moves.
        if (
          held !== undefined &&
          (held.content_hash === hash || inEffect === held.result) &&
          expiryOf(draft) !== (held.expires_at?.getTime() ?? null)
        ) {
          expiryMoved.set(
            held.series_id,
            (draft["freshness"] as Rec | undefined)?.["expiresAt"] ?? null,
          );
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
      // An older quantity reading belongs in history but cannot replace the
      // state in effect. Equal instants are corrections, in incoming order.
      if (startOf(draft) >= inEffectAt) {
        inEffect = draft["result"];
        inEffectHash = hash;
        inEffectAt = startOf(draft);
        inEffectProvenance = creditProvenance(sealed.value);
        inEffectBaseline = sealed.value["baseline"] ?? null;
      }
      const entry = bySeries.get(k) ?? { key, records: [] };
      entry.records.push(sealed.value);
      bySeries.set(k, entry);
    }
  }
  lap("readings/compare");

  await captureContributorReceipts(tx, legacyAcquisitions, ctx.now, receipts);
  if (legacyAcquisitions.length > 0)
    await tx.unsafe(
      `UPDATE conditions.observation_latest l SET contributor_receipt_id=r.contributor_receipt_id
       FROM jsonb_to_recordset($1::text::jsonb) AS r(series_id bigint,content_hash text,contributor_receipt_id text)
       WHERE l.series_id=r.series_id AND l.contributor_receipt_id IS NULL AND l.reading->>'contentHash'=r.content_hash`,
      [JSON.stringify(legacyAcquisitions.map((a) => a.row))],
    );

  if (expiryMoved.size > 0) {
    await tx.unsafe(
      `UPDATE conditions.observation_latest l
          SET expires_at = n.expires_at::timestamptz,
              reading = CASE WHEN n.expires_at IS NULL
                THEN l.reading #- '{freshness,expiresAt}'
                ELSE jsonb_set(l.reading, '{freshness,expiresAt}', to_jsonb(n.expires_at)) END
         FROM jsonb_to_recordset($1::text::jsonb) AS n(series_id bigint, expires_at text)
        WHERE l.series_id = n.series_id`,
      [
        JSON.stringify(
          [...expiryMoved].map(([series_id, expires_at]) => ({ series_id, expires_at })),
        ),
      ],
    );
  }
  lap("readings/restated");

  const acquisitions: { row: Rec; provenance: Rec }[] = [];
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
        if (covers(retentionDays, startOf(record))) {
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
      acquisitions.push({ row, provenance: newest["provenance"] as Rec });
      if (row["template"] === null) {
        row["series_id"] = prev!.series_id;
        readingRows.push(row);
        const record = newest;
        wholeRowOf.set(Number(prev!.series_id), () => ({
          ...seriesRowOf(record, property, retentionDays, ctx.now),
          contributor_receipt_id: row["contributor_receipt_id"],
        }));
      } else {
        seriesRows.push(row);
      }
    }
  }
  lap("readings/rows");

  await captureContributorReceipts(tx, acquisitions, ctx.now, receipts);
  lap("readings/receipts");

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
  counts.latest += written.length;
  lap("readings/latest");
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
  counts.history += stored.length;
  lap("readings/history");
}

/**
 * Appends readings of transient properties: each series holds one reading
 * of one instant (a satellite detection at a place), so nothing stored is
 * read to compare with. A series is created with its reading and its
 * history row; a reading its series already holds, or an older one, writes
 * nothing; a later reading of the same series (a detection at the very same
 * place) moves its row like any newer reading. A poll restating a day of
 * detections thus costs one insert per reading and no read of its source's
 * series.
 */
async function writeTransient(
  tx: Sql,
  readings: readonly Transient[],
  ctx: ObservationWriteContext,
  counts: ObservationCounts,
  rejected: Rejection[],
  stage: "draft" | "stored",
  receipts: ReceiptCache,
): Promise<void> {
  if (readings.length === 0) return;
  const now = Date.parse(ctx.now);
  const covers = partitionCoverage(now);
  const seriesRows: Rec[] = [];
  const acquisitions: { row: Rec; provenance: Rec }[] = [];
  const history = new Map<string, Rec>();
  let handled = 0;
  for (const { draft, property } of readings) {
    if (++handled % RECORDS_PER_TURN === 0) await pause();
    const sealed =
      stage === "stored"
        ? ctx.registry.validate(draft)
        : sealRecord(ctx.registry, draft, {
            instanceId: ctx.instanceId,
            revision: 1,
            recordedAt: ctx.now,
            contentHash: contentHash(draft),
          });
    if (!sealed.ok) {
      rejected.push({ class: "observation", id: draft["id"] as string, issues: sealed.issues });
      continue;
    }
    const record = sealed.value as unknown as Rec;
    const retentionDays = retentionDaysOf(property);
    const row = seriesRowOf(
      { ...record, sinceAt: effectiveFrom(record) },
      property,
      retentionDays,
      ctx.now,
    );
    seriesRows.push(row);
    acquisitions.push({ row, provenance: record["provenance"] as Rec });
    if (
      retentionDays === undefined ||
      !historyEligible(record as unknown as Parameters<typeof historyEligible>[0])
    ) {
      continue;
    }
    if (!covers(retentionDays, startOf(record))) {
      counts.outsideRetention++;
      continue;
    }
    history.set(keyString(seriesKeyOf(record)), {
      retention_days: retentionDays,
      ...historyRowOf(record, property.result, retentionDays > 0 ? ctx : {}),
    });
  }
  await captureContributorReceipts(tx, acquisitions, ctx.now, receipts);
  type Written = { series_id: number } & Record<
    "subject_key" | "property" | "qualifier_key" | "source_id",
    string
  >;
  const written = await insertRows<Written>(
    tx,
    "observation_latest",
    SERIES_COLUMNS,
    seriesRows,
    `${upsertClause(SERIES_KEY, SERIES_COLUMNS)}
       WHERE observation_latest.effective_from < excluded.effective_from`,
    "series_id, subject_key, property, qualifier_key, source_id",
  );
  if (ctx.captureEvidence === "acquired" && seriesRows.length > 0)
    await tx.unsafe(
      `UPDATE conditions.observation_latest l SET contributor_receipt_id=r.contributor_receipt_id
       FROM jsonb_to_recordset($1::text::jsonb) AS r(subject_key text,property text,qualifier_key text,source_id text,reading jsonb,contributor_receipt_id text)
       WHERE l.subject_key=r.subject_key AND l.property=r.property AND l.qualifier_key=r.qualifier_key AND l.source_id=r.source_id
         AND l.contributor_receipt_id IS NULL AND l.reading->>'contentHash'=r.reading->>'contentHash'`,
      [JSON.stringify(seriesRows)],
    );
  counts.latest += written.length;
  counts.unchanged += seriesRows.length - written.length;
  // Only a reading that wrote its series is new: one its series already
  // held has its history row.
  const rows = written.flatMap((w) => {
    const row = history.get(
      keyString({
        subjectKey: w.subject_key,
        property: w.property,
        qualifierKey: w.qualifier_key,
        sourceId: w.source_id,
      }),
    );
    return row === undefined ? [] : [{ ...row, series_id: Number(w.series_id) }];
  });
  const stored = await insertRows(
    tx,
    "observation",
    HISTORY_COLUMNS,
    rows,
    `ON CONFLICT (${HISTORY_KEY.join(", ")}) DO NOTHING`,
    "series_id",
  );
  counts.history += stored.length;
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
    contributor_receipt_id: null,
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

const LATEST_COLUMNS = `l.series_id, l.effective_from, l.since_at, l.reading->'result' AS result, l.reading->'baseline' AS baseline,
            l.reading->>'contentHash' AS content_hash, l.template_hash, l.expires_at, l.contributor_receipt_id,
            l.reading ? 'validUntil' AS ended,
            jsonb_build_object('attribution', l.template #> '{provenance,attribution}',
              'upstream', COALESCE(l.template #> '{provenance,upstream}', '[]'::jsonb)) AS credit_provenance,
            l.subject_key, l.property, l.qualifier_key, l.source_id`;

async function loadLatest(tx: Sql, keys: readonly SeriesKey[]): Promise<Map<string, Latest>> {
  if (keys.length === 0) return new Map();
  type Row = Latest & {
    subject_key: string;
    property: string;
    qualifier_key: string;
    source_id: string;
  };
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
  return new Map(
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
}

/** A polled series a complete poll ended: the subject and property whose fused rows it fed. */
export interface EndedSeries {
  featureId: string | null;
  property: string;
}

/**
 * Ends the polled change-only series of `sourceId` that a poll stating every
 * such reading of its source (`drafts`) did not state: a charge point taken
 * away, a site withdrawn, a point whose state is no longer published. Their
 * reading in effect takes `validUntil` = now, so the read stops extending it
 * by the source's polling, and fusion leaves it out. A later poll that states
 * the series again writes its reading anew. Only this instance's own series
 * end (a peer's copy of the source ends with the peer), and none does when
 * the poll states fewer than half of the series in effect.
 */
export async function endUnstatedSeries(
  tx: Sql,
  sourceId: string,
  drafts: readonly Rec[],
  ctx: Pick<WriteContext, "registry" | "now">,
): Promise<EndedSeries[]> {
  const stated = new Set<string>();
  let handled = 0;
  for (const draft of drafts) {
    if (++handled % RECORDS_PER_TURN === 0) await pause();
    // A draft the writer rejected as malformed states no series.
    let key: string;
    try {
      key = keyString(seriesKeyOf(draft));
    } catch {
      continue;
    }
    stated.add(key);
  }
  const changeOnly = ctx.registry
    .properties()
    .filter((p) => p.retention?.changeOnly)
    .map((p) => p.code);
  type Key = { series_id: string } & Record<"subject_key" | "property" | "qualifier_key", string>;
  // This instance's own polled series: a peer's copy of the source ends with the peer.
  const held = await tx.unsafe<Key[]>(
    `SELECT l.series_id::text AS series_id, l.subject_key, l.property, l.qualifier_key
       FROM conditions.observation_latest l
      WHERE l.source_id = $1 AND l.access_mode = 'bulk' AND l.property = ANY($2::text[])
        AND l.template #>> '{provenance,origin}' = 'feed' AND NOT (l.reading ? 'validUntil')
        AND jsonb_array_length(COALESCE(l.template #> '{provenance,originChain}', '[]'::jsonb)) = 0`,
    [sourceId, changeOnly],
  );
  const ending = held
    .filter(
      (r) =>
        !stated.has(
          keyString({
            subjectKey: r.subject_key,
            property: r.property,
            qualifierKey: r.qualifier_key,
            sourceId,
          }),
        ),
    )
    .map((r) => r.series_id);
  if (ending.length === 0) return [];
  // A poll stating fewer than half of the series it held is more likely an
  // empty or cut-off answer than half its points gone: it ends none of them.
  if (2 * (held.length - ending.length) < held.length) {
    console.warn(
      `[ingest] ${sourceId}: the poll states ${held.length - ending.length} of ${held.length} ` +
        "readings in effect; none is ended",
    );
    return [];
  }
  const rows = await tx.unsafe<
    { series_id: string; feature_id: string | null; property: string; record: Rec }[]
  >(
    `SELECT series_id::text AS series_id, feature_id, property,
            conditions.observation_record(template, reading) AS record
       FROM conditions.observation_latest WHERE series_id = ANY($1::bigint[])`,
    [ending],
  );
  const ended = rows.map(({ series_id, record }) => {
    const { contentHash: _hash, ...rest } = record;
    const next: Rec = { ...rest, validUntil: ctx.now, recordedAt: ctx.now };
    next["contentHash"] = contentHash(next);
    return { series_id, reading: readingOf(next) };
  });
  await updateRows(
    tx,
    "observation_latest",
    { name: "series_id", type: "bigint" },
    [
      { name: "reading", type: "jsonb" },
      { name: "effective_until", type: "timestamptz" },
      { name: "updated_at", type: "timestamptz" },
    ],
    ended.map((e) => ({ ...e, effective_until: ctx.now, updated_at: ctx.now })),
  );
  return rows.map((r) => ({ featureId: r.feature_id, property: r.property }));
}

/**
 * The contributor receipts one write has captured, by their descriptor's
 * canonical key, and each descriptor's key by its plain JSON. A poll's
 * readings share a few attributions: each is serialized canonically and
 * captured once per write, not once per reading or per slice.
 */
interface ReceiptCache {
  keys: Map<string, string>;
  ids: Map<string, string>;
}

const receiptCache = (): ReceiptCache => ({ keys: new Map(), ids: new Map() });

/** Capture once per distinct actual provenance in a write, outside canonical record bodies. */
async function captureContributorReceipts(
  tx: Sql,
  acquisitions: { row: Rec; provenance: Rec }[],
  now: string,
  cache: ReceiptCache,
): Promise<void> {
  if (acquisitions.length === 0) return;
  const inputs = new Map<string, { source_id: unknown; attribution: unknown }>();
  const keys = acquisitions.map(({ provenance }) => {
    const descriptor = {
      source_id: provenance["sourceId"],
      attribution: provenance["attribution"] ?? {},
    };
    const plain = JSON.stringify(descriptor);
    let key = cache.keys.get(plain);
    if (key === undefined) {
      key = jcs(descriptor);
      cache.keys.set(plain, key);
    }
    if (!cache.ids.has(key)) inputs.set(key, descriptor);
    return key;
  });
  const assign = () =>
    acquisitions.forEach(({ row }, i) => {
      row["contributor_receipt_id"] = cache.ids.get(keys[i]!);
    });
  if (inputs.size === 0) {
    assign();
    return;
  }
  const captured = await tx.unsafe<{ key: string; contributors: unknown }[]>(
    `SELECT r.key, conditions.flow_credit(r.source_id, r.attribution) AS contributors
       FROM jsonb_to_recordset($1::text::jsonb) AS r(key text, source_id text, attribution jsonb)`,
    [JSON.stringify([...inputs].map(([key, input]) => ({ key, ...input })))],
  );
  const receipts = captured.map(({ key, contributors }) => {
    const id = sha256Hex(jcs({ version: 1, contributors }));
    cache.ids.set(key, id);
    return { id, version: 1, contributors, created_at: now };
  });
  await insertRows(
    tx,
    "contributor_receipt",
    [
      { name: "id", type: "text" },
      { name: "version", type: "smallint" },
      { name: "contributors", type: "jsonb" },
      { name: "created_at", type: "timestamptz" },
    ],
    [...new Map(receipts.map((r) => [r.id, r])).values()],
    "ON CONFLICT (id) DO NOTHING",
    "id",
  );
  assign();
}
