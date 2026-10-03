import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { runMigrations } from "@openconditions/core/server";
import type { LookupFn } from "@openconditions/ingest-framework";
import { encodeOpenlrLine } from "@openconditions/openlr";
import { FEED_SOURCES, recordSkippedNoGeometry } from "@openconditions/roads";
import {
  ensureObservationPartitions,
  retentionClasses,
  writeSnapshotIn,
} from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearResolveCache } from "../pipeline/resolve.js";
import type { DomainFeedSource } from "../pipeline/run.js";
import { runSource } from "../pipeline/run.js";
import { clearSiteTableCache } from "../pipeline/site-table.js";
import { bindSituation, registry, situationDraft, writeSituations } from "./helpers/situations.js";

const NDW_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/ndw/actueel_beeld.xml",
);

const DRIVEBC_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/drivebc/events.json",
);

const NDW_FLOW_SPEED_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/ndw-flow/trafficspeed.xml",
);

const NDW_FLOW_SITE_TABLE_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/ndw-flow/measurement_site_table.xml",
);

const ndwFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "nl-ndw")!,
  domain: "roads",
};

const drivebcFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "ca-bc-drivebc")!,
  domain: "roads",
};

const ndwFlowFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "nl-ndw-flow")!,
  domain: "roads",
};

// These e2e tests inject a fake `fetch` to serve local fixtures instead of the
// real feed hosts, but `runSource` still resolves the feed host via DNS to pin
// the egress connection before calling it. Injecting a fake lookup here keeps
// the suite hermetic — it never depends on the real feed hosts' DNS being up.
const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://oc:oc@${host}:${port}/conditions_test`;
  sql = postgres(url, { max: 3 });

  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

