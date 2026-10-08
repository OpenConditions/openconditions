import { type CatalogFeed, type Cell, cellsCovering } from "@openconditions/ingest-framework";
import {
  ensureObservationPartitions,
  retentionClasses,
  sweepRecords,
} from "@openconditions/storage";
import Fastify, { type FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { InFlight, shutdown } from "../shutdown.js";
import {
  fakeLookup,
  onDemandFeed,
  registry,
  START,
  stationOf,
  upstream,
} from "./helpers/on-demand.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

vi.mock("../domains.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../domains.js")>();
  const { testDomain: domain } = await import("./helpers/on-demand.js");
  const isTest = (feed: { domain: string }) => feed.domain === "fuel";
  return {
    ...original,
    domainOf: (feed: Parameters<typeof original.domainOf>[0]) =>
      isTest(feed) ? domain : original.domainOf(feed),
    formatOf: (feed: Parameters<typeof original.formatOf>[0]) =>
      isTest(feed) ? domain.formats[feed.format]! : original.formatOf(feed),
  };
});

type Rec = Record<string, unknown>;

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, { classes: retentionClasses(registry), now: START });
  // The capture journals only for a subscriber: this one wants every class
  // and fuel prices.
  await sql`
    INSERT INTO conditions.federation_subscription
      (id, peer_id, delivery_mode, filter, created_at, updated_at)
    VALUES ('sub-on-demand', 'peer-on-demand', 'pull',
            ${sql.json({ properties: ["fuel.price"] })}, now(), now())`;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

/** The 0.1° cell whose south-west corner is given. */
const cellAt = (west: number, south: number): Cell =>
  cellsCovering([west, south, west + 0.1, south + 0.1], 0.1)[0]!;

/** Two cells of 0.1°: 0.1/80/490 and 0.1/81/490. */
const TWO_CELLS = "8,49,8.2,49.1";

/** One test's source, its stub upstream, its clock and the record API reading through it. */
function harness(
  operator: string,
  opts: { deadlineMs?: number; feed?: CatalogFeed; pool?: postgres.Sql; inFlight?: InFlight } = {},
) {
  const feed = opts.feed ?? onDemandFeed(operator);
  const up = upstream();
  const clock = { now: new Date(START) };
  const app: FastifyInstance = Fastify();
  registerApiRoutes(app, opts.pool ?? sql, {
    registry,
    now: () => clock.now,
    onDemand: {
      catalog: { feeds: [feed] },
      fetch: up.fetch,
      lookup: fakeLookup,
      deadlineMs: opts.deadlineMs ?? 5000,
      instanceId: "test.local",
      ...(opts.inFlight ? { inFlight: opts.inFlight } : {}),
    },
  });
  const get = async (path: string) => {
    const res = await app.inject({ method: "GET", url: path });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Rec & { records: Rec[]; coverage?: Rec };
  };
  const features = (bbox?: string, extra = "") =>
    get(`/features?kind=fuel_station&source=${feed.id}${bbox ? `&bbox=${bbox}` : ""}${extra}`);
  const ledger = async () =>
    sql<{ cell: string; status: string; expires_at: Date | null; retry_at: Date | null }[]>`
      SELECT cell, status, expires_at, retry_at FROM conditions.on_demand_fetch
       WHERE source_id = ${feed.id} ORDER BY cell`;
  const advance = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  return { feed, up, clock, app, get, features, ledger, advance };
}

const complete = (id: string) => ({ partial: false, sources: [{ id, complete: true }] });
const partial = (id: string, reason: string) => ({
  partial: true,
  sources: [{ id, complete: false, reason }],
});

