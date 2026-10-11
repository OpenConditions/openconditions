import { runMigrations } from "@openconditions/core/server";
import type { RecordDraft } from "@openconditions/ingest-framework";
import { observationId } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  writeSnapshot,
} from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { publishReadings } from "../pipeline/publish.js";
import { openPollAttempt, upsertSourceStatus } from "../pipeline/source-status.js";

const databaseProfile = process.env.OC_TEST_POSTGIS_PROFILE ?? "pg16";
const databaseImage =
  databaseProfile === "pg16"
    ? "postgis/postgis:16-3.4"
    : databaseProfile === "pg18"
      ? "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8"
      : undefined;
if (!databaseImage) throw new Error("Unsupported disposable PostGIS test profile");

const source = { id: "nl-ndw-flow", freshnessWindowSec: 300 };
const model = { registry: productionRegistry(), instanceId: "test.local" };
const T1 = "2026-10-01T10:00:05.000Z";
const T2 = "2026-10-01T10:01:05.000Z";
const T3 = "2026-10-01T10:02:05.000Z";
let sql: postgres.Sql;
let containerStop: (() => Promise<unknown>) | undefined;
const classScans: string[] = [];
let liveCounts = 0;
let observing = false;

beforeAll(async () => {
  const container = await new GenericContainer(databaseImage)
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
  sql = postgres(url, {
    max: 3,
    onnotice: () => {},
    debug: (_connection, query) => {
      if (!observing) return;
      const match = query.match(
        /^SELECT id, content_hash, revision,[\s\S]*FROM conditions\.(feature|situation|offer) WHERE source_id = \$1/,
      );
      if (match) classScans.push(match[1]!);
      if (/SELECT count\(\*\)::int AS live FROM conditions\.feature/.test(query)) liveCounts++;
    },
  });
  const [{ version }] = await sql`SELECT current_setting('server_version_num')::int AS version`;
  expect(Math.floor(Number(version) / 10_000)).toBe(databaseProfile === "pg18" ? 18 : 16);
  await runMigrations(url);
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(model.registry),
    now: new Date(T1),
  });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

beforeEach(async () => {
  observing = false;
  classScans.length = 0;
  liveCounts = 0;
  await sql`TRUNCATE conditions.observation_latest, conditions.feature, conditions.source_status,
    conditions.source_poll_attempt CASCADE`;
  await sql`TRUNCATE conditions.observation`;
});

const provenance = {
  origin: "feed",
  sourceId: source.id,
  sourceFormat: "datex2",
  accessMode: "bulk",
  recordId: "s1",
  attribution: { provider: "Test publisher", license: "CC0-1.0" },
  privacy: { class: "authoritative" },
};
const location = {
  geometry: { type: "Point", coordinates: [4.536, 52.024] },
  extent: "point",
  geometryOrigin: "site_table",
  fuzziness: "exact",
};

const feature = (id: string) => ({
  id: `oc:feature:${source.id}:${id}`,
  class: "feature",
  kind: "measurement_site",
  type: "traffic",
  temporality: "static",
  lifecycle: "operational",
  details: { kind: "measurement_site", v: 1, measuredProperties: ["traffic.speed"] },
  location,
  provenance: { ...provenance, recordId: id },
  freshness: { fetchedAt: T1 },
});

function reading(value: number, at: string): RecordDraft {
  const draft: RecordDraft = {
    class: "observation",
    kind: "observation",
    property: "traffic.speed",
    temporality: "live",
    subject: { kind: "feature", featureId: "oc:feature:nl-ndw-flow:s1" },
    result: { type: "quantity", value, unit: "km/h" },
    phenomenonTime: { instant: at },
    aggregation: "mean",
    location,
    provenance,
    freshness: { fetchedAt: at },
  };
  draft["id"] = observationId(source.id, draft as Parameters<typeof observationId>[1]);
  return draft;
}

async function publish(observations: RecordDraft[], at: string, rejected = 0) {
  const id = await openPollAttempt(sql, source.id, at);
  observing = true;
  try {
    return await publishReadings(sql, source, {
      observations,
      rejected,
      poll: { id, at, payloadHashes: ["fixture-hash"] },
      now: at,
      model,
      durationMs: 25,
    });
  } finally {
    observing = false;
  }
}

async function status() {
  const [row] = await sql`SELECT last_success_at, last_network_success_at, freshness_deadline,
    last_publication_at, publication_revision, last_outcome, last_row_count, active_event_count,
    last_inserted, last_updated, last_deleted, last_rejected, consecutive_failures, last_error
    FROM conditions.source_status WHERE source = ${source.id}`;
  return row;
}

const counts = { activeEvents: 1, rowCount: 1, inserted: 0, updated: 1, deleted: 0, rejected: 2 };

