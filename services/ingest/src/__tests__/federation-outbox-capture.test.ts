import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import type { ConditionEvent } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { atomicSwap } from "../pipeline/write-postgis.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const SOURCE = "fed-capture";

function event(id: string, headline: string): ConditionEvent {
  return {
    id: `${SOURCE}:${id}`,
    source: SOURCE,
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    type: "accident",
    category: "incident",
    severity: "medium",
    severitySource: "declared",
    headline,
    status: "active",
    geometry: { type: "Point", coordinates: [5.1, 52.1] },
    origin: { kind: "feed", attribution: { provider: "Test Authority", license: "CC-BY-4.0" } },
    dataUpdatedAt: "2026-07-13T10:00:00.000Z",
    fetchedAt: "2026-07-13T10:00:00.000Z",
    isStale: false,
  } satisfies ConditionEvent;
}

async function journal(): Promise<{ object_id: string; operation: string }[]> {
  return sql<{ object_id: string; operation: string }[]>`
    SELECT object_id, operation FROM conditions.federation_outbox
    WHERE object_id LIKE ${SOURCE + ":%"}
    ORDER BY seq ASC`;
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

describe("federation outbox capture through the ingest swap", () => {
  it("journals one create per inserted row", async () => {
    await atomicSwap(sql, SOURCE, [event("a", "A v1"), event("b", "B v1")]);
    expect(await journal()).toEqual([
      { object_id: `${SOURCE}:a`, operation: "create" },
      { object_id: `${SOURCE}:b`, operation: "create" },
    ]);
  }, 30_000);

  it("a no-op resupply (unchanged content) journals nothing", async () => {
    await atomicSwap(sql, SOURCE, [event("a", "A v1"), event("b", "B v1")]);
    expect(await journal()).toHaveLength(2);
  }, 30_000);

  it("a changed row journals an update; a dropped row journals a delete tombstone", async () => {
    await atomicSwap(sql, SOURCE, [event("a", "A v2")]);
    const entries = await journal();
    expect(entries.slice(2)).toEqual([
      { object_id: `${SOURCE}:a`, operation: "update" },
      { object_id: `${SOURCE}:b`, operation: "delete" },
    ]);
  }, 30_000);
});