/** How many situations of `source` are live: a withdrawn one is tombstoned, not deleted. */
async function liveSituations(source: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.situation
     WHERE source_id = ${source} AND tombstoned_at IS NULL`;
  return row!.n;
}

describe("pipeline — happy path", () => {
  it("publishes situations from the NDW fixture into conditions.situation", async () => {
    const xmlPayload = readFileSync(NDW_FIXTURE_PATH);

    const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(xmlPayload, { status: 200 });
    };

    const result = await runSource(ndwFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBeGreaterThan(0);
    console.info(`[test] inserted ${result.count} rows`);

    expect(await liveSituations("nl-ndw")).toBe(result.count);
    const wrongRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.situation
      WHERE domain <> 'roads' OR source_id <> 'nl-ndw'
    `;
    expect(parseInt(wrongRows[0]!.count, 10)).toBe(0);
  }, 60_000);

  it("all inserted geometries are valid PostGIS geometries", async () => {
    const seeded = await runSource(ndwFeed, {
      sql,
      fetch: async () => new Response(readFileSync(NDW_FIXTURE_PATH)),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seeded.error).toBeUndefined();
    expect(await liveSituations(ndwFeed.id)).toBeGreaterThan(0);
    const invalid = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.situation
      WHERE NOT ST_IsValid(geom)
    `;
    expect(parseInt(invalid[0]!.count, 10)).toBe(0);

    const rows = await sql<{ record: Record<string, unknown> }[]>`
      SELECT record
      FROM conditions.situation
      WHERE domain = 'roads'
      LIMIT 100
    `;
    expect(rows.some((r) => typeof r.record["planned"] === "boolean")).toBe(true);
  }, 30_000);
});

describe("pipeline — payload digests", () => {
  it("records the sha256 of each downloaded payload on the poll attempt it published from", async () => {
    const body = readFileSync(NDW_FIXTURE_PATH);
    const result = await runSource(ndwFeed, {
      sql,
      fetch: async () => new Response(gzipSync(body)),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(result.error).toBeUndefined();
    const attempts = await sql<{ payload_hashes: string[] | null }[]>`
      SELECT payload_hashes FROM conditions.source_poll_attempt
      WHERE source = ${ndwFeed.id} ORDER BY id DESC LIMIT 1
    `;
    // Transport gzip does not change the identity: the digest is of the decoded body.
    expect(attempts[0]!.payload_hashes).toEqual([createHash("sha256").update(body).digest("hex")]);
  }, 30_000);
});

describe("pipeline — feed downtime", () => {
  it("leaves existing rows intact when fetch throws", async () => {
    const seeded = await runSource(ndwFeed, {
      sql,
      fetch: async () => new Response(readFileSync(NDW_FIXTURE_PATH)),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seeded.error).toBeUndefined();
    const countBefore = await liveSituations("nl-ndw");
    expect(countBefore).toBeGreaterThan(0);

    const throwingFetch = async (_url: string | URL | Request): Promise<Response> => {
      throw new Error("simulated network failure");
    };

    const result = await runSource(ndwFeed, {
      sql,
      fetch: throwingFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBe(0);
    expect(await liveSituations("nl-ndw")).toBe(countBefore);
  }, 30_000);
});

describe("pipeline — open511 (DriveBC)", () => {
  it("inserts rows from the DriveBC fixture with source='ca-bc-drivebc' and domain='roads'", async () => {
    const jsonPayload = readFileSync(DRIVEBC_FIXTURE_PATH);

    const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(jsonPayload, { status: 200 });
    };

    const result = await runSource(drivebcFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBeGreaterThan(0);
    console.info(`[test] drivebc: inserted ${result.count} rows`);

    expect(await liveSituations("ca-bc-drivebc")).toBe(result.count);
    const wrongRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.situation
      WHERE source_id = 'ca-bc-drivebc' AND (domain <> 'roads')
    `;
    expect(parseInt(wrongRows[0]!.count, 10)).toBe(0);
  }, 60_000);

  it("does not carry a crashed run's no-geometry count into the next successful run", async () => {
    // Most failure paths return before the drain at the end of runSource, so a run
    // that parsed and then failed leaves its count behind. Stand in for that
    // leftover directly — the reset at the top of the run must discard it, or the
    // next healthy cycle reports a loss that already happened.
    recordSkippedNoGeometry("ca-bc-drivebc", 999);

    const jsonPayload = readFileSync(DRIVEBC_FIXTURE_PATH);
    const result = await runSource(drivebcFeed, {
      sql,
      fetch: (async () => new Response(jsonPayload, { status: 200 })) as unknown as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.error).toBeUndefined();
    // The fixture drops nothing, so this cycle's honest answer is "no loss".
    expect(result.skippedNoGeometry).toBeUndefined();
  }, 60_000);

  it("all DriveBC geometries are valid PostGIS geometries", async () => {
    expect(await liveSituations("ca-bc-drivebc")).toBeGreaterThan(0);
    const invalid = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.situation
      WHERE source_id = 'ca-bc-drivebc' AND NOT ST_IsValid(geom)
    `;
    expect(parseInt(invalid[0]!.count, 10)).toBe(0);
  }, 30_000);
});

describe("writeSnapshotIn — binding work", () => {
  it("queues a changed situation's binding work in the same transaction as its new revision", async () => {
    const id = "oc:situation:binding-atomic:event";
    const changed = situationDraft(
      "event",
      { headline: [{ lang: "de", text: "A 46 geändert" }] },
      "binding-atomic",
    );
    await writeSituations(sql, "binding-atomic", [situationDraft("event", {}, "binding-atomic")]);
    await bindSituation(sql, id, {
      status: "exact",
      confidence: 0.95,
      revision: 1,
      generation: "test-graph",
      resolverVersion: "test",
    });
    await sql`DELETE FROM conditions.binding_queue WHERE record_id = ${id}`;

    // A write that rolls back leaves neither the new revision nor its work.
    await expect(
      sql.begin(async (tx) => {
        await writeSnapshotIn(
          tx,
          "binding-atomic",
          { situations: [changed] },
          { registry, instanceId: "test.local", now: "2026-09-11T10:01:00Z", complete: true },
        );
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    const [kept] = await sql<{ revision: number }[]>`
      SELECT revision FROM conditions.situation WHERE id = ${id}`;
    expect(kept!.revision).toBe(1);
    expect(await sql`SELECT 1 FROM conditions.binding_queue WHERE record_id = ${id}`).toHaveLength(
      0,
    );

    await writeSituations(sql, "binding-atomic", [changed], "2026-09-11T10:01:00Z");
    const [row] = await sql<{ current: number; queued: number; bound: number }[]>`
      SELECT s.revision AS current, q.record_revision AS queued, b.record_revision AS bound
      FROM conditions.situation s
      JOIN conditions.binding_queue q ON q.record_class = 'situation' AND q.record_id = s.id
      JOIN conditions.record_binding b ON b.record_class = 'situation' AND b.record_id = s.id
      WHERE s.id = ${id}
    `;
    // The work names the new revision; the stored binding still names the old
    // one, so it no longer counts as current for the situation.
    expect(row).toEqual({ current: 2, queued: 2, bound: 1 });
  }, 30_000);
});

/** Live measurement sites of a source: a site missing from one poll is not withdrawn. */
async function liveFeatures(source: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.feature
     WHERE source_id = ${source} AND tombstoned_at IS NULL`;
  return row!.n;
}

/** Series of a source, as `<property>@<site>[#<channel>]`. */
async function seriesOf(source: string): Promise<string[]> {
  const rows = await sql<{ s: string }[]>`
    SELECT property || '@' || substr(subject_key, length(${`feature:oc:feature:${source}:`}) + 1) AS s
      FROM conditions.observation_latest WHERE source_id = ${source} ORDER BY 1`;
  return rows.map((r) => r.s);
}

describe("flow feed — e2e pipeline (NDW site-table join)", () => {
  // A fetch stub that serves the trafficspeed measurements for the data URL and
  // the site table for the companion site-table URL, gzipping both since the
  // feed declares gzip. The site-table cache is cleared first so the stub is hit.
  const speedPayload = readFileSync(NDW_FLOW_SPEED_FIXTURE_PATH);
  const sitePayload = readFileSync(NDW_FLOW_SITE_TABLE_FIXTURE_PATH);
  const fetchServing =
    (speed: Buffer) =>
    async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz") ? gzipSync(sitePayload) : gzipSync(speed);
      return new Response(body, { status: 200 });
    };
  const fakeFetch = fetchServing(speedPayload);
  const poll = (fetchFn: typeof fakeFetch, now = () => new Date().toISOString()) =>
    runSource(ndwFlowFeed, { sql, fetch: fetchFn as typeof fetch, now, lookup: fakeLookup });

  it("runSource joins the site table and writes measurement sites and their readings", async () => {
    clearSiteTableCache();
    const result = await poll(fakeFetch);
    expect(result.error).toBeUndefined();
    expect(result.count).toBeGreaterThan(0);

    // Three sites resolve (Point + LineString + the genuine standstill); the
    // rest are skipped (no-data zero/sentinel, absurd speed, missing geometry).
    expect(await liveFeatures("nl-ndw-flow")).toBe(3);
    expect(await seriesOf("nl-ndw-flow")).toEqual([
      "traffic.speed@PZH01_MST_0029-00",
      "traffic.speed@PZH01_MST_0065_00",
      "traffic.speed@PZH01_MST_0065_00#11",
      "traffic.speed@PZH01_MST_0065_00#8",
      "traffic.speed@PZH01_MST_0065_00#9",
      "traffic.speed@PZH01_MST_STANDSTILL_00",
      "traffic.volume@PZH01_MST_0065_00",
      "traffic.volume@PZH01_MST_0065_00#1",
      "traffic.volume@PZH01_MST_0065_00#3",
      "traffic.volume@PZH01_MST_0065_00#5",
    ]);
    // No baseline is stored, so no level of service and no derived congestion.
    expect(await liveSituations("nl-ndw-flow")).toBe(0);
    const [status] = await sql<{ last_row_count: number; last_success_at: Date | null }[]>`
      SELECT last_row_count, last_success_at FROM conditions.source_status
       WHERE source = 'nl-ndw-flow'`;
    expect(status).toMatchObject({ last_row_count: 3 });
    expect(status!.last_success_at).not.toBeNull();
  }, 60_000);

  it("records the digest of the decoded streamed document on the poll attempt", async () => {
    const attempts = await sql<{ payload_hashes: string[] | null }[]>`
      SELECT payload_hashes FROM conditions.source_poll_attempt
      WHERE source = 'nl-ndw-flow' ORDER BY id DESC LIMIT 1
    `;
    const decoded = createHash("sha256").update(speedPayload).digest("hex");
    expect(attempts[0]!.payload_hashes).toEqual([decoded]);
  });

  it("writes a real Point geometry resolved from the site table, and valid geometries only", async () => {
    const rows = await sql<{ gtype: string; lon: number; lat: number }[]>`
      SELECT ST_GeometryType(geom) AS gtype, ST_X(geom) AS lon, ST_Y(geom) AS lat
      FROM conditions.feature
      WHERE id = 'oc:feature:nl-ndw-flow:PZH01_MST_0065_00'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.gtype).toBe("ST_Point");
    expect(rows[0]!.lon).toBeCloseTo(4.536069, 5);
    expect(rows[0]!.lat).toBeCloseTo(52.0235558, 5);
    const [{ invalid }] = await sql<{ invalid: number }[]>`
      SELECT (SELECT count(*) FROM conditions.feature
               WHERE source_id = 'nl-ndw-flow' AND NOT ST_IsValid(geom))
           + (SELECT count(*) FROM conditions.observation_latest
               WHERE source_id = 'nl-ndw-flow' AND NOT ST_IsValid(geom)) AS invalid`;
    expect(Number(invalid)).toBe(0);
  }, 30_000);

  it("stores the site speed, keeps no history of a lane, and stamps the catalogue's rights", async () => {
    const rows = await sql<
      {
        value_num: number;
        retention_days: number | null;
        rights: unknown;
        channel: string | null;
      }[]
    >`
      SELECT value_num, retention_days, component_key AS channel,
             template #> '{provenance,attribution,rights}' AS rights
        FROM conditions.observation_latest
       WHERE feature_id = 'oc:feature:nl-ndw-flow:PZH01_MST_0065_00' AND property = 'traffic.speed'
       ORDER BY component_key NULLS FIRST`;
    expect(rows[0]).toMatchObject({ channel: null, retention_days: 2 });
    expect(rows[0]!.value_num).toBeCloseTo(63.28, 2);
    expect(rows.slice(1).map((r) => r.retention_days)).toEqual([null, null, null]);
    expect(rows.every((r) => r.rights !== null)).toBe(true);
  }, 30_000);

  it("keeps a site one poll does not report, as a live feature with its last reading", async () => {
    clearSiteTableCache();
    const without0029 = Buffer.from(
      speedPayload
        .toString("utf8")
        .replace(
          /<siteMeasurements>\s*<measurementSiteReference id="PZH01_MST_0029-00"[\s\S]*?<\/siteMeasurements>/,
          "",
        ),
    );
    const result = await poll(fetchServing(without0029));
    expect(result.error).toBeUndefined();
    expect(await liveFeatures("nl-ndw-flow")).toBe(3);
    expect(await seriesOf("nl-ndw-flow")).toContain("traffic.speed@PZH01_MST_0029-00");
  }, 60_000);

  it("derives congestion from a stored baseline, and withdraws it once the queue clears", async () => {
    await sql`
      INSERT INTO conditions.sensor_baseline
        (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('feature:oc:feature:nl-ndw-flow:PZH01_MST_STANDSTILL_00', 'nl-ndw-flow', -1, -1,
        100, 'derived', 50, now())`;
    clearSiteTableCache();
    const congested = await poll(fakeFetch);
    expect(congested.error).toBeUndefined();
    expect(congested.activeEvents).toBe(1);
    expect(await liveSituations("nl-ndw-flow")).toBe(1);
    const [speed] = await sql<{ baseline: Record<string, unknown> }[]>`
      SELECT reading->'baseline' AS baseline FROM conditions.observation_latest
       WHERE subject_key = 'feature:oc:feature:nl-ndw-flow:PZH01_MST_STANDSTILL_00'
         AND property = 'traffic.speed'`;
    expect(speed!.baseline).toMatchObject({ source: "derived", los: "stationary" });

    await sql`DELETE FROM conditions.sensor_baseline`;
    const cleared = await poll(fakeFetch);
    expect(cleared.error).toBeUndefined();
    expect(await liveSituations("nl-ndw-flow")).toBe(0);
    expect(cleared.deleted).toBe(1);
    expect(await liveFeatures("nl-ndw-flow")).toBe(3);
  }, 60_000);

  it("keeps site readings as history and counts those the rollup has already passed", async () => {
    // The fixture's readings are of 2026-06-24 10:08–10:09: poll as of then.
    const at = "2026-06-24T10:10:00.000Z";
    await ensureObservationPartitions(sql, {
      classes: retentionClasses(registry),
      now: new Date(at),
    });
    await sql`INSERT INTO conditions.observation_rollup_progress (period, finalized_before)
      VALUES ('hourly', '2026-06-24T10:00:00Z')`;
    // Earlier polls already hold these readings; history is kept when a reading is new.
    const forget = () =>
      sql`DELETE FROM conditions.observation_latest WHERE source_id = 'nl-ndw-flow'`;
    try {
      await forget();
      clearSiteTableCache();
      const onTime = await poll(fakeFetch, () => at);
      expect(onTime.error).toBeUndefined();
      expect(onTime.pastRollup).toBeUndefined();
      const history = await sql<{ property: string; n: number }[]>`
        SELECT l.property, count(*)::int AS n FROM conditions.observation o
          JOIN conditions.observation_latest l USING (series_id)
         WHERE l.source_id = 'nl-ndw-flow' GROUP BY 1 ORDER BY 1`;
      // Site series only: three speeds and the site volume.
      expect(history).toEqual([
        { property: "traffic.speed", n: 3 },
        { property: "traffic.volume", n: 1 },
      ]);

      await sql`UPDATE conditions.observation_rollup_progress SET finalized_before = '2026-06-24T11:00:00Z'`;
      await forget();
      clearSiteTableCache();
      const late = await poll(fakeFetch, () => "2026-06-24T10:11:00.000Z");
      expect(late.error).toBeUndefined();
      expect(late.pastRollup).toBe(4);
    } finally {
      await sql`DELETE FROM conditions.observation_rollup_progress`;
    }
  }, 60_000);

  it("preserves the last good publication on a cold site-table failure", async () => {
    const before = await seriesOf("nl-ndw-flow");
    expect(before.length).toBeGreaterThan(0);
    // Clear the cache so there is NO cached site map — the failure is cold.
    clearSiteTableCache();
    const partialFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("measurement.xml.gz")) {
        return new Response("nope", { status: 503 });
      }
      return new Response(gzipSync(speedPayload), { status: 200 });
    };
    const result = await poll(partialFetch);
    expect(result.count).toBe(0);
    expect(result.error).toMatch(/site-table cold failure/);
    expect(await seriesOf("nl-ndw-flow")).toEqual(before);
    expect(await liveFeatures("nl-ndw-flow")).toBe(3);
  }, 60_000);
});

describe("pipeline — parse failure", () => {
  it("swallows a parser-dispatch throw, writes source_status error, and does not advance last_success_at", async () => {
    // A feed whose format has no registered parser: `parserFor` (called from
    // inside the `buffers.flatMap(...)` dispatch, unguarded before this fix)
    // throws synchronously, before any content is actually parsed.
    // No snapshot contract here: NDW declares one, and its structural check
    // would reject this body before parser dispatch is ever reached.
    const { snapshot: _snapshot, ...base } = ndwFeed as unknown as Record<string, unknown>;
    const throwingFeed: DomainFeedSource = {
      ...base,
      id: "parse-throw-src",
      format: "bogus-format",
    } as unknown as DomainFeedSource;

    const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response("irrelevant body", { status: 200 });
    };

    const result = await runSource(throwingFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/no parser registered for format/i);

    const status = await sql<{ last_error: string | null; last_success_at: Date | null }[]>`
      SELECT last_error, last_success_at FROM conditions.source_status
      WHERE source = 'parse-throw-src'
    `;
    expect(status.length).toBe(1);
    expect(status[0]!.last_error).toMatch(/no parser registered for format/i);
    expect(status[0]!.last_success_at).toBeNull();
  }, 30_000);
});

describe("pipeline — streaming SAX parse failure preserves last-good rows", () => {
  const sitePayload = readFileSync(NDW_FLOW_SITE_TABLE_FIXTURE_PATH);
  const speedPayload = readFileSync(NDW_FLOW_SPEED_FIXTURE_PATH);

  it("parse-failure-preserves-last-good: a truncated document sets failed:true, skips the write, and does not advance last_success_at", async () => {
    // Establish a known-good baseline for this source first, independent of
    // whatever earlier describe blocks in this file left behind.
    clearSiteTableCache();
    const goodFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz") ? sitePayload : speedPayload;
      return new Response(gzipSync(body), { status: 200 });
    };
    const goodResult = await runSource(ndwFlowFeed, {
      sql,
      fetch: goodFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    // `count` reflects records this poll actually wrote, which can
    // legitimately be 0 if content is identical to an earlier run in this
    // file — the real assertion is "no failure" plus the series check below.
    expect(goodResult.error).toBeUndefined();

    const seriesBefore = await seriesOf("nl-ndw-flow");
    expect(seriesBefore.length).toBeGreaterThan(0);

    const statusBefore = await sql<{ last_success_at: Date | null }[]>`
      SELECT last_success_at FROM conditions.source_status WHERE source = 'nl-ndw-flow'
    `;
    const lastSuccessAtBefore = statusBefore[0]!.last_success_at;
    expect(lastSuccessAtBefore).not.toBeNull();

    // Site table still resolves fine; the measurement document itself is
    // truncated mid-element — the same kind of mid-document glitch a ~50 MB
    // feed can suffer, which the SAX parser's internal `failed` flag catches.
    clearSiteTableCache();
    const truncatedSpeedXml = speedPayload
      .toString("utf8")
      .slice(0, Math.floor(speedPayload.length * 0.6));
    const brokenFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz")
        ? gzipSync(sitePayload)
        : gzipSync(Buffer.from(truncatedSpeedXml, "utf8"));
      return new Response(body, { status: 200 });
    };

    const result = await runSource(ndwFlowFeed, {
      sql,
      fetch: brokenFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/streaming parse failed/i);

    expect(await seriesOf("nl-ndw-flow")).toEqual(seriesBefore);
    expect(await liveFeatures("nl-ndw-flow")).toBe(3);

    const statusAfter = await sql<{ last_error: string | null; last_success_at: Date | null }[]>`
      SELECT last_error, last_success_at FROM conditions.source_status WHERE source = 'nl-ndw-flow'
    `;
    expect(statusAfter[0]!.last_error).toMatch(/streaming parse failed/i);
    expect(statusAfter[0]!.last_success_at?.toISOString()).toBe(lastSuccessAtBefore!.toISOString());
  }, 60_000);
});

describe("pipeline — flow feed 200-with-garbage (well-formed empty publication)", () => {
  const sitePayload = readFileSync(NDW_FLOW_SITE_TABLE_FIXTURE_PATH);
  const speedPayload = readFileSync(NDW_FLOW_SPEED_FIXTURE_PATH);

  it("200-with-garbage (flow): a body that parses to zero measurements skips the write; records survive", async () => {
    // Establish a known-good baseline for this source first, independent of
    // whatever earlier describe blocks in this file left behind (mirrors the
    // SAX-failure test above).
    clearSiteTableCache();
    const goodFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz") ? sitePayload : speedPayload;
      return new Response(gzipSync(body), { status: 200 });
    };
    const goodResult = await runSource(ndwFlowFeed, {
      sql,
      fetch: goodFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(goodResult.error).toBeUndefined();

    const seriesBefore = await seriesOf("nl-ndw-flow");
    expect(seriesBefore.length).toBeGreaterThan(0);

    clearSiteTableCache();
    // A 200 response whose body is well-formed XML and DOES contain a
    // `siteMeasurements` element (so the streaming parser's `failed` flag is
    // NOT set — the parser saw the expected publication), but the site carries
    // no resolvable geometry — indistinguishable from "garbage" at the HTTP
    // layer, and yields zero flows. The flow-feed shrink guard ("a sensor
    // network never legitimately vanishes to zero") is what must catch this,
    // independent of the `failed` flag (that flag's own hard-failure case —
    // no publication found at all — is covered by the SAX-failure describe
    // block above).
    const garbageFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz")
        ? gzipSync(sitePayload)
        : gzipSync(Buffer.from("<D2LogicalModel><siteMeasurements/></D2LogicalModel>"));
      return new Response(body, { status: 200 });
    };

    const result = await runSource(ndwFlowFeed, {
      sql,
      fetch: garbageFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/zero measurements/i);

    expect(await seriesOf("nl-ndw-flow")).toEqual(seriesBefore);
    expect(await liveFeatures("nl-ndw-flow")).toBe(3);
  }, 60_000);
});

describe("pipeline — shrink tripwire (event feed)", () => {
  // Derived from the DriveBC descriptor for its format/licence; the tripwire
  // scenario is about an empty body, not the descriptor's offset pagination.
  const shrinkFeed: DomainFeedSource = {
    ...drivebcFeed,
    id: "shrink-test-src",
    pagination: undefined,
    snapshot: undefined,
  };
  const emptyEventsFetch = async (_url: string | URL | Request): Promise<Response> => {
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  };

  it("clears the last event only after the declared complete snapshot validates empty", async () => {
    // Seed N rows for this source from the real DriveBC fixture.
    const jsonPayload = readFileSync(DRIVEBC_FIXTURE_PATH);
    const seedFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(jsonPayload, { status: 200 });
    };
    const seedResult = await runSource(shrinkFeed, {
      sql,
      fetch: seedFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seedResult.count).toBeGreaterThan(0);
    const seededCount = seedResult.count;

    const status = await sql<{ last_row_count: number | null }[]>`
      SELECT last_row_count FROM conditions.source_status WHERE source = 'shrink-test-src'
    `;
    expect(status[0]!.last_row_count).toBe(seededCount);

    // allowMassClear defaults to false: a fresh count of 0 against a nonzero
    // previous count must skip the swap and preserve the seeded rows.
    const guarded = await runSource(shrinkFeed, {
      sql,
      fetch: emptyEventsFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(guarded.count).toBe(0);
    expect(guarded.error).toBeDefined();
    expect(guarded.error).toMatch(/shrank/i);
    expect(await liveSituations("shrink-test-src")).toBe(seededCount);

    // The error write must not have clobbered last_row_count (needed so the
    // tripwire's baseline survives an error cycle).
    const statusAfterGuarded = await sql<{ last_row_count: number | null }[]>`
      SELECT last_row_count FROM conditions.source_status WHERE source = 'shrink-test-src'
    `;
    expect(statusAfterGuarded[0]!.last_row_count).toBe(seededCount);

    // A structural complete-snapshot contract proves this is a real empty
    // source response, so the same response now legitimately clears the rows.
    const massClearFeed: DomainFeedSource = {
      ...shrinkFeed,
      snapshot: { completeness: "complete", recordsPath: "events" },
    };
    const cleared = await runSource(massClearFeed, {
      sql,
      fetch: emptyEventsFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(cleared.error).toBeUndefined();
    expect(cleared.deleted).toBe(seededCount);
    expect(await liveSituations("shrink-test-src")).toBe(0);
    // Withdrawn, not deleted: the situations keep their history.
    const withdrawn = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.situation
      WHERE source_id = 'shrink-test-src' AND tombstone_reason = 'withdrawn'
    `;
    expect(parseInt(withdrawn[0]!.count, 10)).toBe(seededCount);
  }, 30_000);
});

describe("pipeline — partition-complete fan-out reconciliation", () => {
  /** Minimal well-formed open511 event, unique per url so each sub-feed's
   * contribution is distinguishable as its own situation. */
  function eventBodyFor(url: string): string {
    return JSON.stringify({
      events: [
        {
          id: url,
          event_type: "CONSTRUCTION",
          geography: { type: "Point", coordinates: [0, 0] },
        },
      ],
    });
  }

  function fanoutFetchFor(failUrls: Set<string>): typeof fetch {
    return (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (failUrls.has(url)) return new Response("err", { status: 500 });
      return new Response(eventBodyFor(url), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("skips the swap when the fan-out failure ratio is at/above the default threshold (0.5), preserving last-good rows", async () => {
    const urls = Array.from({ length: 4 }, (_, i) => `https://fanout-skip.test/${i}`);
    const feed: DomainFeedSource = {
      ...drivebcFeed,
      id: "fanout-skip-test-src",
      url: urls,
      fanoutTolerant: true,
      // Fan-out semantics, not the descriptor's offset pagination.
      pagination: undefined,
    };

    const seeded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set()),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seeded.error).toBeUndefined();
    expect(seeded.count).toBe(4);

    // 3 of 4 sub-feeds fail this cycle (ratio 0.75 >= the 0.5 default) — the
    // swap must be skipped entirely rather than reconciling against the
    // surviving 1-of-4 fragment, which would otherwise delete the 3 rows
    // belonging to the failed sub-feeds as "missing".
    const guarded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set(urls.slice(1))),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(guarded.count).toBe(0);
    expect(guarded.error).toBeDefined();
    expect(guarded.outcome).toBe("partial");

    expect(await liveSituations("fanout-skip-test-src")).toBe(4);
  }, 30_000);

  it("skips the swap at the EXACT threshold boundary (2 of 4 fail = ratio 0.5, >= semantics)", async () => {
    const urls = Array.from({ length: 4 }, (_, i) => `https://fanout-boundary.test/${i}`);
    const feed: DomainFeedSource = {
      ...drivebcFeed,
      id: "fanout-boundary-test-src",
      url: urls,
      fanoutTolerant: true,
      // Fan-out semantics, not the descriptor's offset pagination.
      pagination: undefined,
    };

    const seeded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set()),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seeded.error).toBeUndefined();
    expect(seeded.count).toBe(4);

    // Exactly half the sub-feeds fail (ratio 0.5 === the 0.5 default): the
    // guard's `>=` must treat the boundary as skip, not proceed.
    const guarded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set(urls.slice(0, 2))),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(guarded.count).toBe(0);
    expect(guarded.error).toBeDefined();
    expect(guarded.outcome).toBe("partial");

    expect(await liveSituations("fanout-boundary-test-src")).toBe(4);
  }, 30_000);

  it("preserves every partition when even one fan-out partition fails", async () => {
    const urls = Array.from({ length: 4 }, (_, i) => `https://fanout-proceed.test/${i}`);
    const feed: DomainFeedSource = {
      ...drivebcFeed,
      id: "fanout-proceed-test-src",
      url: urls,
      fanoutTolerant: true,
      // Fan-out semantics, not the descriptor's offset pagination.
      pagination: undefined,
    };

    const seeded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set()),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seeded.error).toBeUndefined();
    expect(seeded.count).toBe(4);

    // Even a minority failure is incomplete. No successful partition may make
    // delete-missing prune rows owned by the failed partition.
    const proceeded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set([urls[0]!])),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(proceeded.outcome).toBe("partial");
    expect(proceeded.count).toBe(0);

    expect(await liveSituations("fanout-proceed-test-src")).toBe(4);
  }, 30_000);
});

