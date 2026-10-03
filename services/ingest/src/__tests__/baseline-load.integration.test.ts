import { runMigrations } from "@openconditions/core/server";
import { enrichReadings, type FlowOutput, type RoadFeed } from "@openconditions/roads";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBaselineMap } from "../pipeline/baseline-store.js";
import { repoFeed } from "./helpers/catalog.js";

const feed = { ...repoFeed("nl-ndw-flow"), id: "src" } as RoadFeed;
const key = (site: string) => `feature:oc:feature:src:${site}`;

/** One poll's site speed of `site`, with no level of service and no baseline of its own. */
function speedOf(site: string, value: number): FlowOutput {
  return {
    features: [],
    situations: [],
    observations: [
      {
        class: "observation",
        kind: "observation",
        property: "traffic.speed",
        subject: { kind: "feature", featureId: `oc:feature:src:${site}` },
        result: { type: "quantity", value, unit: "km/h" },
        phenomenonTime: { instant: "2026-03-04T14:30:00.000Z" },
        location: {
          geometry: { type: "Point", coordinates: [4.9, 52.1] },
          extent: "point",
          geometryOrigin: "site_table",
          fuzziness: "exact",
        },
        provenance: { origin: "feed", sourceId: "src", recordId: site },
        freshness: { fetchedAt: "2026-03-04T14:31:00.000Z" },
      },
    ],
  };
}

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

async function seedBaseline(
  subjectKey: string,
  dowB: number,
  todB: number,
  ff: number,
  method: string,
): Promise<void> {
  await sql`
    INSERT INTO conditions.sensor_baseline
      (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    VALUES (${subjectKey}, 'src', ${dowB}, ${todB}, ${ff}, ${method}, 50, now())`;
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

describe("loadBaselineMap", () => {
  it("resolves free-flow from the overall (-1,-1) row only, ignoring any specific-bucket row, priority native>derived>osm_maxspeed", async () => {
    // src:a carries a congested rush-hour specific-bucket derived row (what a
    // chronically congested sensor's p85 collapses to during that hour) AND an
    // overall native row: the overall native row must win, not the specific one
    // (the P0.3 regression this rewrite locks in — a specific-bucket row must
    // never be preferred, since that is exactly what let recurring congestion
    // masquerade as free_flow).
    await seedBaseline(key("a"), 0, 14, 40, "derived"); // congested rush-hour specific bucket
    await seedBaseline(key("a"), -1, -1, 100, "native"); // overall native free-flow

    // src:b has no native row: among overall rows, derived beats osm_maxspeed.
    await seedBaseline(key("b"), -1, -1, 70, "derived");
    await seedBaseline(key("b"), -1, -1, 80, "osm_maxspeed");

    // src:c has ONLY a specific-bucket derived row, no overall row at all. In
    // practice an overall row always exists whenever a specific row does
    // (deriveBaselines always upserts both, and the overall sample count is >=
    // any bucket's), so this documents (rather than exercises) that the
    // overall-only query correctly yields no baseline here.
    await seedBaseline(key("c"), 0, 14, 88, "derived");

    const map = await loadBaselineMap(sql, "src");
    expect(map.get(key("a"))).toEqual({ freeFlowKph: 100, method: "native" });
    expect(map.get(key("b"))).toEqual({ freeFlowKph: 70, method: "derived" });
    expect(map.has(key("c"))).toBe(false);
  }, 30_000);

  it("only returns rows for the requested source", async () => {
    await seedBaseline(key("only"), -1, -1, 42, "derived");
    await sql`
      INSERT INTO conditions.sensor_baseline
        (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('feature:oc:feature:other-src:x', 'other-src', -1, -1, 99, 'derived', 50, now())`;

    const map = await loadBaselineMap(sql, "src");
    expect(map.has("feature:oc:feature:other-src:x")).toBe(false);
    expect(map.get(key("only"))).toEqual({ freeFlowKph: 42, method: "derived" });
  }, 30_000);

  it("fixes the recurring-congestion regression: a rush-hour flow at the congested speed is NOT classified free_flow against the resolved (overall) baseline", async () => {
    // Same congested-bucket-vs-overall-native shape as above, but driven all
    // the way through the enrichment's los ratio to demonstrate the actual
    // user-visible fix: before P0.3, the specific bucket (40 kph, itself
    // already the congested speed) would have been used as the denominator,
    // so ratio ~= 1 and los = free_flow during exactly the hours a traffic
    // layer should show congestion.
    await seedBaseline(key("d"), 0, 14, 40, "derived"); // congested specific bucket
    await seedBaseline(key("d"), -1, -1, 100, "native"); // true overall free-flow

    const map = await loadBaselineMap(sql, "src");
    const baseline = map.get(key("d"));
    expect(baseline).toEqual({ freeFlowKph: 100, method: "native" });

    const enriched = enrichReadings(feed, speedOf("d", 20), map);
    expect(enriched.observations[0]!["baseline"]).toMatchObject({
      freeFlow: { value: 100, unit: "km/h" },
      source: "native",
      los: "queuing",
    });
    expect(enriched.situations).toHaveLength(1);
  }, 30_000);
});
