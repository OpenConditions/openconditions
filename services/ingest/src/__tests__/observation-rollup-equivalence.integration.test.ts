import { observationId } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  rollupObservations,
  writeSnapshot,
} from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rollupSpeedSamples } from "../pipeline/speed-rollup.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * The generic observation rollup must give the speed histograms the baseline
 * and segment-profile derivations read today: the same samples in one hour
 * through the legacy speed rollup and through traffic.speed history.
 */
let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const HOUR = new Date("2026-10-01T08:00:00Z");
const NOW = new Date("2026-10-01T16:30:00Z");
// A spread across many bins, a repeat, a half-bin edge and speeds near the top bins.
const SPEEDS = [0, 1.9, 2, 47.5, 48, 81, 81, 81.9, 99.99, 130, 250.4];

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, { classes: retentionClasses(registry), now: NOW });
  for (const [i, speed] of SPEEDS.entries()) {
    const at = new Date(HOUR.getTime() + i * 60_000);
    await sql`
      INSERT INTO conditions.sensor_speed_sample
        (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
      VALUES ('nl-ndw-flow:s1', 'nl-ndw-flow', ${at}, ${speed}, ${at.getUTCDay()},
        ${at.getUTCHours()}, ST_SetSRID(ST_MakePoint(4.9, 52.4), 4326))`;
    const draft: Record<string, unknown> = {
      class: "observation",
      kind: "observation",
      property: "traffic.speed",
      subject: { kind: "feature", featureId: "oc:feature:nl-ndw-flow:s1" },
      result: { type: "quantity", value: speed, unit: "km/h" },
      phenomenonTime: { instant: at.toISOString() },
      aggregation: "mean",
      temporality: "live",
      location: {
        geometry: { type: "Point", coordinates: [4.9, 52.4] },
        extent: "point",
        geometryOrigin: "site_table",
        fuzziness: "exact",
      },
      provenance: {
        origin: "feed",
        sourceId: "nl-ndw-flow",
        sourceFormat: "datex2",
        accessMode: "bulk",
        recordId: "s1",
        attribution: { provider: "NDW", license: "CC0-1.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: at.toISOString() },
    };
    draft["id"] = observationId("nl-ndw-flow", draft as Parameters<typeof observationId>[1]);
    await writeSnapshot(
      sql,
      "nl-ndw-flow",
      { observations: [draft] },
      { registry, instanceId: "test.local", now: NOW.toISOString(), complete: true },
    );
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("the observation rollup of traffic.speed", () => {
  it("gives the same hourly histogram as the legacy speed rollup", async () => {
    await rollupSpeedSamples(sql, { now: () => NOW });
    await rollupObservations(sql, { registry, period: "hourly", now: NOW });
    const [legacy] = await sql`
      SELECT sample_count, speed_bins AS bins, speed_counts AS counts
      FROM conditions.sensor_speed_hourly WHERE hour_utc = ${HOUR}`;
    const [rollup] = await sql`
      SELECT sample_count, bins, counts FROM conditions.observation_rollup_hourly
      WHERE hour_utc = ${HOUR}`;
    expect(legacy).toBeDefined();
    expect(rollup).toEqual(legacy);
  });
});
