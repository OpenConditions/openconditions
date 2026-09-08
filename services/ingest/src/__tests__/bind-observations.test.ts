import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { bindObservations } from "../pipeline/bind-observations.js";

let sql: postgres.Sql;
let stop: () => Promise<unknown>;
const NOW = "2026-09-06T10:00:00.000Z";

beforeAll(async () => {
  const c = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  stop = () => c.stop();
  const url = `postgres://oc:oc@${c.getHost()}:${c.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
  // The default region list covers nl/se/fi/us-ny; this fixture is on the German
  // A 46, so the test pins its own region rather than relying on the defaults.
  process.env["SEGMENT_REGIONS"] = JSON.stringify([
    { id: "de-nw", bbox: [5.8, 50.3, 9.5, 52.6], tz: "Europe/Berlin" },
  ]);
  await sql`INSERT INTO conditions.road_segment (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, computed_at) VALUES
    ('10:f', 10, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.80 51.2, 6.81 51.2)'),4326), 'motorway', 'A 46', 700, 5, ${NOW}),
    ('11:f', 11, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.81 51.2, 6.82 51.2)'),4326), 'motorway', 'A 46', 700, 5, ${NOW}),
    ('20:f', 20, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.82 51.2003, 6.80 51.2003)'),4326), 'motorway', 'A 46', 1400, 5, ${NOW})`;
  await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, status, geom, attributes, origin, data_updated_at, fetched_at) VALUES
    ('a:1','autobahn-de','autobahn','roads','event','road_closure','active',
      ST_SetSRID(ST_GeomFromText('LINESTRING(6.805 51.20001, 6.818 51.20001)'),4326),
      '{"roads":[{"name":"A46","ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now()),
    ('a:far','autobahn-de','autobahn','roads','event','road_closure','active',
      ST_SetSRID(ST_MakePoint(13.4, 52.5),4326), '{}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now()),
    ('a:poly','autobahn-de','autobahn','roads','event','weather','active',
      ST_SetSRID(ST_GeomFromText('POLYGON((6.8 51.2, 6.9 51.2, 6.9 51.3, 6.8 51.2))'),4326), '{}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now())`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  delete process.env["SEGMENT_REGIONS"];
}, 30_000);

describe("bindObservations", () => {
  it("binds a line to the eastbound segments, marks outside-region and area events", async () => {
    const r = await bindObservations(sql, ["a:1", "a:far", "a:poly"], { now: () => NOW });
    expect(r.attempted).toBe(3);
    expect((r.byStatus["exact"] ?? 0) + (r.byStatus["likely"] ?? 0)).toBeGreaterThanOrEqual(1);
    const rows = await sql<{ observation_id: string; status: string; reason: string | null }[]>`
      SELECT observation_id, status, reason FROM conditions.observation_binding ORDER BY observation_id`;
    expect(rows.find((x) => x.observation_id === "a:far")).toMatchObject({
      status: "no_coverage",
      reason: "outside_regions",
    });
    expect(rows.find((x) => x.observation_id === "a:poly")).toMatchObject({
      status: "not_applicable",
    });
    const segs = await sql<{ segment_id: string; seq: number }[]>`
      SELECT segment_id, seq FROM conditions.observation_segment WHERE observation_id = 'a:1' ORDER BY seq`;
    expect(segs.map((s) => s.segment_id)).toEqual(["10:f", "11:f"]);
  }, 60_000);

  it("skips an unchanged geometry on rebind and rebinds when geometry changes", async () => {
    const again = await bindObservations(sql, ["a:1"], { now: () => NOW });
    expect(again.skippedUnchanged).toBe(1);
    await sql`UPDATE conditions.observations SET geom = ST_SetSRID(ST_GeomFromText('LINESTRING(6.818 51.2002, 6.805 51.2002)'),4326) WHERE id = 'a:1'`;
    const third = await bindObservations(sql, ["a:1"], { now: () => NOW });
    expect(third.skippedUnchanged).toBe(0);
    const segs = await sql<
      { segment_id: string }[]
    >`SELECT segment_id FROM conditions.observation_segment WHERE observation_id = 'a:1'`;
    expect(segs.map((s) => s.segment_id)).toEqual(["20:f"]);
  }, 60_000);

  it("is a no-op when BIND_ENABLED=false", async () => {
    const r = await bindObservations(sql, ["a:1"], {
      now: () => NOW,
      env: { BIND_ENABLED: "false" },
    });
    expect(r.attempted).toBe(0);
  }, 30_000);

  it("rebinds when only the event type changes", async () => {
    // Same geometry, same refs, type flips to one the resolver never binds.
    // A hash over geometry alone would skip this as unchanged and leave the
    // stale spans in place.
    await sql`UPDATE conditions.observations SET type = 'weather' WHERE id = 'a:1'`;
    const r = await bindObservations(sql, ["a:1"], { now: () => NOW });
    expect(r.skippedUnchanged).toBe(0);
    expect(r.attempted).toBe(1);
    const [b] = await sql<{ status: string; reason: string | null }[]>`
      SELECT status, reason FROM conditions.observation_binding WHERE observation_id = 'a:1'`;
    expect(b).toMatchObject({ status: "not_applicable" });
    const segs = await sql<
      { segment_id: string }[]
    >`SELECT segment_id FROM conditions.observation_segment WHERE observation_id = 'a:1'`;
    expect(segs).toEqual([]);
  }, 60_000);

  it("clears the binding of an event that is no longer active", async () => {
    await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, status, geom, attributes, origin, data_updated_at, fetched_at) VALUES
      ('a:gone','autobahn-de','autobahn','roads','event','road_closure','active',
        ST_SetSRID(ST_GeomFromText('LINESTRING(6.805 51.20001, 6.818 51.20001)'),4326),
        '{"roads":[{"name":"A46","ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now())`;
    const first = await bindObservations(sql, ["a:gone"], { now: () => NOW });
    expect(first.bound).toBe(1);
    expect(first.cleared).toBe(0);

    // Deactivated in place rather than deleted, so the observations FK cascade
    // never fires and the stage has to drop the binding itself.
    await sql`UPDATE conditions.observations SET status = 'inactive' WHERE id = 'a:gone'`;
    const second = await bindObservations(sql, ["a:gone"], { now: () => NOW });
    expect(second.cleared).toBe(1);
    expect(second.attempted).toBe(0);

    const [b] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.observation_binding WHERE observation_id = 'a:gone'`;
    const [s] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.observation_segment WHERE observation_id = 'a:gone'`;
    expect(b!.n).toBe(0);
    expect(s!.n).toBe(0);
  }, 60_000);

  it("rebinds when only the resolver version is older", async () => {
    // Same inputs, same hash — the version half of the skip condition is the
    // only thing that can put this row through the resolver again, and the
    // startup rebind pass leans on it entirely.
    await sql`UPDATE conditions.observation_binding SET resolver_version = '0.0.1' WHERE observation_id = 'a:1'`;
    const r = await bindObservations(sql, ["a:1"], { now: () => NOW });
    expect(r.skippedUnchanged).toBe(0);
    expect(r.attempted).toBe(1);
    const [b] = await sql<{ resolver_version: string }[]>`
      SELECT resolver_version FROM conditions.observation_binding WHERE observation_id = 'a:1'`;
    expect(b!.resolver_version).not.toBe("0.0.1");
  }, 60_000);

  it("counts a failed write and still binds the rest of the batch", async () => {
    // A boot-time rebind and a feed poll can reach the same id at once; the
    // write that loses must not reject the whole pass. A trigger stands in for
    // that race so the failure is deterministic.
    await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, status, geom, attributes, origin, data_updated_at, fetched_at) VALUES
      ('a:boom','autobahn-de','autobahn','roads','event','road_closure','active',
        ST_SetSRID(ST_GeomFromText('LINESTRING(6.805 51.20001, 6.818 51.20001)'),4326),
        '{"roads":[{"name":"A46","ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now()),
      ('a:ok','autobahn-de','autobahn','roads','event','road_closure','active',
        ST_SetSRID(ST_GeomFromText('LINESTRING(6.805 51.20001, 6.818 51.20001)'),4326),
        '{"roads":[{"name":"A46","ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now())`;
    await sql.unsafe(`CREATE FUNCTION conditions.bind_write_boom() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.observation_id = 'a:boom' THEN RAISE EXCEPTION 'write boom'; END IF;
        RETURN NEW;
      END $fn$`);
    await sql.unsafe(`CREATE TRIGGER bind_write_boom BEFORE INSERT ON conditions.observation_binding
      FOR EACH ROW EXECUTE FUNCTION conditions.bind_write_boom()`);
    try {
      const r = await bindObservations(sql, ["a:boom", "a:ok"], { now: () => NOW });
      expect(r.attempted).toBe(2);
      expect(r.writeErrors).toBe(1);
      expect(r.bound).toBe(1);
    } finally {
      await sql.unsafe(`DROP TRIGGER bind_write_boom ON conditions.observation_binding`);
      await sql.unsafe(`DROP FUNCTION conditions.bind_write_boom()`);
    }
    const rows = await sql<{ observation_id: string }[]>`
      SELECT observation_id FROM conditions.observation_binding WHERE observation_id IN ('a:boom','a:ok')`;
    expect(rows.map((x) => x.observation_id)).toEqual(["a:ok"]);
  }, 60_000);

  it("waits for the per-id lock before replacing a binding", async () => {
    // Two writers for one id must serialize, or the one with fewer spans
    // leaves the other's tail behind. A held lock stands in for the first
    // writer; the stage must not produce a row until it is released.
    await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, status, geom, attributes, origin, data_updated_at, fetched_at) VALUES
      ('a:lock','autobahn-de','autobahn','roads','event','road_closure','active',
        ST_SetSRID(ST_GeomFromText('LINESTRING(6.805 51.20001, 6.818 51.20001)'),4326),
        '{"roads":[{"ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now())`;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('observation_binding'), hashtext('a:lock'))`;
      await released;
    });
    const run = bindObservations(sql, ["a:lock"], { now: () => NOW });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before =
      await sql`SELECT 1 FROM conditions.observation_binding WHERE observation_id = 'a:lock'`;
    expect(before).toHaveLength(0);
    release();
    await holder;
    const r = await run;
    expect(r.attempted).toBe(1);
    expect(r.writeErrors).toBe(0);
    const after =
      await sql`SELECT 1 FROM conditions.observation_binding WHERE observation_id = 'a:lock'`;
    expect(after).toHaveLength(1);
  }, 60_000);
});
