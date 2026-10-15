import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogFeed, LookupFn } from "@openconditions/ingest-framework";
import {
  ensureObservationPartitions,
  retentionClasses,
  sweepRecords,
  syncSources,
} from "@openconditions/storage";
import Fastify, { type FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, type RunResult, runSource } from "../pipeline/run.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { registry } from "./helpers/situations.js";

/**
 * Digitraffic's maintenance tracking polled through the pipeline over a stub
 * upstream serving the vehicles package's capture, and read back through the
 * API: anonymous positions that stand ten minutes from their report or until
 * the vehicle moves on, a poll with no vehicle out that is no failure, and a
 * sweep that ends the series.
 */

type Rec = Record<string, unknown>;

const FIXTURES = join(import.meta.dirname, "../../../../packages/vehicles/src/__tests__/fixtures");
const LATEST = readFileSync(join(FIXTURES, "fi-digitraffic-maintenance-latest.json"), "utf8");
const EMPTY = JSON.stringify({ type: "FeatureCollection", features: [] });
const SOURCE = "fi-digitraffic-maintenance";
/** The fetch the capture was taken by. */
const CAPTURED = "2026-10-14T23:24:56.000Z";

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

let clock = CAPTURED;
let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date("2026-10-14T00:00:00Z"),
  });
  await syncSources(
    sql,
    REPO_CATALOG.feeds.filter((feed) => feed.domain === "vehicles").map((feed) => ({ ...feed })),
  );
  app = Fastify();
  registerScope(app, "operator-token-of-the-vehicles-pipeline-suite");
  registerApiRoutes(app, sql, { registry, now: () => new Date(clock), catalog: REPO_CATALOG });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

describe("fi-digitraffic-maintenance through the pipeline", () => {
  let body = LATEST;
  const feed = repoFeed(SOURCE) as CatalogFeed;
  const roles = createRoleState();
  const fetch = (async () => new Response(body)) as unknown as typeof globalThis.fetch;
  const poll = (at: string): Promise<RunResult> => {
    clock = at;
    return runSource(feed, {
      sql,
      fetch,
      now: () => at,
      lookup: fakeLookup,
      model: { registry, instanceId: "test.local" },
      roles,
    });
  };
  const series = async () =>
    sql<{ subject_kind: string; feature_id: string | null; expires_at: Date }[]>`
      SELECT subject_kind, feature_id, expires_at FROM conditions.observation_latest
       WHERE source_id = ${SOURCE} ORDER BY expires_at`;
  const positions = async (at: string) => {
    clock = at;
    const res = await app.inject({
      method: "GET",
      url: "/observations/latest?property=vehicle.position&bbox=19,59,32,71",
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { records: Rec[] }).records;
  };

  it("writes each current tracking as an anonymous position, once per series", async () => {
    const first = await poll(CAPTURED);
    expect(first.error).toBeUndefined();
    const written = await series();
    expect(written).toHaveLength(8);
    expect(written.every((s) => s.subject_kind === "location" && s.feature_id === null)).toBe(true);

    const again = await poll("2026-10-14T23:25:56.000Z");
    expect(again.error).toBeUndefined();
    expect(await series()).toHaveLength(8);

    const read = await positions("2026-10-14T23:26:00.000Z");
    expect(read).toHaveLength(8);
    expect(read[0]).toMatchObject({
      property: "vehicle.position",
      subject: { kind: "location" },
      provenance: { sourceId: SOURCE, upstream: [{ publisher: "Harja/Väylävirasto" }] },
    });
    // Ten minutes after 23:21:16 only the last two reports stand.
    expect(await positions("2026-10-14T23:31:30.000Z")).toHaveLength(1);
  }, 60_000);

  it("ends the position a vehicle moved on from with the poll that no longer states it", async () => {
    // Digitraffic's next answer holds the vehicle of 202635031 under a new tracking, further north.
    const doc = JSON.parse(LATEST) as { features: { properties: Rec; geometry: Rec }[] };
    const moved = doc.features.find((f) => f.properties["id"] === 202635031)!;
    moved.properties["id"] = 202635100;
    moved.properties["time"] = "2026-10-14T23:26:10Z";
    moved.geometry["coordinates"] = [25.508, 65.019, 0];
    body = JSON.stringify(doc);
    const result = await poll("2026-10-14T23:26:30.000Z");
    expect(result.error).toBeUndefined();

    const written = await series();
    expect(written).toHaveLength(9);
    expect(
      written.filter((s) => s.expires_at.toISOString() === "2026-10-14T23:26:30.000Z"),
    ).toHaveLength(1);
    const read = await positions("2026-10-14T23:26:31.000Z");
    expect(read).toHaveLength(8);
    const ids = read.map((r) => (r["provenance"] as Rec)["recordId"]);
    expect(ids).toContain("202635100");
    expect(ids).not.toContain("202635031");
  }, 60_000);

  it("closes a poll with no vehicle out as a complete empty answer, keeping the earlier positions", async () => {
    body = EMPTY;
    const result = await poll("2026-10-14T23:27:00.000Z");
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("complete_empty");
    const [status] = await sql<{ last_error: string | null }[]>`
      SELECT last_error FROM conditions.source_status WHERE source = ${SOURCE}`;
    expect(status!.last_error).toBeNull();
    expect(await series()).toHaveLength(9);
    expect(await positions("2026-10-14T23:27:01.000Z")).toHaveLength(8);
  }, 60_000);

  it("the sweep ends every position once it has expired", async () => {
    const swept = await sweepRecords(sql, {
      registry,
      instanceId: "test.local",
      now: "2026-10-14T23:40:00.000Z",
      maxAgeSec: 3600,
      historyDays: 90,
    });
    expect(swept.transient).toBe(9);
    expect(await series()).toEqual([]);
  }, 60_000);
});