describe("pipeline publication acceptance", () => {
  function source(id: string): DomainFeedSource {
    return {
      ...drivebcFeed,
      id,
      url: `https://${id}.test/events`,
      pagination: undefined,
      fetchIntervalSec: undefined,
      snapshot: { completeness: "complete", recordsPath: "events" },
    };
  }
  const body = (description: string) =>
    JSON.stringify({
      events: [
        {
          id: "event",
          event_type: "CONSTRUCTION",
          description,
          geography: { type: "Point", coordinates: [0, 0] },
        },
      ],
    });
  const facts = async (id: string) =>
    (
      await sql`SELECT publication_revision, last_network_success_at FROM conditions.source_status WHERE source=${id}`
    )[0];
  const descriptions = (id: string) =>
    sql`SELECT record #>> '{description,0,text}' AS description FROM conditions.situation
        WHERE source_id = ${id} AND tombstoned_at IS NULL`;

  it("retries a downloaded revision after the publication transaction fails", async () => {
    const feed = source("accept-db-failure");
    let revision = "v1";
    const validators: (string | null)[] = [];
    const fetch = (async (_url, init) => {
      const prior = new Headers(init?.headers).get("if-none-match");
      validators.push(prior);
      return prior === revision
        ? new Response(null, { status: 304 })
        : new Response(body(revision), { headers: { etag: revision } });
    }) as typeof globalThis.fetch;
    const run = () =>
      runSource(feed, { sql, fetch, now: () => new Date().toISOString(), lookup: fakeLookup });
    expect((await run()).count).toBe(1);
    const before = await facts(feed.id);
    await sql`CREATE FUNCTION conditions.reject_accept_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.source_id = 'accept-db-failure' THEN RAISE EXCEPTION 'injected publication failure'; END IF;
      RETURN NEW; END $$`;
    await sql`CREATE TRIGGER reject_accept_test BEFORE INSERT OR UPDATE ON conditions.situation FOR EACH ROW EXECUTE FUNCTION conditions.reject_accept_test()`;
    revision = "v2";
    try {
      expect((await run()).error).toContain("injected publication failure");
      expect(await facts(feed.id)).toEqual(before);
      expect(await descriptions(feed.id)).toEqual([{ description: "v1" }]);
    } finally {
      await sql`DROP TRIGGER reject_accept_test ON conditions.situation`;
      await sql`DROP FUNCTION conditions.reject_accept_test()`;
    }
    expect((await run()).updated).toBe(1);
    expect(validators).toEqual([null, "v1", "v1"]);
    expect((await run()).outcome).toBe("validated_unchanged");
  });

  it.each(["malformed", "ceiling"])(
    "preserves publication and freshness on %s pagination",
    async (failure) => {
      const feed = source(`accept-pages-${failure}`);
      const run = (fetch: typeof globalThis.fetch, src = feed) =>
        runSource(src, { sql, fetch, now: () => new Date().toISOString(), lookup: fakeLookup });
      expect((await run(async () => new Response(body("last good")))).count).toBe(1);
      const before = await facts(feed.id);
      let page = 0;
      const result = await run(
        async () =>
          new Response(
            ++page === 1 || failure === "ceiling"
              ? body("partial new")
              : JSON.stringify({ error: "not available" }),
          ),
        {
          ...feed,
          pagination: { recordsPath: "events", pageSize: 1, skipParam: "offset", maxPages: 2 },
        },
      );
      expect(result.error).toMatch(/pagination/);
      expect(await facts(feed.id)).toEqual(before);
      expect(await descriptions(feed.id)).toEqual([{ description: "last good" }]);
    },
  );
});

