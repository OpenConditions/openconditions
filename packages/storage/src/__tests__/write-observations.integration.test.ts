import { recordFromHistory, recordOf } from "@openconditions/core";
import { contentHash, observationId, sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { writeRecord } from "../write-record.js";
import { type WriteContext, writeSnapshot, writeSnapshotIn } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { FETCHED_AT, featureDraft, firePixel, observationDraft } from "./drafts.js";

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
      ended: 0,
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
      ended: 0,
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
    const again = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [los("queuing", "2026-10-01T10:03:00Z")] },
      ctx,
    );
    expect(again.observations).toMatchObject({ latest: 0, history: 0, unchanged: 1 });
    const [latest] =
      await sql`SELECT value_text, effective_from, since_at FROM conditions.observation_latest`;
    expect(latest).toEqual({
      value_text: "queuing",
      effective_from: new Date("2026-10-01T10:02:00Z"),
      since_at: new Date("2026-10-01T10:02:00Z"),
    });
    expect(await history()).toHaveLength(2);
  });

  it("leave a change-only series untouched by a reading of the result it holds", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [los("queuing", "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const before = await sql`SELECT * FROM conditions.observation_latest`;
    const again = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [los("queuing", "2026-10-01T10:05:00Z")] },
      { ...ctx, now: "2026-10-01T10:05:05.000Z" },
    );
    expect(again.observations).toEqual({
      latest: 0,
      history: 0,
      unchanged: 1,
      outsideRetention: 0,
      pastRollup: 0,
      ended: 0,
    });
    expect(await sql`SELECT * FROM conditions.observation_latest`).toEqual(before);
    expect(await history()).toHaveLength(1);
    const changed = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [los("free_flow", "2026-10-01T10:10:00Z")] },
      ctx,
    );
    expect(changed.observations).toMatchObject({ latest: 1, history: 1, unchanged: 0 });
    const [latest] =
      await sql`SELECT value_text, effective_from, since_at FROM conditions.observation_latest`;
    expect(latest).toEqual({
      value_text: "free_flow",
      effective_from: new Date("2026-10-01T10:10:00Z"),
      since_at: new Date("2026-10-01T10:10:00Z"),
    });
  });

  it("weigh a change-only reading against the result in effect before it, in one poll too", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [los("queuing", "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const poll = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [
          los("free_flow", "2026-10-01T10:05:00Z"),
          los("free_flow", "2026-10-01T10:06:00Z"),
          los("queuing", "2026-10-01T10:07:00Z"),
        ],
      },
      ctx,
    );
    expect(poll.observations).toMatchObject({ latest: 1, history: 2, unchanged: 1 });
    const [latest] =
      await sql`SELECT value_text, effective_from, since_at FROM conditions.observation_latest`;
    expect(latest).toEqual({
      value_text: "queuing",
      effective_from: new Date("2026-10-01T10:07:00Z"),
      since_at: new Date("2026-10-01T10:07:00Z"),
    });
    expect((await history()).map((r) => r["value_text"])).toEqual([
      "queuing",
      "free_flow",
      "queuing",
    ]);
  });

  it("write every reading of a property that keeps more than changes", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:00:00Z")] },
      ctx,
    );
    const again = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [speed(87, "2026-10-01T10:01:00Z")] },
      ctx,
    );
    expect(again.observations).toMatchObject({ latest: 1, history: 1, unchanged: 0 });
    const [latest] = await sql`SELECT effective_from FROM conditions.observation_latest`;
    expect(latest).toEqual({ effective_from: new Date("2026-10-01T10:01:00Z") });
  });

  it("store no validity of a feed's change-only reading, and keep any other's", async () => {
    const until = "2026-10-01T10:30:00.000Z";
    const elsewhere = observationDraft(
      "traffic.los",
      { type: "category", value: "queuing", vocabulary: "los" },
      {
        at: "2026-10-01T10:00:00Z",
        subject: { kind: "feature", featureId: "oc:feature:nl-ndw-flow:s2" },
      },
    );
    const onDemand = {
      ...elsewhere,
      provenance: { ...(elsewhere["provenance"] as object), accessMode: "on_demand" },
      freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" },
      validUntil: until,
    };
    const summary = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        observations: [
          { ...los("queuing", "2026-10-01T10:00:00Z"), validUntil: until },
          { ...speed(87, "2026-10-01T10:00:00Z"), validUntil: until },
          onDemand,
        ],
      },
      ctx,
    );
    expect(summary.rejected).toEqual([]);
    const rows = await sql`
      SELECT property, access_mode, conditions.observation_record(template, reading) ->> 'validUntil' AS valid_until
        FROM conditions.observation_latest ORDER BY property, access_mode`;
    expect(rows).toEqual([
      { property: "traffic.los", access_mode: "bulk", valid_until: null },
      { property: "traffic.los", access_mode: "on_demand", valid_until: until },
      { property: "traffic.speed", access_mode: "bulk", valid_until: until },
    ]);
    const kept = await sql`SELECT valid_until FROM conditions.observation
      WHERE value_text = 'queuing' ORDER BY valid_until NULLS FIRST`;
    expect(kept.map((r) => r["valid_until"])).toEqual([null]);
  });

  it("move an on-demand answer's validity when it restates the result", async () => {
    const answer = (validUntil: string, expiresAt: string) => ({
      ...los("queuing", "2026-10-01T10:00:00Z"),
      provenance: {
        ...(los("queuing", "2026-10-01T10:00:00Z")["provenance"] as object),
        accessMode: "on_demand",
      },
      freshness: { fetchedAt: FETCHED_AT, expiresAt },
      validUntil,
    });
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [answer("2026-10-01T10:30:00.000Z", "2026-10-01T10:15:00.000Z")] },
      ctx,
    );
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [answer("2026-10-01T11:00:00.000Z", "2026-10-01T10:45:00.000Z")] },
      ctx,
    );
    const [row] = await sql`
      SELECT conditions.observation_record(template, reading) ->> 'validUntil' AS valid_until,
             expires_at FROM conditions.observation_latest`;
    expect(row).toEqual({
      valid_until: "2026-10-01T11:00:00.000Z",
      expires_at: new Date("2026-10-01T10:45:00.000Z"),
    });
  });

  it("write the series again when a restated change-only reading's site changed", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { features: [featureDraft("s1")], observations: [los("queuing", "2026-10-01T10:00:00Z")] },
      { ...ctx, complete: false },
    );
    const location = {
      geometry: { type: "Point", coordinates: [4.6, 52.1] },
      extent: "point",
      geometryOrigin: "site_table",
      fuzziness: "exact",
    };
    // The full parse moves the site and its reading with it; the state is unchanged.
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      {
        features: [featureDraft("s1", 2, { location })],
        observations: [{ ...los("queuing", "2026-10-01T10:00:00Z"), location }],
      },
      { ...ctx, complete: false },
    );
    const [row] = await sql`
      SELECT ST_AsText(geom) AS geom, effective_from FROM conditions.observation_latest`;
    expect(row).toEqual({
      geom: "POINT(4.6 52.1)",
      effective_from: new Date("2026-10-01T10:00:00Z"),
    });
    expect(await history()).toHaveLength(1);
  });

  it("take no feed state older than the one in effect into a change-only series", async () => {
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [los("queuing", "2026-10-01T10:10:00Z")] },
      ctx,
    );
    const late = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [los("free_flow", "2026-10-01T10:05:00Z")] },
      ctx,
    );
    expect(late.observations).toMatchObject({ latest: 0, history: 0, unchanged: 1 });
    expect((await history()).map((r) => r["value_text"])).toEqual(["queuing"]);
  });

  describe("a poll that states every change-only reading of its source", () => {
    const at = (site: string, value: string, time: string) =>
      observationDraft(
        "traffic.los",
        { type: "category", value, vocabulary: "los" },
        { at: time, subject: { kind: "feature", featureId: `oc:feature:nl-ndw-flow:${site}` } },
      );
    const complete = { ...ctx, complete: false, statesComplete: true };
    const validity = async () =>
      Object.fromEntries(
        (
          await sql<{ feature_id: string; valid_until: string | null }[]>`
            SELECT feature_id,
                   conditions.observation_record(template, reading) ->> 'validUntil' AS valid_until
              FROM conditions.observation_latest ORDER BY feature_id`
        ).map((r) => [r.feature_id.split(":").at(-1), r.valid_until]),
      );

    it("ends the series it does not state, and only such a poll does", async () => {
      await writeSnapshot(
        sql,
        "nl-ndw-flow",
        {
          observations: [
            at("s1", "queuing", "2026-10-01T09:00:00Z"),
            at("s2", "free_flow", "2026-10-01T09:00:00Z"),
          ],
        },
        complete,
      );
      // A partial poll stating s1 alone ends nothing.
      await writeSnapshot(
        sql,
        "nl-ndw-flow",
        { observations: [at("s1", "queuing", "2026-10-01T09:30:00Z")] },
        ctx,
      );
      expect(await validity()).toEqual({ s1: null, s2: null });
      const summary = await writeSnapshot(
        sql,
        "nl-ndw-flow",
        { observations: [at("s1", "queuing", "2026-10-01T09:30:00Z")] },
        complete,
      );
      expect(summary.observations).toMatchObject({ unchanged: 1, ended: 1 });
      expect(await validity()).toEqual({ s1: null, s2: NOW });
      // Stated again, with the same result: it holds again.
      const back = await writeSnapshot(
        sql,
        "nl-ndw-flow",
        {
          observations: [
            at("s1", "queuing", "2026-10-01T09:30:00Z"),
            at("s2", "free_flow", "2026-10-01T09:00:00Z"),
          ],
        },
        complete,
      );
      expect(back.observations).toMatchObject({ ended: 0 });
      expect(await validity()).toEqual({ s1: null, s2: null });
    });

    it("ends nothing when it states fewer than half of the series it held", async () => {
      await writeSnapshot(
        sql,
        "nl-ndw-flow",
        {
          observations: ["s1", "s2", "s3"].map((s) => at(s, "queuing", "2026-10-01T09:00:00Z")),
        },
        complete,
      );
      // An empty or cut-off status answer: one state of three.
      const cut = await writeSnapshot(
        sql,
        "nl-ndw-flow",
        { observations: [at("s1", "queuing", "2026-10-01T09:00:00Z")] },
        complete,
      );
      expect(cut.observations.ended).toBe(0);
      expect(await validity()).toEqual({ s1: null, s2: null, s3: null });
    });

    it("ends only this instance's polled series, and passes over a malformed draft", async () => {
      const onDemand = {
        ...at("s2", "queuing", "2026-10-01T09:00:00Z"),
        provenance: {
          ...(at("s2", "queuing", "2026-10-01T09:00:00Z")["provenance"] as object),
          accessMode: "on_demand",
        },
        freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T12:00:00Z" },
        validUntil: "2026-10-01T12:00:00.000Z",
      };
      await writeSnapshot(
        sql,
        "nl-ndw-flow",
        { observations: [at("s1", "queuing", "2026-10-01T09:00:00Z"), onDemand] },
        complete,
      );
      // A peer's copy of the same source id, as the federation inbox writes it.
      const sealed = sealRecord(registry, at("s3", "free_flow", "2026-10-01T09:00:00Z"), {
        instanceId: "peer.example",
        revision: 1,
        recordedAt: FETCHED_AT,
      });
      if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
      const peer = {
        ...sealed.value,
        provenance: {
          ...(sealed.value["provenance"] as object),
          originChain: [
            { instanceId: "peer.example", viaPeer: "peer.example", receivedAt: FETCHED_AT },
          ],
        },
      };
      const landed = await writeRecord(
        sql,
        { stored: peer },
        { registry, instanceId: "test.local", now: NOW },
      );
      expect(landed.status).not.toBe("rejected");
      const summary = await writeSnapshot(
        sql,
        "nl-ndw-flow",
        {
          observations: [
            at("s1", "queuing", "2026-10-01T09:00:00Z"),
            { ...at("s9", "queuing", "2026-10-01T09:00:00Z"), subject: undefined },
          ],
        },
        complete,
      );
      expect(summary.observations.ended).toBe(0);
      expect(await validity()).toEqual({
        s1: null,
        s2: "2026-10-01T12:00:00.000Z",
        s3: null,
      });
    });
  });

  it("rewrite nothing for a price a later poll restates at a new publication time", async () => {
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
    expect(restated.observations).toMatchObject({ latest: 0, history: 0, unchanged: 1 });
    const [latest] =
      await sql`SELECT value_text, effective_from, since_at FROM conditions.observation_latest`;
    expect(latest).toMatchObject({
      effective_from: new Date("2026-10-01T09:00:00Z"),
      since_at: new Date("2026-10-01T09:00:00Z"),
    });
    await poll("1.659", "2026-10-01T10:00:00Z");
    expect((await history()).map((r) => r["phenomenon_start"])).toEqual([
      new Date("2026-10-01T09:00:00Z"),
      new Date("2026-10-01T10:00:00Z"),
    ]);
  });

  it("keep no history of an on-demand reading", async () => {
    const onDemand = speed(55, "2026-10-01T10:00:00Z");
    onDemand["provenance"] = { ...(onDemand["provenance"] as object), accessMode: "on_demand" };
    onDemand["freshness"] = { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T10:15:00Z" };
    const summary = await writeSnapshot(sql, "nl-ndw-flow", { observations: [onDemand] }, ctx);
    expect(summary.rejected).toEqual([]);
    expect(summary.observations).toMatchObject({ latest: 1, history: 0 });
    const rows =
      await sql`SELECT property, access_mode, expires_at FROM conditions.observation_latest
      ORDER BY property`;
    expect(rows).toEqual([
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
      ended: 0,
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

  it("keep one row per camera view and skip an unchanged image, with no history", async () => {
    const view = (key: string, imageUrl: string) => {
      const d = observationDraft(
        "camera.image",
        {
          type: "structured",
          schema: "camera_image",
          v: 1,
          value: { v: 1, status: "unknown", imageUrl },
        },
        {
          at: "2026-10-01T10:00:00Z",
          subject: { kind: "feature", featureId: "oc:feature:nl-ndw-flow:cam1", componentKey: key },
        },
      );
      return { ...d, id: observationIdOf(d) };
    };
    const first = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [view("0", "https://cams.example/1.jpg")] },
      ctx,
    );
    expect(first.rejected).toEqual([]);
    expect(first.observations).toMatchObject({ latest: 1, history: 0 });
    const again = await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [view("0", "https://cams.example/1.jpg")] },
      { ...ctx, now: "2026-10-01T10:30:00.000Z" },
    );
    expect(again.observations).toMatchObject({ latest: 0, history: 0, unchanged: 1 });
    const rows = await sql`SELECT subject_key FROM conditions.observation_latest`;
    expect(rows).toEqual([{ subject_key: "feature:oc:feature:nl-ndw-flow:cam1#0" }]);
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

describe("transient readings", () => {
  const FIRMS = "nasa-firms-viirs-fires";
  const pixels = async () =>
    (
      await sql`SELECT
        (SELECT count(*)::int FROM conditions.observation_latest) AS latest,
        (SELECT count(*)::int FROM conditions.observation) AS history`
    )[0];

  it("write a detection a later poll restates once, as one series and one history row", async () => {
    const pixel = firePixel(-120.5, 38.25, "2026-10-01T09:12:00Z");
    const first = await writeSnapshot(sql, FIRMS, { observations: [pixel] }, ctx);
    const again = await writeSnapshot(sql, FIRMS, { observations: [pixel] }, ctx);
    expect(first.observations).toMatchObject({ latest: 1, history: 1, unchanged: 0 });
    expect(again.observations).toMatchObject({ latest: 0, history: 0, unchanged: 1 });
    expect(await pixels()).toEqual({ latest: 1, history: 1 });
    const [row] = await sql`SELECT value_num, effective_from, expires_at, retention_days
      FROM conditions.observation_latest`;
    expect(row).toEqual({
      value_num: 12.5,
      effective_from: new Date("2026-10-01T09:12:00Z"),
      expires_at: new Date("2026-10-04T09:12:00Z"),
      retention_days: 7,
    });
  });

  it("move a transient series to a later detection at the very same place", async () => {
    await writeSnapshot(
      sql,
      FIRMS,
      { observations: [firePixel(-120.5, 38.25, "2026-10-01T09:12:00Z", 10)] },
      ctx,
    );
    const later = await writeSnapshot(
      sql,
      FIRMS,
      {
        observations: [
          firePixel(-120.5, 38.25, "2026-09-30T21:40:00Z", 7),
          firePixel(-120.5, 38.25, "2026-10-01T09:54:00Z", 30),
        ],
      },
      ctx,
    );
    expect(later.observations).toMatchObject({ latest: 1, history: 1, unchanged: 1 });
    const [row] = await sql`SELECT value_num FROM conditions.observation_latest`;
    expect(row).toEqual({ value_num: 30 });
    expect(await pixels()).toEqual({ latest: 1, history: 2 });
  });

  it("append 20,000 transient readings without reading the source's series", async () => {
    await writeSnapshot(
      sql,
      FIRMS,
      { observations: [firePixel(-121, 39, "2026-10-01T08:00:00Z")] },
      ctx,
    );
    const drafts = Array.from({ length: 20_000 }, (_, i) =>
      firePixel(-100 + (i % 200) * 0.01, 30 + Math.floor(i / 200) * 0.01, "2026-10-01T09:30:00Z"),
    );
    const queries: string[] = [];
    const summary = await sql.begin((tx) => {
      const spied = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "unsafe") {
            return (query: string, params?: unknown[]) => {
              queries.push(query);
              return target.unsafe(query, params as never);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return writeSnapshotIn(spied, FIRMS, { observations: drafts }, ctx);
    });
    expect(summary.observations).toMatchObject({ latest: 20_000, history: 20_000, unchanged: 0 });
    expect(summary.rejected).toEqual([]);
    expect(queries.length).toBeGreaterThan(0);
    expect(
      queries.filter((q) => /SELECT[\s\S]*FROM conditions\.observation_latest/.test(q)),
    ).toEqual([]);
    expect(await pixels()).toEqual({ latest: 20_001, history: 20_001 });
  }, 120_000);
});
