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

describe("segment_profile schema", () => {
  it("creates segment_profile with the weekly speed-profile columns", async () => {
    const cols = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='conditions' AND table_name='segment_profile'`;
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        "segment_id",
        "dow",
        "tod_hour",
        "speed_kph",
        "sample_count",
        "computed_at",
      ])
    );
  }, 30_000);

  it("has a composite (segment_id, dow, tod_hour) PK", async () => {
    const pk = await sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'conditions'
        AND tc.table_name = 'segment_profile'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`;
    expect(pk.map((r) => r.column_name)).toEqual(["segment_id", "dow", "tod_hour"]);
  }, 30_000);

  it("has the idx_segment_profile_segment index on segment_id", async () => {
    const idx =
      await sql`SELECT indexname FROM pg_indexes WHERE schemaname='conditions' AND tablename='segment_profile'`;
    expect(idx.map((i) => i.indexname)).toContain("idx_segment_profile_segment");
  }, 30_000);

  it("round-trips a segment_profile row", async () => {
    await sql`
      INSERT INTO conditions.segment_profile
        (segment_id, dow, tod_hour, speed_kph, sample_count, computed_at)
      VALUES ('999:f', 1, 8, 42.5, 12, now())`;

    const rows = await sql<{ segment_id: string; dow: number; tod_hour: number }[]>`
      SELECT segment_id, dow, tod_hour FROM conditions.segment_profile WHERE segment_id = '999:f'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ segment_id: "999:f", dow: 1, tod_hour: 8 });
  }, 30_000);
});
