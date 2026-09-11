import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { reclassifyFlow } from "@openconditions/roads";
import type { RoadFlow } from "@openconditions/roads";
import type { SourceDescriptor } from "@openconditions/roads";
import { loadBaselineMap } from "../pipeline/baseline-store.js";

const src: SourceDescriptor = {
  id: "src",
  attribution: "T",
  country: "NL",
  license: "CC-BY-4.0",
} as SourceDescriptor;

function flow(id: string, speedKph: number): RoadFlow {
  return {
    id,
    source: "src",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    aggregation: "live",
    status: "active",
    geometry: { type: "Point", coordinates: [4.9, 52.1] },
    los: "unknown",
    speedKph,
    origin: { kind: "feed", attribution: { provider: "T", license: "CC-BY-4.0" } },
    dataUpdatedAt: "2026-03-04T14:30:00Z",
    fetchedAt: "2026-03-04T14:31:00Z",
    isStale: false,
  } as unknown as RoadFlow;
}

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

async function seedBaseline(
  sensorKey: string,
  dowB: number,
  todB: number,
  ff: number,
  method: string
): Promise<void> {
  await sql`
    INSERT INTO conditions.sensor_baseline
      (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    VALUES (${sensorKey}, 'src', ${dowB}, ${todB}, ${ff}, ${method}, 50, now())`;
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
    await seedBaseline("src:a", 0, 14, 40, "derived"); // congested rush-hour specific bucket
    await seedBaseline("src:a", -1, -1, 100, "native"); // overall native free-flow

    // src:b has no native row: among overall rows, derived beats osm_maxspeed.
    await seedBaseline("src:b", -1, -1, 70, "derived");
    await seedBaseline("src:b", -1, -1, 80, "osm_maxspeed");

    // src:c has ONLY a specific-bucket derived row, no overall row at all. In
    // practice an overall row always exists whenever a specific row does
    // (deriveBaselines always upserts both, and the overall sample count is >=
    // any bucket's), so this documents (rather than exercises) that the
    // overall-only query correctly yields no baseline here.
    await seedBaseline("src:c", 0, 14, 88, "derived");

    const map = await loadBaselineMap(sql, "src");
    expect(map.get("src:a")).toEqual({ kph: 100, method: "native" });
    expect(map.get("src:b")).toEqual({ kph: 70, method: "derived" });
    expect(map.has("src:c")).toBe(false);
  }, 30_000);

  it("only returns rows for the requested source", async () => {
    await seedBaseline("src:only", -1, -1, 42, "derived");
    await sql`
      INSERT INTO conditions.sensor_baseline
        (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('other:x', 'other-src', -1, -1, 99, 'derived', 50, now())`;

    const map = await loadBaselineMap(sql, "src");
    expect(map.has("other:x")).toBe(false);
    expect(map.get("src:only")).toEqual({ kph: 42, method: "derived" });
  }, 30_000);

  it("fixes the recurring-congestion regression: a rush-hour flow at the congested speed is NOT classified free_flow against the resolved (overall) baseline", async () => {
    // Same congested-bucket-vs-overall-native shape as above, but driven all
    // the way through reclassifyFlow's los ratio to demonstrate the actual
    // user-visible fix: before P0.3, the specific bucket (40 kph, itself
    // already the congested speed) would have been used as the denominator,
    // so ratio ~= 1 and los = free_flow during exactly the hours a traffic
    // layer should show congestion.
    await seedBaseline("src:d", 0, 14, 40, "derived"); // congested specific bucket
    await seedBaseline("src:d", -1, -1, 100, "native"); // true overall free-flow

    const map = await loadBaselineMap(sql, "src");
    const baseline = map.get("src:d");
    expect(baseline).toEqual({ kph: 100, method: "native" });

    const { flow: reclassified } = reclassifyFlow(
      flow("src:d", 20),
      baseline!.kph,
      baseline!.method,
      src
    );
    expect(reclassified.los).not.toBe("free_flow");
    expect(reclassified.los).toBe("queuing");
    expect(reclassified.freeFlowSource).toBe("native");
  }, 30_000);
});
