import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { rebindAll, rebindStale } from "../pipeline/rebind.js";

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
  process.env["SEGMENT_REGIONS"] = JSON.stringify([
    { id: "de-nw", bbox: [5.8, 50.3, 9.5, 52.6], tz: "Europe/Berlin" },
  ]);
  await sql`INSERT INTO conditions.road_segment (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, computed_at) VALUES
    ('10:f', 10, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.80 51.2, 6.82 51.2)'),4326), 'motorway', 'A 46', 1400, 5, ${NOW})`;
  await sql`INSERT INTO conditions.road_graph_state
    (singleton,generation,status,regions,highway_classes,pbf_provenance,imported_at,activated_at)
    VALUES (true,'graph-rebind-test','ready','[]','["motorway"]','[]',${NOW},${NOW})`;
  await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, status, geom, attributes, origin, data_updated_at, fetched_at) VALUES
    ('a:1','autobahn-de','autobahn','roads','event','road_closure','active',
      ST_SetSRID(ST_GeomFromText('LINESTRING(6.805 51.20001, 6.815 51.20001)'),4326),
      '{"roads":[{"ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now())`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  delete process.env["SEGMENT_REGIONS"];
}, 30_000);

describe("rebind", () => {
  it("rebindStale binds never-bound events, ones from an older resolver, and stale geometry", async () => {
    expect((await rebindStale(sql, { now: () => NOW })).rebound).toBe(1);
    await sql`UPDATE conditions.observation_binding SET resolver_version = '0.0.1'`;
    expect((await rebindStale(sql, { now: () => NOW })).rebound).toBe(1);
    expect((await rebindStale(sql, { now: () => NOW })).rebound).toBe(0);

    // Geometry moved without the writer that moved it calling the binding
    // stage: the stored hash no longer describes the event, so the pass has to
    // re-resolve it even though the resolver version already matches.
    await sql`UPDATE conditions.observations
      SET geom = ST_SetSRID(ST_GeomFromText('LINESTRING(6.806 51.20002, 6.814 51.20002)'),4326)
      WHERE id = 'a:1'`;
    expect((await rebindStale(sql, { now: () => NOW })).rebound).toBe(1);
    expect((await rebindStale(sql, { now: () => NOW })).rebound).toBe(0);
  }, 60_000);

  it("both passes are no-ops that destroy nothing when BIND_ENABLED=false", async () => {
    const env = { ...process.env, BIND_ENABLED: "false" };
    expect(await rebindStale(sql, { now: () => NOW, env })).toEqual({ rebound: 0 });
    expect(await rebindAll(sql, { now: () => NOW, env })).toEqual({
      rebound: 0,
      prunedSegments: 0,
    });

    // The disabled stage returns before it can replace anything, so a pass that
    // deleted first would leave the event bindingless with parentless spans.
    expect(
      await sql`SELECT observation_id FROM conditions.observation_binding WHERE observation_id='a:1'`
    ).toHaveLength(1);
    expect(
      await sql`SELECT segment_id FROM conditions.observation_segment WHERE observation_id='a:1'`
    ).not.toHaveLength(0);
  }, 30_000);

  it("rebindAll re-binds everything and prunes segment rows whose segment vanished", async () => {
    // A path row left behind by an observation no rebind pass looks at (not an
    // active road event, and no binding row for the inactive sweep to find) —
    // only the prune can remove it once its segment left the rebuilt spine.
    await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, status, geom, attributes, origin, data_updated_at, fetched_at) VALUES
      ('a:orphan','autobahn-de','autobahn','roads','event','road_closure','inactive',
        ST_SetSRID(ST_GeomFromText('LINESTRING(6.805 51.20001, 6.815 51.20001)'),4326),
        '{"roads":[{"ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now())`;
    await sql`INSERT INTO conditions.observation_segment (observation_id, seq, segment_id, way_id, dir, start_fraction, end_fraction)
      VALUES ('a:orphan', 0, '999:f', 999, 'f', 0, 1)`;

    const r = await rebindAll(sql, { now: () => NOW });
    expect(r.rebound).toBe(1);
    expect(r.prunedSegments).toBe(1);
    const segs = await sql<
      { segment_id: string }[]
    >`SELECT segment_id FROM conditions.observation_segment WHERE observation_id='a:1'`;
    expect(segs.map((s) => s.segment_id)).toEqual(["10:f"]);
    expect(
      await sql`SELECT segment_id FROM conditions.observation_segment WHERE observation_id='a:orphan'`
    ).toHaveLength(0);
  }, 60_000);

  it("rebindAll drops the binding of an event that was deactivated in place", async () => {
    await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, status, geom, attributes, origin, data_updated_at, fetched_at) VALUES
      ('a:ended','autobahn-de','autobahn','roads','event','road_closure','active',
        ST_SetSRID(ST_GeomFromText('LINESTRING(6.807 51.20003, 6.813 51.20003)'),4326),
        '{"roads":[{"ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now())`;
    await rebindStale(sql, { now: () => NOW });
    expect(
      await sql`SELECT observation_id FROM conditions.observation_binding WHERE observation_id='a:ended'`
    ).toHaveLength(1);

    // A rebuild must not leave it claiming 'exact' with zero spans.
    await sql`UPDATE conditions.observations SET status = 'inactive' WHERE id = 'a:ended'`;
    await rebindAll(sql, { now: () => NOW });
    expect(
      await sql`SELECT observation_id FROM conditions.observation_binding WHERE observation_id='a:ended'`
    ).toHaveLength(0);
    expect(
      await sql`SELECT segment_id FROM conditions.observation_segment WHERE observation_id='a:ended'`
    ).toHaveLength(0);
  }, 60_000);

  it("rebindStale drops the binding of an event another writer deactivated in place", async () => {
    await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, status, geom, attributes, origin, data_updated_at, fetched_at) VALUES
      ('a:2','autobahn-de','autobahn','roads','event','road_closure','active',
        ST_SetSRID(ST_GeomFromText('LINESTRING(6.806 51.20001, 6.814 51.20001)'),4326),
        '{"roads":[{"ref":"A 46"}]}', '{"kind":"feed","attribution":{"provider":"a","license":"CC0"}}', now(), now())`;
    expect((await rebindStale(sql, { now: () => NOW })).rebound).toBe(1);
    const bound = await sql<
      { segment_id: string }[]
    >`SELECT segment_id FROM conditions.observation_segment WHERE observation_id='a:2'`;
    expect(bound.length).toBeGreaterThan(0);

    // Another writer ends the closure in place instead of deleting the row, so
    // the FK cascade never fires and the binding stage is never called for it.
    await sql`UPDATE conditions.observations SET status = 'inactive' WHERE id = 'a:2'`;
    expect((await rebindStale(sql, { now: () => NOW })).rebound).toBe(0);
    expect(
      await sql`SELECT observation_id FROM conditions.observation_binding WHERE observation_id='a:2'`
    ).toHaveLength(0);
    expect(
      await sql`SELECT observation_id FROM conditions.observation_segment WHERE observation_id='a:2'`
    ).toHaveLength(0);
  }, 60_000);
});
