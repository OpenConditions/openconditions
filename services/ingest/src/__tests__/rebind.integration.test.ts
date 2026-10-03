import { RESOLVER_VERSION } from "@openconditions/roads";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rebindAll, rebindOnBoot } from "../pipeline/rebind.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { situationDraft, writeSituations } from "./helpers/situations.js";

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
const NOW = "2026-09-06T10:00:00.000Z";
const now = () => NOW;
const id = (local: string) => `oc:situation:de-autobahn-events:${local}`;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  process.env["SEGMENT_REGIONS"] = JSON.stringify([
    { id: "de-nw", bbox: [5.8, 50.3, 9.5, 52.6], tz: "Europe/Berlin" },
  ]);
  await sql`INSERT INTO conditions.road_segment (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, computed_at) VALUES
    ('10:f', 10, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.80 51.2, 6.82 51.2)'),4326), 'motorway', 'A 46', 1400, 5, ${NOW})`;
  await sql`INSERT INTO conditions.road_graph_state
    (singleton,generation,status,regions,highway_classes,pbf_provenance,imported_at,activated_at)
    VALUES (true,'graph-rebind-test','ready','[]','["motorway"]','[]',${NOW},${NOW})`;
}, 120_000);

afterAll(async () => {
  await db?.close();
  delete process.env["SEGMENT_REGIONS"];
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.record_binding, conditions.record_segment,
    conditions.binding_queue CASCADE`;
  await writeSituations(sql, "de-autobahn-events", [situationDraft("a1")]);
});

const bindings = (recordId: string) =>
  sql`SELECT status FROM conditions.record_binding WHERE record_id = ${recordId}`;
const spans = (recordId: string) =>
  sql`SELECT segment_id FROM conditions.record_segment WHERE record_id = ${recordId}`;

describe("rebind", () => {
  it("binds at boot what was never bound, and only that", async () => {
    expect((await rebindOnBoot(sql, { now })).rebound).toBe(1);
    expect((await rebindOnBoot(sql, { now })).rebound).toBe(0);
  }, 60_000);

  it("rebinds everything at boot when stored bindings come from another resolver version", async () => {
    await rebindOnBoot(sql, { now });
    await sql`UPDATE conditions.record_binding SET resolver_version = '0.0.1'`;
    expect((await rebindOnBoot(sql, { now })).rebound).toBe(1);
    const [binding] = await sql`SELECT resolver_version FROM conditions.record_binding`;
    expect(binding!["resolver_version"]).toBe(RESOLVER_VERSION);
  }, 60_000);

  it("both passes are no-ops that destroy nothing when BIND_ENABLED=false", async () => {
    await rebindOnBoot(sql, { now });
    const env = { ...process.env, BIND_ENABLED: "false" };
    expect(await rebindOnBoot(sql, { now, env })).toEqual({ rebound: 0 });
    expect(await rebindAll(sql, { now, env })).toEqual({ rebound: 0, prunedSegments: 0 });
    expect(await bindings(id("a1"))).toHaveLength(1);
    expect(await spans(id("a1"))).not.toHaveLength(0);
  }, 30_000);

  it("rebindAll re-binds everything and prunes spans whose segment vanished", async () => {
    await sql`INSERT INTO conditions.record_segment
        (record_class, record_id, effect_id, seq, segment_id, way_id, dir, start_fraction,
         end_fraction)
      VALUES ('situation', ${id("gone")}, '', 0, '999:f', 999, 'f', 0, 1)`;
    const r = await rebindAll(sql, { now });
    expect(r.rebound).toBe(1);
    expect(r.prunedSegments).toBe(1);
    expect((await spans(id("a1"))).map((s) => s["segment_id"])).toEqual(["10:f"]);
  }, 60_000);

  it("drops the binding of a situation tombstoned without the binder being called", async () => {
    await rebindOnBoot(sql, { now });
    expect(await bindings(id("a1"))).toHaveLength(1);
    // Another writer ends the situation in place; nothing queued its binding work.
    await sql`UPDATE conditions.situation SET tombstoned_at = now(), tombstone_reason = 'expired'`;
    await sql`DELETE FROM conditions.binding_queue`;
    expect((await rebindOnBoot(sql, { now })).rebound).toBe(0);
    expect(await bindings(id("a1"))).toHaveLength(0);
    expect(await spans(id("a1"))).toHaveLength(0);
  }, 60_000);
});
