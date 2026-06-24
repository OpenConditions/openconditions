import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { observationsByBbox, type QueryRunner } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { sweepStaleObservations } from "../pipeline/sweep.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const HOUR_MS = 3600_000;

/** Adapt postgres-js to the QueryRunner (`execute`) interface observationsByBbox expects. */
function runner(): QueryRunner {
  return {
    async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
      const rows = p ? await sql.unsafe(q, p as never[]) : await sql.unsafe(q);
      return rows as T;
    },
  };
}

async function insertRow(
  id: string,
  opts: {
    fetchedAt: Date;
    validTo?: Date | null;
    expiresAt?: Date | null;
    staleAfter?: Date | null;
  }
): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, severity, headline,
       geom, origin, data_updated_at, fetched_at, valid_to, expires_at, stale_after)
    VALUES (${id}, 'sweeptest', 'seed', 'roads', 'event', 'accident', 'high', ${id},
       ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[13.4,52.5]}'), 4326),
       ${sql.json({ kind: "feed", attribution: { provider: "test" } })},
       now(), ${opts.fetchedAt}, ${opts.validTo ?? null}, ${opts.expiresAt ?? null}, ${opts.staleAfter ?? null})`;
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

describe("observationsByBbox is_stale derivation", () => {
  it("flags rows whose stale_after has passed, but not fresh / no-window rows", async () => {
    const now = new Date();
    await insertRow("st-fresh", { fetchedAt: now, staleAfter: new Date(now.getTime() + HOUR_MS) });
    await insertRow("st-stale", { fetchedAt: now, staleAfter: new Date(now.getTime() - HOUR_MS) });
    await insertRow("st-nowin", { fetchedAt: now, staleAfter: null });

    const fc = await observationsByBbox(runner(), { domain: "roads", bbox: [13, 52, 14, 53] });
    const byId = new Map(fc.features.map((f) => [f.properties?.id, f.properties?.is_stale]));
    expect(byId.get("st-fresh")).toBe(false);
    expect(byId.get("st-stale")).toBe(true);
    expect(byId.get("st-nowin")).toBe(false);
  }, 30_000);
});
