import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { LookupFn } from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  rollupObservations,
} from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearReferenceCaches } from "../pipeline/reference.js";
import { runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * The hourly rollup of `traffic.speed`, written through the flow poll, gives
 * the speed histogram the baseline and segment-profile derivations read. The
 * expectation is frozen from the retired per-sensor speed rollup run on the
 * same samples, with two deliberate differences:
 *  - standstills are data: a reading of 0 km/h lands in bin 0 (the old sample
 *    writer dropped it; baselines ignore bin 0 instead);
 *  - readings are no longer floored to the feed cadence: two readings of one
 *    site at distinct instants of one cadence step are two samples (the old
 *    writer kept the first only).
 * Speeds at or above 250 km/h are rejected by the parsers, as before.
 */
let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const HOUR = "2026-10-01T08:00:00.000Z";
const NOW = "2026-10-01T16:30:00.000Z";
const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures",
);
const SITES = readFileSync(path.join(FIXTURES, "ndw-flow/measurement_site_table.xml"));

/** A spread across many bins, a repeat, a half-bin edge, a standstill and an absurd speed. */
const SAMPLES: [string, number][] = [
  ["08:00:00", 0],
  ["08:01:00", 1.9],
  ["08:02:00", 2],
  ["08:03:00", 47.5],
  ["08:04:00", 48],
  ["08:05:00", 81],
  ["08:05:30", 81], // same cadence step as the one before
  ["08:07:00", 81.9],
  ["08:08:00", 99.99],
  ["08:09:00", 130],
  ["08:10:00", 250.4],
];

/**
 * The retired rollup's hour of these samples: 0 km/h, 250.4 km/h and the
 * second reading of 08:05 dropped, `LEAST(127, GREATEST(0, floor(v / 2)))`.
 */
const LEGACY = { sample_count: 8, bins: [0, 1, 23, 24, 40, 49, 65], counts: [1, 1, 1, 1, 2, 1, 1] };

/** The same hour now: the standstill in bin 0, both readings of 08:05 kept. */
const EXPECTED = {
  sample_count: LEGACY.sample_count + 2,
  bins: LEGACY.bins,
  counts: [2, 1, 1, 1, 3, 1, 1],
};

const feed = repoFeed("nl-ndw-flow");
const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

/** An NDW measured-data document holding one reading of the line site. */
function document(at: string, speed: number): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" modelBaseVersion="2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="MeasuredDataPublication" lang="nl">
    <publicationTime>${at}</publicationTime>
    <measurementSiteTableReference id="NDW01_MT" version="1715" targetClass="MeasurementSiteTable"/>
    <siteMeasurements>
      <measurementSiteReference id="PZH01_MST_0029-00" version="13" targetClass="MeasurementSiteRecord"/>
      <measurementTimeDefault>${at}</measurementTimeDefault>
      <measuredValue index="8">
        <measuredValue>
          <basicData xsi:type="TrafficSpeed">
            <averageVehicleSpeed numberOfInputValuesUsed="8"><speed>${speed}</speed></averageVehicleSpeed>
          </basicData>
        </measuredValue>
      </measuredValue>
    </siteMeasurements>
  </payloadPublication>
</d2LogicalModel>`);
}

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
  clearReferenceCaches();
  for (const [time, speed] of SAMPLES) {
    const at = `2026-10-01T${time}Z`;
    const fetchFn = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      return new Response(
        gzipSync(href.includes("measurement.xml.gz") ? SITES : document(at, speed)),
        { status: 200 },
      );
    }) as typeof fetch;
    await runSource(feed, {
      sql,
      fetch: fetchFn,
      now: () => NOW,
      lookup: fakeLookup,
      model: { registry, instanceId: "test.local" },
    });
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("the hourly rollup of traffic.speed", () => {
  it("gives the retired speed rollup's histogram, plus standstills and every distinct reading", async () => {
    await rollupObservations(sql, { registry, period: "hourly", now: new Date(NOW) });
    const rows = await sql`
      SELECT h.sample_count, h.bins, h.counts FROM conditions.observation_rollup_hourly h
        JOIN conditions.observation_latest l USING (series_id)
       WHERE h.hour_utc = ${HOUR} AND l.property = 'traffic.speed'
         AND l.subject_key = 'feature:oc:feature:nl-ndw-flow:PZH01_MST_0029-00'`;
    expect(rows).toEqual([EXPECTED]);
  });
});