describe("stable provenance refresh", () => {
  it("refreshes changed rights and lineage without rewriting an unchanged poll", async () => {
    let feed: DomainFeedSource = {
      ...drivebcFeed,
      id: "provenance-refresh",
      url: "https://provenance-refresh.test/events",
      pagination: undefined,
      fetchIntervalSec: undefined,
      parentSourceId: "parent-a",
      rights: {
        sourceRedistribution: true,
        derivedRedistribution: true,
        commercialUse: true,
        attributionRequired: true,
        retention: true,
        evidenceVersion: "grant1",
      },
      snapshot: { completeness: "complete", recordsPath: "events" },
    };
    const headers: (string | null)[] = [];
    const fetch = (async (_url, init) => {
      const prior = new Headers(init?.headers).get("if-none-match");
      headers.push(prior);
      if (prior) return new Response(null, { status: 304 });
      return new Response(
        JSON.stringify({
          events: [
            {
              id: "same",
              updated: "2026-09-11T00:00:00.000Z",
              event_type: "CONSTRUCTION",
              geography: { type: "Point", coordinates: [0, 0] },
            },
          ],
        }),
        { headers: { etag: "stable-content" } },
      );
    }) as typeof globalThis.fetch;
    const run = () =>
      runSource(feed, { sql, fetch, now: () => new Date().toISOString(), lookup: fakeLookup });
    const row = async () =>
      (
        await sql`SELECT content_hash, revision, record -> 'provenance' AS origin, xmin::text AS version
          FROM conditions.situation WHERE source_id=${feed.id}`
      )[0]!;
    expect((await run()).count).toBe(1);
    const first = await row();
    expect((await run()).outcome).toBe("validated_unchanged");
    expect(await row()).toEqual(first);
    feed = {
      ...feed,
      parentSourceId: "parent-b",
      policyIds: ["parent-b", feed.id],
      rights: { ...feed.rights!, commercialUse: false, evidenceVersion: "grant2" },
    };
    expect((await run()).updated).toBe(1);
    const revoked = await row();
    // Attribution is part of a record's content: changed rights are a new revision.
    expect(revoked.content_hash).not.toBe(first.content_hash);
    expect(revoked.revision).toBe(first.revision + 1);
    expect(revoked.origin.attribution).toMatchObject({
      parentSourceId: "parent-b",
      policyIds: ["parent-b", feed.id],
      rights: { commercial_use: "no", evidence_version: "grant2" },
    });
    expect((await run()).outcome).toBe("validated_unchanged");
    expect(await row()).toEqual(revoked);
    feed = { ...feed, parentSourceId: undefined, policyIds: undefined, rights: undefined };
    expect((await run()).updated).toBe(1);
    const unknown = await row();
    expect(unknown.origin.attribution.rights.commercial_use).toBe("unknown");
    expect(unknown.origin.attribution.parentSourceId).toBeUndefined();
    expect(headers).toEqual([null, "stable-content", null, "stable-content", null]);
  });
});

