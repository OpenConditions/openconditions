import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { MIGRATION_SQL } from "@openconditions/core";
import { sweepStaleObservations } from "../pipeline/sweep.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const HOUR_MS = 3600_000;

async function insertRow(
  id: string,
  opts: { fetchedAt: Date; validTo?: Date | null; expiresAt?: Date | null }
): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, severity, headline,
       geom, origin, data_updated_at, fetched_at, valid_to, expires_at)
    VALUES (${id}, 'sweeptest', 'seed', 'roads', 'event', 'accident', 'high', ${id},
       ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[13.4,52.5]}'), 4326),
       ${sql.json({ kind: "feed", attribution: { provider: "test" } })},
       now(), ${opts.fetchedAt}, ${opts.validTo ?? null}, ${opts.expiresAt ?? null})`;
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
  sql = postgres(
    `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`,
    {
      max: 3,
    }
  );
  for (const statement of MIGRATION_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await sql.unsafe(statement);
  }
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("sweepStaleObservations", () => {
  it("removes expired + orphaned rows and keeps current ones", async () => {
    const now = new Date();
    await insertRow("keep", { fetchedAt: now });
    await insertRow("exp-validto", { fetchedAt: now, validTo: new Date(now.getTime() - HOUR_MS) });
    await insertRow("exp-expiresat", {
      fetchedAt: now,
      expiresAt: new Date(now.getTime() - HOUR_MS),
    });
    await insertRow("orphan", { fetchedAt: new Date(now.getTime() - 2 * HOUR_MS) });
    await insertRow("future", { fetchedAt: now, validTo: new Date(now.getTime() + HOUR_MS) });

    const result = await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(result.deleted).toBe(3);

    const remaining = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE source = 'sweeptest' ORDER BY id`;
    expect(remaining.map((r) => r.id)).toEqual(["future", "keep"]);
  }, 60_000);

  it("returns 0 when nothing is stale", async () => {
    const result = await sweepStaleObservations(sql, { maxAgeSec: 3600 });
    expect(result.deleted).toBe(0);
  }, 30_000);
});
