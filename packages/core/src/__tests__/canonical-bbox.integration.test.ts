import { runMigrations } from "@openconditions/core/server";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listCanonicalFeatures } from "../features.js";
import type { QueryRunner } from "../query-runner.js";

/**
 * A national register's worth of lone charging sites, each its own cluster,
 * on a grid of 300 × 200 points 0.01° apart from 5°E 47°N. A city box holds a
 * few hundred of them.
 */
const COLUMNS = 300;
const ROWS = 200;
const BOX: [number, number, number, number] = [6.0, 48.0, 6.2, 48.1];

let container: StartedTestContainer;
let sql: postgres.Sql;
const statements: { query: string; params: unknown[] }[] = [];
let runner: QueryRunner;

beforeAll(async () => {
  container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  await runMigrations(url);
  sql = postgres(url, { max: 2, onnotice: () => {} });
  runner = {
    execute: async <T>(query: string, params: unknown[] = []) => {
      statements.push({ query, params });
      return (await sql.unsafe(query, params as never)) as T;
    },
  };
  await sql`
    INSERT INTO conditions.feature (id, record, canonical_id, kind, domain, temporality,
      source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
      recorded_at, content_hash, fetched_at, lifecycle, geom)
    SELECT 'oc:feature:de-register:' || n, jsonb_build_object('id', 'oc:feature:de-register:' || n),
           'oc:feature:de-register:' || n, 'charging_site', 'charging', 'static', 'de-register',
           n::text, 'feed', 'bulk', 'authoritative', 'local', 1, now(), 'h', now(), 'operational',
           ST_SetSRID(ST_MakePoint(5 + (n % ${COLUMNS}) * 0.01, 47 + (n / ${COLUMNS}) * 0.01), 4326)
      FROM generate_series(0, ${COLUMNS * ROWS - 1}) AS n`;
  await sql`
    INSERT INTO conditions.feature_canonical
      (canonical_feature_id, survivor_id, member_ids, components, computed_at)
    SELECT 'oc:feature:local:' || lpad(n::text, 6, '0'), 'oc:feature:de-register:' || n,
           ARRAY['oc:feature:de-register:' || n], '[]'::jsonb, now()
      FROM generate_series(0, ${COLUMNS * ROWS - 1}) AS n`;
  // As autovacuum leaves a live table: statistics taken, the member index's
  // pending entries merged.
  await sql`VACUUM ANALYZE conditions.feature`;
  await sql`VACUUM ANALYZE conditions.feature_canonical`;
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

/** Every plan node of an `EXPLAIN (FORMAT JSON)` plan. */
function nodesOf(plan: Record<string, unknown>): Record<string, unknown>[] {
  const children = (plan["Plans"] as Record<string, unknown>[] | undefined) ?? [];
  return [plan, ...children.flatMap(nodesOf)];
}

describe("canonical view in a box", () => {
  test("looks each boxed feature's cluster up by member, not by testing every cluster", async () => {
    const page = await listCanonicalFeatures(runner, {
      scope: "operator",
      bbox: BOX,
      kinds: ["charging_site"],
      limit: 400,
    });
    // 21 columns × 11 rows of the grid lie in the box (edges included).
    expect(page.clusters).toHaveLength(231);
    expect(page.next).toBeNull();

    const { query, params } = statements.at(-1)!;
    const [{ "QUERY PLAN": plans }] = (await sql.unsafe(
      `EXPLAIN (FORMAT JSON) ${query}`,
      params as never,
    )) as { "QUERY PLAN": { Plan: Record<string, unknown> }[] }[];
    const nodes = nodesOf(plans![0]!.Plan);
    // A cluster found by member reads the member index; a member test as a
    // join filter walks every cluster of the view for each boxed feature.
    expect(nodes.some((n) => n["Index Name"] === "idx_feature_canonical_members")).toBe(true);
    expect(nodes.filter((n) => String(n["Join Filter"] ?? "").includes("member_ids"))).toEqual([]);
  });
});
