import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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

describe("segment_observation + segment_speed schema", () => {
  it("creates segment_observation with a composite (segment_id, source) PK and fusion columns", async () => {
    const cols = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='conditions' AND table_name='segment_observation'`;
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        "segment_id",
        "source",
        "source_tier",
        "confidence",
        "sample_count",
        "observed_at",
        "expires_at",
      ])
    );

    const pk = await sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'conditions'
        AND tc.table_name = 'segment_observation'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`;
    expect(pk.map((r) => r.column_name)).toEqual(["segment_id", "source"]);

    const idx =
      await sql`SELECT indexname FROM pg_indexes WHERE schemaname='conditions' AND tablename='segment_observation'`;
    expect(idx.map((i) => i.indexname)).toContain("idx_segment_observation_segment");
  }, 30_000);

  it("creates segment_speed with the fused/propagated surface columns and the LOS index", async () => {
    const cols = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='conditions' AND table_name='segment_speed'`;
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        "segment_id",
        "current_kph",
        "free_flow_kph",
        "speed_ratio",
        "los",
        "confidence",
        "source_tier",
        "contributing",
        "is_estimated",
        "observed_at",
        "updated_at",
      ])
    );

    const idx =
      await sql`SELECT indexname FROM pg_indexes WHERE schemaname='conditions' AND tablename='segment_speed'`;
    expect(idx.map((i) => i.indexname)).toContain("idx_segment_speed_los");
  }, 30_000);

  it("round-trips a segment_observation row feeding a segment_speed row (contributing text[])", async () => {
    await sql`
      INSERT INTO conditions.road_segment
        (segment_id, way_id, dir, geom, highway, length_m, min_zoom, computed_at)
      VALUES ('999:f', 999, 'f',
        ST_SetSRID(ST_GeomFromGeoJSON('{"type":"LineString","coordinates":[[24.9,60.2],[24.91,60.21]]}'), 4326),
        'primary', 500.0, 9, now())`;

    await sql`
      INSERT INTO conditions.segment_observation
        (segment_id, source, source_tier, current_kph, free_flow_kph, speed_ratio, los, confidence, sample_count, observed_at, expires_at)
      VALUES ('999:f', 'fi', 'sensor', 80.0, 100.0, 0.8, 'heavy', 0.9, NULL, now(), now() + interval '10 minutes')`;

    const obs = await sql<{ segment_id: string; source: string }[]>`
      SELECT segment_id, source FROM conditions.segment_observation WHERE segment_id = '999:f'`;
    expect(obs).toHaveLength(1);

    await sql`
      INSERT INTO conditions.segment_speed
        (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, contributing, is_estimated, observed_at, updated_at)
      VALUES ('999:f', 80.0, 100.0, 0.8, 'heavy', 'measured', 'sensor', ARRAY['fi'], false, now(), now())`;

    const speed = await sql<{ segment_id: string; contributing: string[] }[]>`
      SELECT segment_id, contributing FROM conditions.segment_speed WHERE segment_id = '999:f'`;
    expect(speed[0]!.contributing).toEqual(["fi"]);
  }, 30_000);
});
