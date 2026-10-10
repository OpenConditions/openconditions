import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadCanonical } from "../fused-rows.js";
import { createTestDatabase } from "./database.integration.js";

/**
 * A feed's worth of single-member clusters, and a poll naming ten thousand
 * features: a tenth of them clustered already, the rest new. A member test
 * evaluated per cluster compares every cluster with the whole list, which on
 * a national charging feed held a transaction for twenty minutes.
 */
const CLUSTERS = 60_000;
const NAMED = 10_000;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let traced: postgres.Sql;
const statements: { query: string; params: unknown[] }[] = [];

const member = (n: number) => `oc:feature:src${n % 40}:${n}`;
const canonical = (n: number) => `oc:feature:local:${n}`;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.sql`
    INSERT INTO conditions.feature_canonical
      (canonical_feature_id, survivor_id, member_ids, merged_sources, components, computed_at)
    SELECT 'oc:feature:local:' || n, 'oc:feature:src' || (n % 40) || ':' || n,
           ARRAY['oc:feature:src' || (n % 40) || ':' || n], '[]'::jsonb, '[]'::jsonb, now()
      FROM generate_series(1, ${CLUSTERS}) AS n`;
  await db.sql`VACUUM ANALYZE conditions.feature_canonical`;
  traced = postgres(db.url, {
    max: 1,
    onnotice: () => {},
    debug: (_connection, query, params) => statements.push({ query, params: [...params] }),
  });
}, 180_000);

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

/**
 * Every node of the statement's plan, as Postgres plans it for these
 * parameters or generically. Every parameter of the statements tested is a
 * list of ids.
 */
async function planOf(
  { query, params }: { query: string; params: unknown[] },
  mode: "force_custom_plan" | "force_generic_plan",
): Promise<PlanNode[]> {
  return db.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL plan_cache_mode = ${mode}`);
    const types = params.map(() => "text[]").join(", ");
    await tx.unsafe(`PREPARE holding_probe(${types}) AS ${query}`);
    // EXECUTE takes no bound parameters, so each list travels as a setting.
    for (const [i, value] of params.entries()) {
      await tx`SELECT set_config(${`holding_probe.p${i + 1}`}, ${value as string[]}::text[]::text, true)`;
    }
    const args = params.map((_, i) => `current_setting('holding_probe.p${i + 1}')::text[]`);
    const [{ "QUERY PLAN": plans }] = (await tx.unsafe(
      `EXPLAIN (FORMAT JSON) EXECUTE holding_probe(${args.join(", ")})`,
    )) as { "QUERY PLAN": { Plan: PlanNode }[] }[];
    await tx.unsafe("DEALLOCATE holding_probe");
    return nodesOf(plans![0]!.Plan);
  });
}

/** A node that tests cluster members against the list row by row instead of through the member index. */
function memberScans(nodes: PlanNode[]): PlanNode[] {
  return nodes.filter(
    (n) =>
      String(n["Filter"] ?? "").includes("member_ids") ||
      String(n["Join Filter"] ?? "").includes("member_ids"),
  );
}

describe("clusters holding a large set of features", () => {
  test("are found through the member index, however the plan is cached", async () => {
    const named = Array.from({ length: NAMED }, (_, i) =>
      i % 10 === 0 ? member(i + 1) : `oc:feature:new:${i}`,
    );
    named.push(canonical(CLUSTERS));

    statements.length = 0;
    const rows = await loadCanonical(traced, named);
    expect(rows.map((r) => r.canonicalFeatureId).sort()).toEqual(
      [
        ...Array.from({ length: NAMED / 10 }, (_, i) => canonical(i * 10 + 1)),
        canonical(CLUSTERS),
      ].sort(),
    );

    const statement = statements.find((s) => s.query.includes("feature_canonical"))!;
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      const nodes = await planOf(statement, mode);
      expect(nodes.some((n) => n["Index Name"] === "idx_feature_canonical_members")).toBe(true);
      expect(memberScans(nodes)).toEqual([]);
    }
  }, 120_000);

  test("go into the member index directly, so a lookup never scans a pending list", async () => {
    const [index] = await db.sql<{ options: string[] | null }[]>`
      SELECT reloptions AS options FROM pg_class WHERE relname = 'idx_feature_canonical_members'`;
    expect(index?.options).toContain("fastupdate=off");
  });
});
