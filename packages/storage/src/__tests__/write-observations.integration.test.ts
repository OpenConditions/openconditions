import { recordFromHistory } from "@openconditions/core";
import { contentHash } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { type WriteContext, writeSnapshot } from "../write-records.js";
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
      retention_days: 7,
      access_mode: "bulk",
      geom: "POINT(4.536069 52.0235558)",
    });
    expect(await history()).toEqual([
      {
        retention_days: 7,
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
      [0, "free_flow"],
      [0, "queuing"],
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
    const [row] = await sql`SELECT expires_at, record #>> '{freshness,expiresAt}' AS stated
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
    });
  });

  it("read every history row back as the record it was written from, its times in UTC", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const [series] = await sql`SELECT template, record FROM conditions.observation_latest`;
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

  it("reject a reading of another source without losing the rest", async () => {
    const foreign = observationDraft(
      "traffic.speed",
      { type: "quantity", value: 1, unit: "km/h" },
      { sourceId: "be-miv" },
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
