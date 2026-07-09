import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { runSegmentRebuild } from "../pipeline/segment-rebuild.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

// A single sensored region so the fake fetch below (which ignores the query
// entirely) is only ever consulted once per run.
const ONE_REGION = JSON.stringify([
  { id: "nl", bbox: [4.8, 51.9, 5.2, 52.1], tz: "Europe/Amsterdam" },
]);

// A short oneway A12 motorway way running due east along lat 52.0 — mirrors
// the fixture shape used by osm-import.test.ts / sensor-match.test.ts.
const fixture = JSON.stringify({
  elements: [
    {
      type: "way",
      id: 9,
      tags: { highway: "motorway", oneway: "yes", ref: "A12", maxspeed: "120" },
      geometry: [
        { lat: 52.0, lon: 5.0 },
        { lat: 52.0, lon: 5.1 },
      ],
    },
  ],
});
const fetchFn = (async () => new Response(fixture, { status: 200 })) as unknown as typeof fetch;

async function seedFlowSensor(): Promise<void> {
  // ~11 m north of the way, at its midpoint longitude — inside the 35 m snap gate.
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, metric, status, geom, attributes, origin,
       data_updated_at, fetched_at)
    VALUES ('flow:1', 'test-src', 'test-fmt', 'roads', 'measurement', 'flow', 'active',
      ST_SetSRID(ST_GeomFromText('POINT(5.05 52.0001)'), 4326),
      ${sql.json({ roads: "A12" })},
      ${sql.json({ kind: "feed", attribution: { provider: "test" } })},
      ${NOW}, ${NOW})`;
}

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

afterEach(async () => {
  delete process.env["SEGMENT_REGIONS"];
  await sql`DELETE FROM conditions.sensor_segment`;
  await sql`DELETE FROM conditions.observations`;
  await sql`DELETE FROM conditions.road_segment`;
  await sql`DELETE FROM conditions.osm_road`;
});

describe("runSegmentRebuild", () => {
  it("runs import -> build -> encode -> match in order and is idempotent", async () => {
    process.env["SEGMENT_REGIONS"] = ONE_REGION;
    await seedFlowSensor();

    const first = await runSegmentRebuild(sql, { fetch: fetchFn, now: () => NOW });
    expect(first).toMatchObject({ imported: 1, built: 1, encoded: 1, matched: 1 });

    const segRows = await sql<{ segment_id: string; openlr: string | null }[]>`
      SELECT segment_id, openlr FROM conditions.road_segment`;
    expect(segRows).toHaveLength(1);
    expect(segRows[0]!.segment_id).toBe("9:f");
    expect(segRows[0]!.openlr).not.toBeNull();

    const sensorRows =
      await sql`SELECT segment_id FROM conditions.sensor_segment WHERE sensor_key = 'flow:1'`;
    expect(sensorRows).toHaveLength(1);
    expect(sensorRows[0]!.segment_id).toBe("9:f");

    // Idempotent: a second full run yields the same road_segment count and
    // keeps openlr populated (re-encode is a no-op once already encoded).
    const second = await runSegmentRebuild(sql, { fetch: fetchFn, now: () => NOW });
    expect(second.imported).toBe(1);
    expect(second.built).toBe(1);
    expect(second.matched).toBe(1);

    const segRowsAgain = await sql<{ segment_id: string; openlr: string | null }[]>`
      SELECT segment_id, openlr FROM conditions.road_segment`;
    expect(segRowsAgain).toHaveLength(1);
    expect(segRowsAgain[0]!.openlr).not.toBeNull();
  }, 60_000);

  it("continues to later stages when a middle stage throws", async () => {
    process.env["SEGMENT_REGIONS"] = ONE_REGION;
    await seedFlowSensor();

    // Inject a throwing encode stage (the middle of the four); import, build,
    // and match stay the real functions. A missing try/catch around any stage
    // would let this throw propagate out and reject the whole rebuild, so this
    // asserts the per-stage catch-and-continue behavior directly.
    const result = await runSegmentRebuild(sql, {
      fetch: fetchFn,
      now: () => NOW,
      steps: {
        encodeSegmentOpenlr: async () => {
          throw new Error("openlr encode blew up");
        },
      },
    });

    // The thrown stage contributes 0; every other stage still ran.
    expect(result.encoded).toBe(0);
    expect(result.imported).toBe(1);
    expect(result.built).toBe(1);
    expect(result.matched).toBe(1);

    // The later stage's effect is observable: sensor matching ran after the
    // encode stage threw and still snapped the seeded flow sensor.
    const sensorRows =
      await sql`SELECT segment_id FROM conditions.sensor_segment WHERE sensor_key = 'flow:1'`;
    expect(sensorRows).toHaveLength(1);
    expect(sensorRows[0]!.segment_id).toBe("9:f");
  }, 30_000);
});
