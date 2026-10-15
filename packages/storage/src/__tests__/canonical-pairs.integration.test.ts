import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase } from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { relinkFeatures } from "../canonical-view.js";

/**
 * A charging register beside a parking one, as a national poll meets them:
 * every charging site carries an external id another source may share. The
 * pair search looks each id up in the external-id index; testing every match
 * against all charging sites of the kind index as well made a 50,000-site
 * register's search run for minutes.
 */
const CHARGING = 60_000;
const PARKING = 70_000;
const POLLED = 5_000;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let traced: postgres.Sql;
const statements: { query: string; params: unknown[] }[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  for (const [kind, domain, count] of [
    ["charging_site", "charging", CHARGING],
    ["parking_site", "parking", PARKING],
  ] as const) {
    await db.sql`
      INSERT INTO conditions.feature (id, record, canonical_id, kind, domain, temporality,
        source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
        recorded_at, content_hash, fetched_at, lifecycle, geom)
      SELECT 'oc:feature:reg:' || ${kind}::text || ':' || n,
             jsonb_build_object('id', 'oc:feature:reg:' || ${kind}::text || ':' || n, 'kind', ${kind}::text,
               'externalIds', jsonb_build_array(jsonb_build_object('scheme', 'ocm', 'id', ${kind}::text || n))),
             'oc:feature:reg:' || ${kind}::text || ':' || n, ${kind}::text, ${domain}::text, 'static', 'reg',
             n::text, 'feed', 'bulk', 'authoritative', 'local', 1, now(), 'h', now(), 'operational',
             ST_SetSRID(ST_MakePoint(5 + (n % 300) * 0.01, 47 + (n / 300) * 0.01), 4326)
        FROM generate_series(1, ${count}) AS n`;
  }
  await db.sql`VACUUM ANALYZE conditions.feature`;
  traced = postgres(db.url, {
    max: 1,
    onnotice: () => {},
    debug: (_connection, query, params) => statements.push({ query, params: [...params] }),
  });
}, 300_000);

afterAll(async () => {
  await traced?.end();
  await db?.close();
});

interface PlanNode extends Record<string, unknown> {
  Plans?: PlanNode[];
}

function nodesOf(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
}

function externalIdIntersections(plan: PlanNode): PlanNode[] {
  return nodesOf(plan).filter(
    (node) =>
      node["Node Type"] === "BitmapAnd" &&
      nodesOf(node).some((descendant) => descendant["Index Name"] === "idx_feature_external_ids"),
  );
}

describe("external-ID lookup plan guard", () => {
  test("allows an unrelated kind and polled-ID intersection beside the external-ID lookup", () => {
    const plan: PlanNode = {
      "Node Type": "Append",
      Plans: [
        { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_external_ids" },
        {
          "Node Type": "BitmapAnd",
          Plans: [
            { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_kind_lifecycle" },
            { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_source" },
          ],
        },
      ],
    };

    expect(externalIdIntersections(plan)).toEqual([]);
  });

  test("rejects a direct intersection of the external-ID and kind indexes", () => {
    const intersection: PlanNode = {
      "Node Type": "BitmapAnd",
      Plans: [
        { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_external_ids" },
        { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_kind_lifecycle" },
      ],
    };

    expect(externalIdIntersections(intersection)).toEqual([intersection]);
  });

  test("rejects every nested external-ID intersection despite another independent lookup", () => {
    const inner: PlanNode = {
      "Node Type": "BitmapAnd",
      Plans: [
        { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_external_ids" },
        { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_kind_lifecycle" },
      ],
    };
    const outer: PlanNode = {
      "Node Type": "BitmapAnd",
      Plans: [
        { "Node Type": "BitmapOr", Plans: [inner] },
        { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_source" },
      ],
    };
    const plan: PlanNode = {
      "Node Type": "Append",
      Plans: [
        { "Node Type": "Bitmap Index Scan", "Index Name": "idx_feature_external_ids" },
        outer,
      ],
    };

    expect(externalIdIntersections(plan)).toEqual([outer, inner]);
  });
});

describe("the pair search of a register's poll", () => {
  test("looks each external id up in its index alone, not intersected with the whole kind", async () => {
    const polled = Array.from(
      { length: POLLED },
      (_, i) => `oc:feature:reg:charging_site:${i + 1}`,
    );
    statements.length = 0;
    await traced
      .begin((tx) =>
        relinkFeatures(tx, productionRegistry(), {
          featureIds: polled,
          instanceId: "local",
          now: new Date().toISOString(),
        }),
      )
      .catch(() => undefined);

    const search = statements.find(
      (s) => s.query.includes("'externalIds'") && s.query.includes("UNION"),
    );
    expect(search).toBeDefined();
    const [{ "QUERY PLAN": plans }] = (await db.sql.unsafe(
      `EXPLAIN (FORMAT JSON) ${search!.query}`,
      search!.params as never,
    )) as { "QUERY PLAN": { Plan: PlanNode }[] }[];
    const nodes = nodesOf(plans![0]!.Plan);
    expect(nodes.some((n) => n["Index Name"] === "idx_feature_external_ids")).toBe(true);
    expect(externalIdIntersections(plans![0]!.Plan)).toEqual([]);
  }, 300_000);
});
