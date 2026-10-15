import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listFeatures } from "../features.js";
import type { QueryRunner } from "../query-runner.js";
import { listSituations } from "../situations.js";

/**
 * An Aleutian warning zone: one part each side of the antimeridian. Its
 * bounding box spans every longitude between 51.8°N and 52.1°N.
 */
const ALEUTIANS = `MULTIPOLYGON(((178.0 51.8, 179.9 51.8, 179.9 52.1, 178.0 52.1, 178.0 51.8)),
  ((-179.9 51.8, -178.0 51.8, -178.0 52.1, -179.9 52.1, -179.9 51.8)))`;
/** A box around Bonn, at the zone's latitude and half a world away from it. */
const BONN: [number, number, number, number] = [6.5, 50.7, 7.3, 52.0];
/** A box on the zone's eastern part. */
const ADAK: [number, number, number, number] = [-179.5, 51.7, -179.0, 52.2];

let db: TestDatabase;
let sql: postgres.Sql;
let runner: QueryRunner;

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 2, onnotice: () => {} } });
  sql = db.sql;
  runner = {
    execute: async <T>(query: string, params: unknown[] = []) =>
      (await sql.unsafe(query, params as never)) as T,
  };
  for (const [id, wkt] of [
    ["aleutians", ALEUTIANS],
    ["bonn", "POINT(7.1 50.73)"],
  ] as const) {
    await sql`
      INSERT INTO conditions.situation (id, record, canonical_id, kind, domain, temporality,
        source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
        recorded_at, content_hash, fetched_at, severity, certainty, planned, validity_status, geom)
      VALUES (${`oc:situation:test:${id}`}, ${sql.json({ id: `oc:situation:test:${id}` })},
        ${`oc:situation:test:${id}`}, 'alert', 'hazards', 'live', 'test', ${id}, 'feed', 'bulk',
        'authoritative', 'local', 1, now(), 'h', now(), 'moderate', 'observed', false, 'active',
        ST_GeomFromText(${wkt}, 4326))`;
    await sql`
      INSERT INTO conditions.feature (id, record, canonical_id, kind, domain, temporality,
        source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
        recorded_at, content_hash, fetched_at, lifecycle, geom)
      VALUES (${`oc:feature:test:${id}`}, ${sql.json({ id: `oc:feature:test:${id}` })},
        ${`oc:feature:test:${id}`}, 'zone', 'hazards', 'static', 'test', ${id}, 'feed', 'bulk',
        'authoritative', 'local', 1, now(), 'h', now(), 'operational', ST_GeomFromText(${wkt}, 4326))`;
  }
});

afterAll(async () => {
  await db?.close();
});

describe("a box read of a geometry across the antimeridian", () => {
  test("leaves out a situation whose box spans the box but whose geometry does not", async () => {
    const bonn = await listSituations(runner, { scope: "operator", bbox: BONN, limit: 10 });
    expect(bonn.records.map((r) => r["id"])).toEqual(["oc:situation:test:bonn"]);
    const adak = await listSituations(runner, { scope: "operator", bbox: ADAK, limit: 10 });
    expect(adak.records.map((r) => r["id"])).toEqual(["oc:situation:test:aleutians"]);
  });

  test("leaves out such a feature too", async () => {
    const bonn = await listFeatures(runner, { scope: "operator", bbox: BONN, limit: 10 });
    expect(bonn.records.map((r) => r["id"])).toEqual(["oc:feature:test:bonn"]);
    const adak = await listFeatures(runner, { scope: "operator", bbox: ADAK, limit: 10 });
    expect(adak.records.map((r) => r["id"])).toEqual(["oc:feature:test:aleutians"]);
  });
});