describe("on-demand read-through", () => {
  test("a bbox read fetches the stale cells once and answers from storage", async () => {
    const h = harness("once");
    const read = await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(2);
    expect(read.coverage).toEqual(complete(h.feed.id));
    expect(read.records.map((r) => r["id"]).sort()).toEqual(
      [
        `oc:feature:${h.feed.id}:${stationOf(8, 49)}`,
        `oc:feature:${h.feed.id}:${stationOf(8.1, 49)}`,
      ].sort(),
    );
    const expiresAt = new Date(START.getTime() + 900_000).toISOString();
    for (const record of read.records) {
      expect(record["provenance"]).toMatchObject({
        accessMode: "on_demand",
        attribution: { provider: "Test cell stations", license: "CC0-1.0" },
      });
      expect((record["freshness"] as Rec)["expiresAt"]).toBe(expiresAt);
    }
    expect((await h.ledger()).map((r) => [r.cell, r.status, r.expires_at?.toISOString()])).toEqual([
      ["0.1/80/490", "fresh", expiresAt],
      ["0.1/81/490", "fresh", expiresAt],
    ]);
    const [status] = await sql<{ last_outcome: string }[]>`
      SELECT last_outcome FROM conditions.source_status WHERE source = ${h.feed.id}`;
    expect(status?.last_outcome).toBe("changed");

    // The readings and offers of the same area are already in storage.
    const latest = await h.get(
      `/observations/latest?property=fuel.price&source=${h.feed.id}&bbox=${TWO_CELLS}`,
    );
    expect(latest.records).toHaveLength(2);
    expect(latest.coverage).toEqual(complete(h.feed.id));
    const offers = await h.get(`/offers?kind=energy_tariff&source=${h.feed.id}&bbox=${TWO_CELLS}`);
    expect(offers.records).toHaveLength(2);
    expect(offers.coverage).toEqual(complete(h.feed.id));
    expect(h.up.calls).toHaveLength(2);
  }, 60_000);

  test("a fresh cell is not refetched until it expires", async () => {
    const h = harness("fresh");
    await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(2);
    h.advance(899);
    const cached = await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(2);
    expect(cached.coverage).toEqual(complete(h.feed.id));
    expect(cached.records).toHaveLength(2);
    h.advance(2);
    const refreshed = await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(4);
    expect(refreshed.coverage).toEqual(complete(h.feed.id));
    expect(refreshed.records).toHaveLength(2);
  }, 60_000);

  test("concurrent reads of one stale cell share one upstream fetch", async () => {
    const h = harness("flight");
    const release = h.up.hold();
    const reads = Promise.all([h.features("8,49,8.1,49.1"), h.features("8.02,49.02,8.08,49.08")]);
    await vi.waitFor(() => expect(h.up.calls).toHaveLength(1));
    // Another process reading the same cell finds it claimed and does not
    // fetch it; once the claimant wrote it, it finds it fresh.
    vi.resetModules();
    const other = await import("../on-demand/fetch-cell.js");
    const otherSql = postgres(db.url, { max: 2 });
    try {
      const elsewhere = () =>
        other.fetchCell(otherSql, h.feed, cellAt(8, 49), {
          fetch: h.up.fetch,
          now: () => h.clock.now,
          registry,
          instanceId: "test.local",
          lookup: fakeLookup,
        });
      expect(await elsewhere()).toBe("busy");
      release();
      const [first, second] = await reads;
      expect(await elsewhere()).toBe("fresh");
      expect(h.up.calls).toHaveLength(1);
      for (const read of [first, second]) {
        expect(read.coverage).toEqual(complete(h.feed.id));
        expect(read.records).toHaveLength(1);
      }
    } finally {
      await otherSql.end();
    }
  }, 60_000);

  test("a claim its claimant never cleared lapses, and a running one is respected", async () => {
    const h = harness("claimed");
    const claim = (until: Date) => sql`
      INSERT INTO conditions.on_demand_fetch (source_id, cell, status, claimed_until)
      VALUES (${h.feed.id}, '0.1/80/490', 'pending', ${until})
      ON CONFLICT (source_id, cell) DO UPDATE SET claimed_until = EXCLUDED.claimed_until`;
    await claim(new Date(START.getTime() + 60_000));
    const running = await h.features("8,49,8.1,49.1");
    expect(h.up.calls).toHaveLength(0);
    expect(running.coverage).toEqual(partial(h.feed.id, "deadline"));

    // The claimant crashed: its claim ran out.
    await claim(new Date(START.getTime() - 1000));
    const lapsed = await h.features("8,49,8.1,49.1");
    expect(h.up.calls).toHaveLength(1);
    expect(lapsed.coverage).toEqual(complete(h.feed.id));
    expect(lapsed.records).toHaveLength(1);
    const [row] = await h.ledger();
    expect(row).toMatchObject({ status: "fresh" });
    const [cleared] = await sql<{ claimed_until: Date | null }[]>`
      SELECT claimed_until FROM conditions.on_demand_fetch
       WHERE source_id = ${h.feed.id} AND cell = '0.1/80/490'`;
    expect(cleared!.claimed_until).toBeNull();
  }, 60_000);

  test("a fetch that lost its claim while it ran drops its write", async () => {
    const inFlight = new InFlight();
    const h = harness("lost-claim", { deadlineMs: 100, inFlight });
    const release = h.up.hold();
    const read = await h.features("8,49,8.1,49.1");
    expect(read.coverage).toEqual(partial(h.feed.id, "deadline"));

    // The fetch outlived its claim, and another fetcher claimed the cell.
    const taken = new Date(START.getTime() + 5 * 60_000);
    await sql`
      UPDATE conditions.on_demand_fetch SET claimed_until = ${taken}
       WHERE source_id = ${h.feed.id} AND cell = '0.1/80/490'`;
    release();
    await inFlight.done;

    expect(h.up.calls).toHaveLength(1);
    const [row] = await sql<{ status: string; claimed_until: Date | null }[]>`
      SELECT status, claimed_until FROM conditions.on_demand_fetch
       WHERE source_id = ${h.feed.id} AND cell = '0.1/80/490'`;
    expect(row).toEqual({ status: "pending", claimed_until: taken });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.feature WHERE source_id = ${h.feed.id}`;
    expect(n).toBe(0);
    const attempts = await sql<{ outcome: string }[]>`
      SELECT outcome FROM conditions.source_poll_attempt WHERE source = ${h.feed.id}`;
    expect(attempts.map((a) => a.outcome)).toEqual(["skipped_overlap"]);
  }, 60_000);

  test("a slow upstream holds no database connection", async () => {
    // A pool of one connection: a fetch holding it would starve every query.
    const pool = postgres(db.url, { max: 1 });
    try {
      const h = harness("connection", { pool, deadlineMs: 100 });
      const release = h.up.hold();
      const read = await h.features("8,49,8.1,49.1");
      expect(read.coverage).toEqual(partial(h.feed.id, "deadline"));
      expect(h.up.calls).toHaveLength(1);
      const [probe] = await Promise.race([
        pool<{ ok: number }[]>`SELECT 1 AS ok`,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("the pool is held")), 2000).unref(),
        ),
      ]);
      expect(probe!.ok).toBe(1);
      release();
      await vi.waitFor(async () =>
        expect((await h.ledger()).map((r) => r.status)).toEqual(["fresh"]),
      );
    } finally {
      await pool.end();
    }
  }, 60_000);

  test("a wide read fetches all its cells within the deadline when the upstream is quick", async () => {
    const h = harness("quick", { deadlineMs: 2000 });
    // Four cells, the source's cap.
    const read = await h.features("8,49,8.2,49.2");
    expect(h.up.calls).toHaveLength(4);
    expect(read.coverage).toEqual(complete(h.feed.id));
    expect(read.records).toHaveLength(4);
  }, 60_000);

  test("a cell with no stations is recorded as an empty answer", async () => {
    const h = harness("empty");
    h.up.answerEmpty(true);
    const read = await h.features("8,49,8.1,49.1");
    expect(read.coverage).toEqual(complete(h.feed.id));
    expect(read.records).toEqual([]);
    const [status] = await sql<{ last_outcome: string }[]>`
      SELECT last_outcome FROM conditions.source_status WHERE source = ${h.feed.id}`;
    expect(status?.last_outcome).toBe("complete_empty");
  }, 60_000);

  test("a read wider than maxCellsPerRead fetches nothing and is partial", async () => {
    const h = harness("wide");
    // Six cells, the source's cap is four.
    const read = await h.features("8,49,8.3,49.2");
    expect(h.up.calls).toHaveLength(0);
    expect(read.coverage).toEqual(partial(h.feed.id, "too_many_cells"));
    expect(read.records).toEqual([]);
    expect(await h.ledger()).toEqual([]);
  }, 60_000);

  test("a failed cell keeps the old rows and is not refetched within its backoff", async () => {
    const h = harness("failed");
    await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(2);
    h.advance(901);
    h.up.fail(true);
    const failed = await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(4);
    expect(failed.coverage).toEqual(partial(h.feed.id, "failed"));
    const retryAt = new Date(h.clock.now.getTime() + 120_000).toISOString();
    expect((await h.ledger()).map((r) => [r.status, r.retry_at?.toISOString()])).toEqual([
      ["failed", retryAt],
      ["failed", retryAt],
    ]);
    const [kept] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.feature
       WHERE source_id = ${h.feed.id} AND tombstoned_at IS NULL`;
    expect(kept!.n).toBe(2);
    const [status] = await sql<{ last_outcome: string; last_error: string | null }[]>`
      SELECT last_outcome, last_error FROM conditions.source_status WHERE source = ${h.feed.id}`;
    expect(status?.last_outcome).toBe("failed");
    expect(status?.last_error).toMatch(/503/);

    h.up.fail(false);
    h.advance(119);
    const backingOff = await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(4);
    expect(backingOff.coverage).toEqual(partial(h.feed.id, "failed"));
    h.advance(2);
    const retried = await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(6);
    expect(retried.coverage).toEqual(complete(h.feed.id));
    expect(retried.records).toHaveLength(2);
  }, 60_000);

  test("an upstream slower than the deadline: the read answers without it, the write lands later", async () => {
    const h = harness("deadline", { deadlineMs: 200 });
    const release = h.up.hold();
    const started = Date.now();
    const read = await h.features("8,49,8.1,49.1");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(read.coverage).toEqual(partial(h.feed.id, "deadline"));
    expect(read.records).toEqual([]);
    // Claimed, not yet answered.
    expect((await h.ledger()).map((r) => r.status)).toEqual(["pending"]);

    release();
    await vi.waitFor(async () =>
      expect((await h.ledger()).map((r) => r.status)).toEqual(["fresh"]),
    );
    const later = await h.features("8,49,8.1,49.1");
    expect(h.up.calls).toHaveLength(1);
    expect(later.coverage).toEqual(complete(h.feed.id));
    expect(later.records).toHaveLength(1);
  }, 60_000);

  test("shutdown waits for a cell fetch the read left running past its deadline", async () => {
    const inFlight = new InFlight();
    const h = harness("shutdown", { deadlineMs: 100, inFlight });
    const release = h.up.hold();
    const read = await h.features("8,49,8.1,49.1");
    expect(read.coverage).toEqual(partial(h.feed.id, "deadline"));

    let ledgerAtEnd: string[] | undefined;
    const closing = shutdown({
      stop: [],
      background: [inFlight],
      app: h.app,
      // The database stays open for the other tests; what matters is what
      // the fetch wrote by the time shutdown would close it.
      sql: {
        end: async () => {
          ledgerAtEnd = (await h.ledger()).map((r) => r.status);
        },
      },
    });
    setTimeout(release, 50);
    await closing;
    expect(ledgerAtEnd).toEqual(["fresh"]);
  }, 60_000);

  test("a read without bbox, or outside every coverage, never fetches", async () => {
    const h = harness("never");
    const unbounded = await h.features();
    expect(unbounded.coverage).toBeUndefined();
    const outside = await h.features("10,49,10.1,49.1");
    expect(outside.coverage).toBeUndefined();
    // A kind, property or domain the source does not produce.
    const ferry = await h.get(`/features?kind=ferry_terminal&bbox=${TWO_CELLS}`);
    expect(ferry.coverage).toBeUndefined();
    const speed = await h.get(`/observations/latest?property=traffic.speed&bbox=${TWO_CELLS}`);
    expect(speed.coverage).toBeUndefined();
    const roads = await h.get(`/features?domain=roads&bbox=${TWO_CELLS}`);
    expect(roads.coverage).toBeUndefined();
    // A read naming other sources, or for a past instant.
    const other = await h.get(`/features?kind=fuel_station&source=de-other-fuel&bbox=${TWO_CELLS}`);
    expect(other.coverage).toBeUndefined();
    const past = new Date(START.getTime() - 3_600_000).toISOString();
    const history = await h.features(TWO_CELLS, `&at=${past}`);
    expect(history.coverage).toBeUndefined();
    const latestThen = await h.get(
      `/observations/latest?property=fuel.price&bbox=${TWO_CELLS}&at=${past}`,
    );
    expect(latestThen.coverage).toBeUndefined();
    // Neither do the GeoJSON and JSON-LD variants.
    for (const variant of ["geojson", "jsonld"]) {
      const res = await h.app.inject({
        method: "GET",
        url: `/features.${variant}?kind=fuel_station&bbox=${TWO_CELLS}`,
      });
      expect(res.statusCode).toBe(200);
    }
    expect(h.up.calls).toHaveLength(0);

    // The domain alone reads through.
    const fuel = await h.get(`/features?domain=fuel&source=${h.feed.id}&bbox=${TWO_CELLS}`);
    expect(fuel.coverage).toEqual(complete(h.feed.id));
    expect(h.up.calls).toHaveLength(2);
  }, 60_000);

  test("an expired on-demand feature read by id refetches its own cell and answers fresh, or 404 when gone", async () => {
    const h = harness("byid");
    await h.features(TWO_CELLS);
    expect(h.up.calls).toHaveLength(2);
    const id = `oc:feature:${h.feed.id}:${stationOf(8, 49)}`;
    const byId = (featureId: string) =>
      h.app.inject({ method: "GET", url: `/features/${encodeURIComponent(featureId)}` });

    // Expired, not yet swept: the read refetches the one cell holding it.
    h.advance(901);
    const fresh = await byId(id);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(h.up.calls).toHaveLength(3);
    expect(h.up.calls[2]!.searchParams.get("w")).toBe("8");
    expect(h.up.calls[2]!.searchParams.get("s")).toBe("49");
    const record = (fresh.json() as Rec)["record"] as Rec;
    expect((record["freshness"] as Rec)["expiresAt"]).toBe(
      new Date(h.clock.now.getTime() + 900_000).toISOString(),
    );

    // So does a read of its canonical feature.
    const canonicalId = ((fresh.json() as Rec)["canonical"] as Rec)["canonicalFeatureId"] as string;
    h.advance(901);
    const cluster = await byId(canonicalId);
    expect(cluster.statusCode, cluster.body).toBe(200);
    expect(h.up.calls).toHaveLength(4);

    // The upstream no longer lists the station: it is gone.
    h.advance(901);
    h.up.answerEmpty(true);
    expect((await byId(id)).statusCode).toBe(404);
    expect(h.up.calls).toHaveLength(5);
  }, 60_000);

  test("on-demand records expire and are swept, and never enter the outbox", async () => {
    const h = harness("swept");
    await h.features(TWO_CELLS);
    await h.get(`/observations/latest?property=fuel.price&source=${h.feed.id}&bbox=${TWO_CELLS}`);
    const count = async (table: string) => {
      const [row] = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM conditions.${table} WHERE source_id = $1`,
        [h.feed.id],
      );
      return row!.n;
    };
    expect(await count("feature")).toBe(2);
    expect(await count("offer")).toBe(2);
    expect(await count("observation_latest")).toBe(2);
    const [journal] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.federation_outbox
       WHERE record_id LIKE ${`%${h.feed.id}%`} OR snapshot::text LIKE ${`%${h.feed.id}%`}`;
    expect(journal!.n).toBe(0);

    const sweep = (at: Date) =>
      sweepRecords(sql, {
        registry,
        instanceId: "test.local",
        now: at.toISOString(),
        maxAgeSec: 86_400,
        historyDays: 30,
      });
    await sweep(new Date(START.getTime() + 899_000));
    expect(await count("feature")).toBe(2);
    const swept = await sweep(new Date(START.getTime() + 901_000));
    expect(swept.dropped).toBeGreaterThanOrEqual(6);
    expect(await count("feature")).toBe(0);
    expect(await count("offer")).toBe(0);
    expect(await count("observation_latest")).toBe(0);
  }, 60_000);
});
