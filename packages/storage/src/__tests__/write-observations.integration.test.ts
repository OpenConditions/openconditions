import { recordFromHistory, recordOf } from "@openconditions/core";
import { contentHash, observationId } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { type WriteContext, writeSnapshot, writeSnapshotIn } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { FETCHED_AT, observationDraft } from "./drafts.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const NOW = "2026-10-01T10:00:05.000Z";
const ctx: WriteContext = { registry, instanceId: "test.local", now: NOW, complete: true };

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.observation_latest CASCADE`;
  await sql`TRUNCATE conditions.observation`;
});

const speed = (value: number, at: string) =>
  observationDraft(
    "traffic.speed",
    { type: "quantity", value, unit: "km/h" },
    { at, aggregation: "mean" },
  );
const los = (value: string, at: string) =>
  observationDraft("traffic.los", { type: "category", value, vocabulary: "los" }, { at });

const observationIdOf = (draft: Record<string, unknown>) =>
  observationId("nl-ndw-flow", draft as Parameters<typeof observationId>[1]);

async function history() {
  return sql`SELECT retention_days, phenomenon_start, value_num, value_text
    FROM conditions.observation ORDER BY phenomenon_start`;
}

describe("observation writes", () => {
  it("start a series with its latest reading and keep the reading as history", async () => {
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    expect(summary.observations).toEqual({
      latest: 1,
      history: 1,
      unchanged: 0,
      outsideRetention: 0,
      pastRollup: 0,
    });
    const [latest] = await sql`
      SELECT subject_key, property, qualifier_key, source_id, subject_kind, feature_id,
        result_type, value_num, unit, effective_from, since_at, retention_days, access_mode,
        ST_AsText(geom) AS geom
      FROM conditions.observation_latest`;
    expect(latest).toEqual({
      subject_key: "feature:oc:feature:nl-ndw-flow:s1",
      property: "traffic.speed",
      qualifier_key: "",
      source_id: "nl-ndw-flow",
      subject_kind: "feature",
      feature_id: "oc:feature:nl-ndw-flow:s1",
      result_type: "quantity",
      value_num: 87,
      unit: "km/h",
      effective_from: new Date("2026-10-01T10:00:00Z"),
      since_at: new Date("2026-10-01T10:00:00Z"),
      retention_days: 2,
      access_mode: "bulk",
      geom: "POINT(4.536069 52.0235558)",
    });
    expect(await history()).toEqual([
      {
        retention_days: 2,
        phenomenon_start: new Date("2026-10-01T10:00:00Z"),
        value_num: 87,
        value_text: null,
      },
    ]);
  });

  it("write nothing for a reading the series already holds", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const again = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    expect(again.observations).toEqual({
      latest: 0,
      history: 0,
      unchanged: 1,
      outsideRetention: 0,
      pastRollup: 0,
    });
  });

  it("move the latest row only for a newer reading, and keep a late one as history", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(80, "2026-10-01T10:01:00Z")] },
      ctx,
    );
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(60, "2026-10-01T10:00:00Z"), speed(70, "2026-10-01T10:02:00Z")] },
      ctx,
    );
    const [latest] = await sql`SELECT value_num, effective_from FROM conditions.observation_latest`;
    expect(latest).toEqual({ value_num: 70, effective_from: new Date("2026-10-01T10:02:00Z") });
    expect((await history()).map((r) => r["value_num"])).toEqual([60, 80, 70]);
  });

  it("replace the reading in effect with a correction of the same instant", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(80, "2026-10-01T10:01:00Z")] },
      ctx,
    );
    const corrected = {
      ...speed(80, "2026-10-01T10:01:00Z"),
      baseline: { freeFlow: { value: 100, unit: "km/h" }, source: "derived", ratio: 0.8 },
    };
    const summary = await writeSnapshot(sql, "nl-ndw-flow", { observations: [corrected] }, ctx);
    expect(summary.observations).toMatchObject({ latest: 1, history: 1 });
    const [latest] = await sql`SELECT reading #>> '{baseline,source}' AS source
      FROM conditions.observation_latest`;
    expect(latest).toEqual({ source: "derived" });
  });

  it("rewrite nothing for an older reading a later poll sends again", async () => {
    const poll = (fetchedAt: string) =>
      [speed(60, "2026-10-01T10:00:00Z"), speed(70, "2026-10-01T10:02:00Z")].map((d) => ({
        ...d,
        freshness: { fetchedAt },
      }));
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: poll("2026-10-01T10:02:30.000Z") },
      ctx,
    );
    const before = await sql`SELECT xmin::text AS xmin, value_num FROM conditions.observation
      ORDER BY phenomenon_start`;
    const again = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: poll("2026-10-01T10:03:30.000Z") },
      { ...ctx, now: "2026-10-01T10:03:35.000Z" },
    );
    expect(again.observations).toMatchObject({ latest: 0, history: 0 });
    const after = await sql`SELECT xmin::text AS xmin, value_num FROM conditions.observation
      ORDER BY phenomenon_start`;
    expect(after).toEqual(before);

    const corrected = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [{ ...speed(65, "2026-10-01T10:00:00Z"), freshness: { fetchedAt: NOW } }] },
      ctx,
    );
    expect(corrected.observations.history).toBe(1);
    expect((await history()).map((r) => r["value_num"])).toEqual([65, 70]);
  });

  it("keep only changes of a change-only property, and when the value last changed", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [
          los("free_flow", "2026-10-01T10:00:00Z"),
          los("free_flow", "2026-10-01T10:01:00Z"),
          los("queuing", "2026-10-01T10:02:00Z"),
        ],
      },
      ctx,
    );
    expect((await history()).map((r) => [r["retention_days"], r["value_text"]])).toEqual([
      [7, "free_flow"],
      [7, "queuing"],
    ]);
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [los("queuing", "2026-10-01T10:03:00Z")] },
      ctx,
    );
    const [latest] =
      await sql`SELECT value_text, effective_from, since_at FROM conditions.observation_latest`;
    expect(latest).toEqual({
      value_text: "queuing",
      effective_from: new Date("2026-10-01T10:03:00Z"),
      since_at: new Date("2026-10-01T10:02:00Z"),
    });
    expect(await history()).toHaveLength(2);
  });

  it("keep no history row for a price a later poll restates at a new publication time", async () => {
    const product = {
      kind: "feature",
      featureId: "oc:feature:es-minetur-fuel:42",
      componentKey: "e5",
    };
    const price = (amount: string, at: string) =>
      observationDraft(
        "fuel.price",
        { type: "money", amount, currency: "EUR", per: "L" },
        { at, subject: product, sourceId: "es-minetur-fuel" },
      );
    const poll = (amount: string, at: string) =>
      writeSnapshot(sql, "es-minetur-fuel", { observations: [price(amount, at)] }, ctx);
    await poll("1.649", "2026-10-01T09:00:00Z");
    const restated = await poll("1.649", "2026-10-01T09:30:00Z");
    expect(restated.observations).toMatchObject({ latest: 1, history: 0 });
    const [latest] =
      await sql`SELECT value_text, effective_from, since_at FROM conditions.observation_latest`;
    expect(latest).toMatchObject({
      effective_from: new Date("2026-10-01T09:30:00Z"),
      since_at: new Date("2026-10-01T09:00:00Z"),
    });
    await poll("1.659", "2026-10-01T10:00:00Z");
    expect((await history()).map((r) => r["phenomenon_start"])).toEqual([
      new Date("2026-10-01T09:00:00Z"),
      new Date("2026-10-01T10:00:00Z"),
    ]);
  });

  it("keep no history of a latest-only property or of an on-demand reading", async () => {
    const image = observationDraft(
      "camera.image",
      {
        type: "structured",
        schema: "camera_image",
        v: 1,
        value: { v: 1, status: "online", imageUrl: "https://cams.example/1.jpg" },
      },
      { subject: { kind: "feature", featureId: "oc:feature:nl-ndw-flow:cam1" } },
    );
    const onDemand = speed(55, "2026-10-01T10:00:00Z");
    onDemand["provenance"] = { ...(onDemand["provenance"] as object), accessMode: "on_demand" };
    onDemand["freshness"] = { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" };
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [image, onDemand] },
      ctx,
    );
    expect(summary.rejected).toEqual([]);
    expect(summary.observations).toMatchObject({ latest: 2, history: 0 });
    const rows =
      await sql`SELECT property, access_mode, expires_at FROM conditions.observation_latest
      ORDER BY property`;
    expect(rows).toEqual([
      { property: "camera.image", access_mode: "bulk", expires_at: null },
      {
        property: "traffic.speed",
        access_mode: "on_demand",
        expires_at: new Date("2026-10-01T10:15:00Z"),
      },
    ]);
  });

  it("keep an on-demand reading until the expiry its latest fetch states", async () => {
    const answer = (expiresAt: string) => {
      const reading = speed(55, "2026-10-01T10:00:00Z");
      reading["provenance"] = { ...(reading["provenance"] as object), accessMode: "on_demand" };
      reading["freshness"] = { fetchedAt: FETCHED_AT, expiresAt };
      return reading;
    };
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [answer("2026-10-01T10:15:00Z")] },
      ctx,
    );
    const again = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [answer("2026-10-01T10:20:00Z")] },
      ctx,
    );
    expect(again.observations).toMatchObject({ unchanged: 1, latest: 0 });
    const [row] = await sql`SELECT expires_at, reading #>> '{freshness,expiresAt}' AS stated
      FROM conditions.observation_latest`;
    expect(row).toEqual({
      expires_at: new Date("2026-10-01T10:20:00Z"),
      stated: "2026-10-01T10:20:00Z",
    });
  });

  it("count a reading its retention window no longer reaches, yet move the latest row", async () => {
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(40, "2026-09-20T10:00:00Z")] },
      ctx,
    );
    expect(summary.observations).toEqual({
      latest: 1,
      history: 0,
      unchanged: 0,
      outsideRetention: 1,
      pastRollup: 0,
    });
  });

  it("read every history row back as the record it was written from, its times in UTC", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const [series] = await sql`SELECT template,
      conditions.observation_record(template, reading) AS record FROM conditions.observation_latest`;
    const [row] = await sql`SELECT * FROM conditions.observation`;
    const { sinceAt: _since, ...stored } = series!["record"] as Record<string, unknown>;
    const back = recordFromHistory(registry, series!["template"], row!);
    // The id treats two spellings of one instant as one point; the history keeps the instant.
    expect(back["phenomenonTime"]).toEqual({ instant: "2026-10-01T10:00:00.000Z" });
    expect(back["id"]).toBe(stored["id"]);
    const { phenomenonTime: _a, contentHash: _b, ...rest } = back;
    const { phenomenonTime: _c, contentHash: _d, ...storedRest } = stored;
    expect(rest).toEqual(storedRest);
    expect(back["contentHash"]).toBe(contentHash(back));
  });

  it("keep the reading in effect compact, rebuilt the same in SQL and in code", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(91, "2026-10-01T10:01:00Z")] },
      ctx,
    );
    const [row] = await sql<
      { reading: Record<string, unknown>; template: Record<string, unknown>; record: unknown }[]
    >`SELECT reading, template, conditions.observation_record(template, reading) AS record
        FROM conditions.observation_latest`;
    expect(row!.reading).not.toHaveProperty("location");
    expect(row!.reading).not.toHaveProperty("subject");
    expect(row!.reading["result"]).toEqual({ type: "quantity", value: 91, unit: "km/h" });
    expect(row!.record).toEqual(recordOf(row!.template, row!.reading));
    expect((row!.record as Record<string, unknown>)["location"]).toEqual(
      speed(91, "2026-10-01T10:01:00Z")["location"],
    );
  });

  it("move a feed series' reading without touching an index", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const hot = async () =>
      (
        await sql`SELECT n_tup_hot_upd::int AS n FROM pg_stat_user_tables
                   WHERE relname = 'observation_latest'`
      )[0]!["n"] as number;
    await sql`SELECT pg_stat_force_next_flush()`;
    const before = await hot();
    for (const [value, at] of [
      [88, "2026-10-01T10:01:00Z"],
      [89, "2026-10-01T10:02:00Z"],
    ] as const) {
      await writeSnapshot(sql, "nl-ndw-flow", { observations: [speed(value, at)] }, ctx);
    }
    await sql`SELECT pg_stat_force_next_flush()`;
    // A flow source moves tens of thousands of readings a minute: an update
    // that changed an indexed value would rewrite every index of the table.
    expect((await hot()) - before).toBe(2);
  });

  it("rewrite a series' template when the site it describes moved", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const moved = { type: "Point", coordinates: [4.6, 52.1] };
    const draft = speed(91, "2026-10-01T10:01:00Z");
    const relocated: Record<string, unknown> = {
      ...draft,
      location: { ...(draft["location"] as object), geometry: moved },
    };
    relocated["id"] = observationIdOf(relocated);
    const [before] = await sql`SELECT template_hash FROM conditions.observation_latest`;
    await writeSnapshot(sql, "nl-ndw-flow", { observations: [relocated] }, ctx);
    const [after] = await sql`
      SELECT template_hash, template #> '{location,geometry}' AS geometry
        FROM conditions.observation_latest`;
    expect(after!["template_hash"]).not.toBe(before!["template_hash"]);
    expect(after!["geometry"]).toEqual(moved);
  });

  it("keep one history row for a reading a poll repeats", async () => {
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(60, "2026-10-01T10:00:00Z"), speed(61, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    expect(summary.rejected).toEqual([]);
    expect((await history()).map((r) => r["value_num"])).toEqual([61]);
  });

  it("keep one history row for a reading a poll repeats under another spelling of its instant", async () => {
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [speed(60, "2026-10-01T10:00:00Z"), speed(61, "2026-10-01T12:00:00+02:00")],
      },
      ctx,
    );
    expect(summary.rejected).toEqual([]);
    expect((await history()).map((r) => r["value_num"])).toEqual([61]);
  });

  it("set a series' result type from the registry when only its reading moves", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    // Written under a registry that declared the property otherwise.
    await sql`UPDATE conditions.observation_latest SET result_type = 'count'`;
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(88, "2026-10-01T10:01:00Z")] },
      ctx,
    );
    const [row] = await sql`SELECT result_type, value_num FROM conditions.observation_latest`;
    expect(row).toEqual({ result_type: "quantity", value_num: 88 });
  });

  it("write the series again when its latest row went away while the poll was writing", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const summary = await sql.begin(async (tx) => {
      // Another session removes the row between the poll reading it and moving its reading.
      const racing = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "unsafe") return value;
          return (query: string, params?: unknown[]) => {
            const result = (value as typeof tx.unsafe).call(target, query, params as never);
            if (!query.includes("JOIN jsonb_to_recordset")) return result;
            return result.then(async (rows: unknown) => {
              await db.sql`DELETE FROM conditions.observation_latest`;
              return rows;
            });
          };
        },
      });
      return writeSnapshotIn(
        racing,
        "nl-ndw-flow",
        { observations: [speed(88, "2026-10-01T10:01:00Z")] },
        ctx,
      );
    });
    expect(summary.observations).toMatchObject({ latest: 1, history: 1 });
    const rows = await sql`
      SELECT l.value_num, l.template IS NOT NULL AS has_template,
             (SELECT count(*)::int FROM conditions.observation o
               WHERE o.series_id = l.series_id) AS history
        FROM conditions.observation_latest l`;
    expect(rows).toEqual([{ value_num: 88, has_template: true, history: 1 }]);
  });

  it("count a forecast beyond the partitions' look-ahead instead of failing the poll", async () => {
    const far = observationDraft(
      "road.condition_forecast",
      { type: "category", value: "ice", vocabulary: "surface_state" },
      {
        subject: { kind: "location" },
        temporality: "forecast",
        phenomenonTime: { start: "2026-11-20T03:00:00.000Z", end: "2026-11-20T06:00:00.000Z" },
        forecast: { issuedAt: "2026-10-01T09:00:00.000Z", leadTime: { value: 4300000, unit: "s" } },
        location: {
          geometry: null,
          extent: "area",
          geometryOrigin: "none",
          fuzziness: "exact",
          admin: { country: "FI", geocodes: [{ scheme: "nuts", code: "FI1B" }] },
        },
      },
    );
    const summary = await writeSnapshot(sql, "nl-ndw-flow", { observations: [far] }, ctx);
    expect(summary.observations).toMatchObject({ latest: 1, history: 0, outsideRetention: 1 });
  });

  it("keep no history of a reading about a component when the property keeps none", async () => {
    const lane = (value: number, at: string) => ({
      ...speed(value, at),
      subject: { kind: "feature", featureId: "oc:feature:nl-ndw-flow:s1", componentKey: "lane1" },
    });
    const drafts = [lane(80, "2026-10-01T10:00:00Z"), lane(81, "2026-10-01T10:01:00Z")].map(
      (d) => ({ ...d, id: observationIdOf(d) }),
    );
    const summary = await writeSnapshot(sql, "nl-ndw-flow", { observations: drafts }, ctx);
    expect(summary.rejected).toEqual([]);
    expect(summary.observations).toMatchObject({ latest: 1, history: 0, outsideRetention: 0 });
    const [latest] = await sql`SELECT subject_key, value_num FROM conditions.observation_latest`;
    expect(latest).toEqual({
      subject_key: "feature:oc:feature:nl-ndw-flow:s1#lane1",
      value_num: 81,
    });
    expect(await history()).toEqual([]);
  });

  it("count readings the rollup has already passed, and keep them as history", async () => {
    await sql`INSERT INTO conditions.observation_rollup_progress (period, finalized_before)
      VALUES ('hourly', '2026-10-01T10:00:00Z')`;
    try {
      const summary = await writeSnapshot(
        sql,
        "nl-ndw-flow",
        {
          observations: [
            speed(50, "2026-10-01T09:59:00Z"),
            speed(51, "2026-10-01T10:00:00Z"),
            los("queuing", "2026-10-01T09:30:00Z"),
          ],
        },
        ctx,
      );
      expect(summary.observations).toMatchObject({ history: 3, pastRollup: 1 });
    } finally {
      await sql`DELETE FROM conditions.observation_rollup_progress`;
    }
  });

  it("refuse a poll holding more readings than a source may publish", async () => {
    await expect(
      writeSnapshot(
        sql,
        "nl-ndw-flow",
        {
          observations: [
            speed(50, "2026-10-01T09:58:00Z"),
            speed(51, "2026-10-01T09:59:00Z"),
            speed(52, "2026-10-01T10:00:00Z"),
          ],
        },
        { ...ctx, maxObservationsPerPoll: 2 },
      ),
    ).rejects.toThrow(/3 observation rows, exceeding publication limit 2/);
    expect(await history()).toEqual([]);
  });

  it("are capped apart from records: more readings than records a poll may hold still land", async () => {
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [
          speed(50, "2026-10-01T09:58:00Z"),
          speed(51, "2026-10-01T09:59:00Z"),
          speed(52, "2026-10-01T10:00:00Z"),
        ],
      },
      { ...ctx, maxRowsPerClass: 2 },
    );
    expect(summary.observations.history).toBe(3);
  });

  it("reject a reading of another source without losing the rest", async () => {
    const foreign = observationDraft(
      "traffic.speed",
      { type: "quantity", value: 1, unit: "km/h" },
      { sourceId: "be-miv-flow" },
    );
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [foreign, speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    expect(summary.rejected.map((r) => r.class)).toEqual(["observation"]);
    expect(summary.observations.latest).toBe(1);
  });
});