describe("publishReadings", () => {
  it("publishes observations atomically with success status and the live feature count without metadata scans", async () => {
    await writeSnapshot(
      sql,
      source.id,
      { features: [feature("s1"), feature("withdrawn")] },
      { ...model, now: T1, complete: true },
    );
    await writeSnapshot(
      sql,
      source.id,
      { features: [feature("s1")] },
      { ...model, now: T1, complete: true },
    );
    const metadata = await sql`SELECT id, record FROM conditions.feature ORDER BY id`;
    const history =
      await sql`SELECT feature_id, revision FROM conditions.feature_revision ORDER BY feature_id, revision`;
    await upsertSourceStatus(sql, source.id, {
      freshnessWindowSec: 300,
      outcome: "failed",
      attemptAt: T1,
      error: "fixture failure",
    });

    const first = await publish([reading(70, T2)], T2, 2);
    expect(first.counts).toEqual(counts);
    expect(first.summary.observations).toMatchObject({ latest: 1, history: 1, unchanged: 0 });
    expect(first.summary.changed).toEqual([]);
    expect(await status()).toEqual({
      last_success_at: new Date(T2),
      last_network_success_at: new Date(T2),
      freshness_deadline: new Date("2026-10-01T10:06:05.000Z"),
      last_publication_at: new Date(T2),
      publication_revision: "1",
      last_outcome: "changed",
      last_row_count: 1,
      active_event_count: 1,
      last_inserted: 0,
      last_updated: 1,
      last_deleted: 0,
      last_rejected: 2,
      consecutive_failures: 0,
      last_error: null,
    });
    const [attempt] = await sql`SELECT outcome, network_validated, published, active_event_count,
      inserted, updated, deleted, rejected, payload_hashes, finished_at IS NOT NULL AS finished
      FROM conditions.source_poll_attempt WHERE source = ${source.id} ORDER BY id DESC LIMIT 1`;
    expect(attempt).toEqual({
      outcome: "changed",
      network_validated: true,
      published: true,
      active_event_count: 1,
      inserted: 0,
      updated: 1,
      deleted: 0,
      rejected: 2,
      payload_hashes: ["fixture-hash"],
      finished: true,
    });

    const second = await publish([reading(50, T3)], T3);
    expect(second.counts).toEqual({ ...counts, rejected: 0 });
    expect(await status()).toMatchObject({
      last_success_at: new Date(T3),
      last_publication_at: new Date(T3),
      publication_revision: "2",
    });
    expect(await sql`SELECT value_num FROM conditions.observation_latest`).toEqual([
      { value_num: 50 },
    ]);
    expect(
      await sql`SELECT value_num FROM conditions.observation ORDER BY phenomenon_start`,
    ).toEqual([{ value_num: 70 }, { value_num: 50 }]);
    expect(await sql`SELECT id, record FROM conditions.feature ORDER BY id`).toEqual(metadata);
    expect(
      await sql`SELECT feature_id, revision FROM conditions.feature_revision ORDER BY feature_id, revision`,
    ).toEqual(history);
    expect(liveCounts).toBe(2);
    expect(classScans).toEqual([]);
  });

  it("advances publication and freshness for empty and duplicate-reading polls without changing retained observations", async () => {
    await writeSnapshot(
      sql,
      source.id,
      { features: [feature("s1")] },
      { ...model, now: T1, complete: true },
    );
    await publish([reading(70, T1)], T1);
    const duplicate = await publish([reading(70, T1)], T2);
    expect(duplicate.summary.observations).toMatchObject({ unchanged: 1, history: 0 });
    expect(duplicate.counts).toEqual({ ...counts, updated: 0, rejected: 0 });
    const empty = await publish([], T3);
    expect(empty.counts).toEqual({ ...counts, updated: 0, rejected: 0 });
    expect(await status()).toMatchObject({
      last_success_at: new Date(T3),
      last_network_success_at: new Date(T3),
      last_publication_at: new Date(T3),
      publication_revision: "3",
      last_row_count: 1,
      last_updated: 0,
    });
    expect(await sql`SELECT value_num FROM conditions.observation_latest`).toEqual([
      { value_num: 70 },
    ]);
    expect(await sql`SELECT value_num FROM conditions.observation`).toEqual([{ value_num: 70 }]);
    expect(liveCounts).toBe(3);
    expect(classScans).toEqual([]);
  });
  it("rolls back observation writes when closing the publication status fails", async () => {
    await writeSnapshot(
      sql,
      source.id,
      { features: [feature("s1")] },
      { ...model, now: T1, complete: true },
    );
    await publish([reading(70, T1)], T1);
    await publish([], T1);
    const before = await status();
    const id = await openPollAttempt(sql, source.id, T2);
    await sql`ALTER TABLE conditions.source_status ADD CONSTRAINT reject_readings_update CHECK (last_updated <> 1)`;
    try {
      await expect(
        publishReadings(sql, source, {
          observations: [reading(50, T2)],
          rejected: 0,
          poll: { id, at: T2 },
          now: T2,
          model,
          durationMs: 25,
        }),
      ).rejects.toThrow(/reject_readings_update/);
    } finally {
      await sql`ALTER TABLE conditions.source_status DROP CONSTRAINT reject_readings_update`;
    }
    expect(await status()).toEqual(before);
    expect(await sql`SELECT value_num FROM conditions.observation_latest`).toEqual([
      { value_num: 70 },
    ]);
    expect(await sql`SELECT value_num FROM conditions.observation`).toEqual([{ value_num: 70 }]);
    expect(
      await sql`SELECT outcome, published FROM conditions.source_poll_attempt WHERE id = ${id}`,
    ).toEqual([{ outcome: "running", published: false }]);
  });
});