describe("OpenLR publication failure", () => {
  it("retains all last-good rows and retries the unaccepted snapshot after partial resolution fails", async () => {
    const feed: DomainFeedSource = {
      ...ndwFeed,
      id: "openlr-transport-test",
      url: "https://openlr-feed.test/events",
      snapshot: undefined,
      fetchIntervalSec: undefined,
    };
    const refs = [8, 8.1].map((lon) =>
      encodeOpenlrLine({
        coords: [
          [lon, 50],
          [lon + 0.01, 50],
        ],
        frc: 3,
        fow: 3,
      }),
    );
    // One situation per record, so each is its own publication to retain.
    const xml = `<messageContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="3">
      <payload xsi:type="SituationPublication">
      ${refs
        .map(
          (ref, i) => `<situation id="s${i}">
        <situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" id="r${i}" version="1">
        <situationRecordVersionTime>2026-09-11T12:00:00Z</situationRecordVersionTime>
        <validity><validityStatus>active</validityStatus></validity>
        <locationReference xsi:type="OpenlrPointAlongLine"><openlrBinary>${ref}</openlrBinary></locationReference>
      </situationRecord></situation>`,
        )
        .join("")}
      </payload></messageContainer>`;
    let version = "v1";
    let failing = false;
    const validators: (string | null)[] = [];
    const run = () =>
      runSource(feed, {
        sql,
        lookup: fakeLookup,
        now: () => new Date().toISOString(),
        fetch: async (_url, init) => {
          validators.push(new Headers(init?.headers).get("if-none-match"));
          return new Response(xml, { headers: { etag: version } });
        },
        openlrClient: {
          resolve: async (loc) => {
            if (failing && loc.points[0]!.longitude > 8.05)
              throw new Error("resolver deadline exceeded");
            return {
              type: "LineString",
              coordinates: [
                [8, 50],
                [8.01, 50],
              ],
            };
          },
        },
      });
    const facts = async () => ({
      rows: await sql`SELECT id, revision, ST_AsGeoJSON(geom) AS geom FROM conditions.situation
        WHERE source_id = ${feed.id} AND tombstoned_at IS NULL ORDER BY id`,
      status: (
        await sql`SELECT publication_revision, last_network_success_at FROM conditions.source_status WHERE source = ${feed.id}`
      )[0],
    });
    try {
      expect((await run()).count).toBe(2);
      const before = await facts();
      version = "v2";
      failing = true;
      clearResolveCache();
      const failed = await run();
      expect(failed.outcome).toBe("failed");
      expect(failed.error).toContain("OpenLR resolution failed");
      expect(await facts()).toEqual(before);
      failing = false;
      expect(await run()).toMatchObject({ outcome: "changed", activeEvents: 2, deleted: 0 });
      expect(validators.slice(-2)).toEqual(["v1", "v1"]);
    } finally {
      clearResolveCache();
    }
  });
});
