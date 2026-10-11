import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { sealRecord, sha256Hex } from "@openconditions/model";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reconcileFederation } from "../federation-reconcile.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { rowOf } from "../record-rows.js";
import { syncSources } from "../sources.js";
import {
  CLASS_COLUMNS,
  refreshExpiries,
  storeRecords,
  tombstoneRecords,
  writeSnapshotIn,
} from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { featureDraft } from "./drafts.js";
import { goldenFacilities, registry } from "./facility-fixtures.js";

type Rec = Record<string, unknown>;
type Mode = "expression" | "generated";
const NOW = "2026-10-01T10:00:05.000Z";
const LATER = "2026-10-01T10:01:05.000Z";
const INSTANCE = "test.local";
const PROFILE = process.env["OC_TEST_POSTGIS_PROFILE"] ?? "pg16";
const RUN_BENCHMARK = process.env["OC_RUN_EXTERNAL_ID_BENCHMARK"] === "1";
const GENERATED_INDEX = "idx_feature_external_ids_generated_probe";
const BENEFIT_BUDGET = {
  expiryMedianWalReductionAtLeast: 0.2,
  expiryHotRatio: "demonstrably increased",
  firstRegisterAndInitialMedianRegressionAtMost: 0.05,
  firstRegisterP95: "<= max(original p95 + 10ms, 1.05 * original p95)",
  timingDecision: "variance analysis required; host contention may make timing INCONCLUSIVE",
  migrationDecision: "DEFER: no representative restore or approved availability budget",
};
const EXPECTED_IMAGE =
  PROFILE === "pg18"
    ? "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8"
    : "postgis/postgis:16-3.4";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let version: unknown;
let originalReloptions: unknown;
let originalOtherIndexes: unknown;
let originalColumns: unknown;
let administration: postgres.Sql | undefined;
let armName: string | undefined;
let nextArm = 0;
let nextMetric = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  version = (await sql`SELECT version() AS version`)[0]?.["version"];
  originalReloptions = (
    await sql`SELECT reloptions FROM pg_class WHERE oid='conditions.feature'::regclass`
  )[0]?.["reloptions"];
  originalOtherIndexes = await otherIndexes();
  originalColumns = await columnLayout();
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
  // The migrated template is never changed by an experiment arm.
  await sql.end();
  administration = postgres(fixtureUrl("postgres"), { max: 1, onnotice: () => {} });
  await freshArm();
}, 180_000);

afterAll(async () => {
  try {
    await sql?.end();
    if (administration && armName)
      await administration.unsafe(`DROP DATABASE IF EXISTS "${armName}" WITH (FORCE)`);
  } finally {
    try {
      await administration?.end();
    } finally {
      await db?.close();
    }
  }
}, 30_000);

function fixtureUrl(database: string): string {
  const url = new URL(db.url);
  url.pathname = `/${database}`;
  return url.toString();
}

async function freshArm() {
  if (!administration) throw new Error("Disposable fixture administration is not ready");
  await sql.end();
  if (armName) await administration.unsafe(`DROP DATABASE "${armName}" WITH (FORCE)`);
  armName = `external_id_arm_${++nextArm}`;
  await administration.unsafe(`CREATE DATABASE "${armName}" TEMPLATE conditions_test`);
  sql = postgres(fixtureUrl(armName), { max: 4, onnotice: () => {} });
}

const columnLayout = () => sql`SELECT attname,attnum,attisdropped,attgenerated,
  atttypid::regtype::text AS type FROM pg_attribute
  WHERE attrelid='conditions.feature'::regclass AND attnum>0 ORDER BY attnum`;

const context = (now = NOW) => ({ registry, instanceId: INSTANCE, now, complete: false });

function sealed(draft: Rec, now = NOW, revision = 1): Rec {
  const record = sealRecord(registry, draft, { instanceId: INSTANCE, revision, recordedAt: now });
  if (!record.ok) throw new Error(JSON.stringify(record.issues));
  return record.value;
}

const otherIndexes = () => sql`SELECT c.relname, c.reloptions, pg_get_indexdef(c.oid) AS definition
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE i.indrelid='conditions.feature'::regclass
    AND c.relname NOT IN ('idx_feature_external_ids',${GENERATED_INDEX}) ORDER BY c.relname`;

/** DDL and index removal live only inside this disposable representation experiment. */
async function prepare(mode: Mode) {
  await freshArm();
  if (mode === "generated") {
    await sql.unsafe(`ALTER TABLE conditions.feature ADD COLUMN external_ids jsonb
      GENERATED ALWAYS AS (record -> 'externalIds') STORED`);
    await sql.unsafe(`CREATE INDEX ${GENERATED_INDEX} ON conditions.feature
      USING gin (external_ids jsonb_path_ops) WITH (fastupdate=off)`);
    await sql.unsafe(`DROP INDEX conditions.idx_feature_external_ids`);
  }
  expect(
    (await sql`SELECT reloptions FROM pg_class WHERE oid='conditions.feature'::regclass`)[0]?.[
      "reloptions"
    ],
  ).toEqual(originalReloptions);
  const [index] = await sql`SELECT reloptions FROM pg_class
    WHERE relname=${mode === "generated" ? GENERATED_INDEX : "idx_feature_external_ids"}`;
  expect(index?.["reloptions"]).toContain("fastupdate=off");
  expect(await otherIndexes()).toEqual(originalOtherIndexes);
  const columns = await columnLayout();
  expect(columns.filter((c) => c["attname"] !== "external_ids")).toEqual(originalColumns);
}

interface LookupTrace {
  original: string;
  candidate: string;
  parameters: unknown[];
}

/** The seam changes only the candidate lookup, never the production reader. */
function candidateLookup(
  tx: postgres.TransactionSql,
  trace: LookupTrace[],
): postgres.TransactionSql {
  return new Proxy(tx, {
    apply(target, receiver, args) {
      const strings = args[0] as TemplateStringsArray;
      const original = strings.join("?");
      if (!original.includes("'externalIds'") || !original.includes("UNION")) {
        return Reflect.apply(target, receiver, args);
      }
      const extraction = "COALESCE(t.record -> 'externalIds',";
      const containment = "(f.record -> 'externalIds')";
      expect(original.split(extraction)).toHaveLength(2);
      expect(original.split(containment)).toHaveLength(2);
      expect(original).toContain("OFFSET 0");
      const rewritten = strings.map((s) =>
        s.replace(extraction, "COALESCE(t.external_ids,").replace(containment, "f.external_ids"),
      );
      Object.defineProperty(rewritten, "raw", { value: [...rewritten] });
      const candidate = rewritten.join("?");
      expect(
        candidate
          .replace("COALESCE(t.external_ids,", extraction)
          .replace("f.external_ids", containment),
      ).toBe(original);
      trace.push({ original, candidate, parameters: args.slice(1) });
      return Reflect.apply(target, receiver, [rewritten, ...args.slice(1)]);
    },
  });
}

async function generatedIsExact() {
  const [{ differences }] = await sql<{ differences: number }[]>`SELECT count(*)::int AS differences
    FROM conditions.feature WHERE external_ids IS DISTINCT FROM record -> 'externalIds'`;
  expect(differences).toBe(0);
}

async function store(records: Rec[]) {
  await sql.begin((tx) => storeRecords(tx, "feature", records, registry));
}

const flowSource = (restricted: boolean) => ({
  id: "nl-ndw-flow",
  domain: "roads",
  format: "datex2",
  product: "flow",
  tier: "authoritative",
  country: "NL",
  operator: "NDW",
  license: "CC0-1.0",
  attribution: "NDW",
  restricted,
  cadenceSec: 60,
  freshnessWindowSec: 600,
});

const snapshots = () => sql`SELECT id, record, ST_AsGeoJSON(geom)::jsonb AS geometry
  FROM conditions.feature ORDER BY id`;

async function stats() {
  // Every existing fixture connection flushes its own backend counters.
  const connections: postgres.ReservedSql[] = [];
  try {
    for (let i = 0; i < 4; i++) connections.push(await sql.reserve());
    await Promise.all(connections.map((c) => c`SELECT pg_stat_force_next_flush()`));
  } finally {
    for (const connection of connections) connection.release();
  }
  await sql`SELECT pg_stat_clear_snapshot()`;
  const [row] = await sql`SELECT n_tup_ins, n_tup_upd, n_tup_hot_upd,
    pg_current_wal_insert_lsn()::text AS lsn,
    pg_total_relation_size('conditions.feature')::text AS bytes,
    pg_indexes_size('conditions.feature')::text AS index_bytes
    FROM pg_stat_all_tables WHERE relid='conditions.feature'::regclass`;
  const [database] = await sql`SELECT temp_files, temp_bytes, blks_read, blks_hit,
    datid::text AS database_oid, datname AS database_name, stats_reset::text AS stats_reset,
    pg_postmaster_start_time()::text AS postmaster_started_at
    FROM pg_stat_database WHERE datname=current_database()`;
  Object.assign(row!, database);
  return row!;
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function validateMetricMarkers(before: Rec, after: Rec) {
  for (const marker of ["database_oid", "database_name", "stats_reset", "postmaster_started_at"]) {
    if (
      typeof before[marker] !== "string" ||
      !before[marker] ||
      typeof after[marker] !== "string" ||
      !after[marker]
    )
      throw new Error(`Missing metric marker ${marker}`);
    if (after[marker] !== before[marker]) throw new Error(`Drifting metric marker ${marker}`);
  }
}

function metricInteger(value: unknown, name: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Malformed metric ${name}`);
}

function checkedDelta(before: bigint, after: bigint, name: string): number {
  if (after < before) throw new Error(`Decreasing metric ${name}`);
  const result = Number(after - before);
  if (!Number.isSafeInteger(result)) throw new Error(`Unsafe metric delta ${name}`);
  return result;
}

function metricLsn(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9a-f]{1,8}\/[0-9a-f]{1,8}$/i.test(value))
    throw new Error("Malformed metric WAL LSN");
  const [high, low] = value.split("/");
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
}

async function measure(run: () => Promise<void>, expected: { inserts: number; updates: number }) {
  const counterResetRequestedAt = new Date().toISOString();
  await sql`SELECT pg_stat_reset()`;
  const counterResetAcknowledgedAt = new Date().toISOString();
  const host = { loadAverage: loadavg(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem() };
  const before = await stats();
  const started = performance.now();
  await run();
  const elapsedMs = performance.now() - started;
  const after = await stats();
  mkdirSync("plans/097-evidence", { recursive: true });
  writeFileSync(
    `plans/097-evidence/raw-metric-${PROFILE}-${armName}-${++nextMetric}.json`,
    JSON.stringify(
      {
        counterResetRequestedAt,
        counterResetAcknowledgedAt,
        before,
        after,
        expected,
        host,
        elapsedMs,
      },
      null,
      2,
    ),
  );
  validateMetricMarkers(before, after);
  const delta = (key: string) =>
    checkedDelta(metricInteger(before[key], key), metricInteger(after[key], key), key);
  const inserts = delta("n_tup_ins");
  const updates = delta("n_tup_upd");
  const hotUpdates = delta("n_tup_hot_upd");
  expect(inserts, "actual feature insertion count").toBe(expected.inserts);
  expect(updates, "actual feature update count before interpreting HOT").toBe(expected.updates);
  expect(hotUpdates).toBeLessThanOrEqual(updates);
  return {
    counterResetRequestedAt,
    counterResetAcknowledgedAt,
    counterSnapshots: { before, after },
    host,
    elapsedMs,
    inserts,
    updates,
    hotUpdates,
    walBytes: checkedDelta(metricLsn(before["lsn"]), metricLsn(after["lsn"]), "WAL"),
    tempFiles: delta("temp_files"),
    tempBytes: delta("temp_bytes"),
    bufferReads: delta("blks_read"),
    bufferHits: delta("blks_hit"),
    tableBytes: checkedDelta(0n, metricInteger(after["bytes"], "table size"), "table size"),
    indexBytes: checkedDelta(0n, metricInteger(after["index_bytes"], "index size"), "index size"),
  };
}

function firstRegisterDrafts(count: number) {
  const template = goldenFacilities().get("es-minetur-fuel")!.features[0]!;
  const templateLocation = template["location"] as Rec;
  const make = (source: string, i: number): Rec => ({
    ...template,
    id: `oc:feature:${source}:${i}`,
    externalIds:
      i >= 6 && i % 3 === 1
        ? undefined
        : [
            {
              scheme: "provider",
              id:
                i < 6
                  ? `ambiguous-${Math.floor(i / 2)}`
                  : i % 3 === 2 && source === "es-hot-poll"
                    ? `conflict-${i}`
                    : `shared-${i}`,
              authority: "hot-fixture",
            },
          ],
    provenance: { ...(template["provenance"] as Rec), sourceId: source, recordId: `${i}` },
    freshness: { fetchedAt: NOW },
    location: {
      ...templateLocation,
      geometry: {
        type: "Point",
        coordinates: [
          -4 + (i % 100) * 0.02 + (source === "es-hot-poll" ? (i % 3 === 0 ? 0.01 : 0.00002) : 0),
          40 + Math.floor(i / 100) * 0.01,
        ],
      },
    },
  });
  return {
    baseline: Array.from({ length: count }, (_, i) => make("es-hot-register", i)),
    polled: Array.from({ length: count }, (_, i) => make("es-hot-poll", i)),
  };
}

const firstRegisterOutput = async () => ({
  links: await sql`SELECT a_id,b_id,method,status FROM conditions.feature_link ORDER BY a_id,b_id`,
  canonical: await sql`SELECT * FROM conditions.feature_canonical ORDER BY canonical_feature_id`,
});

function assertFirstRegisterSemantics(
  actual: Awaited<ReturnType<typeof firstRegisterOutput>>,
  count: number,
) {
  const expectedLinks: { a_id: string; b_id: string; method: string; status: string }[] = [];
  const pair = (a: string, b: string, method: string) =>
    expectedLinks.push({ a_id: a < b ? a : b, b_id: a < b ? b : a, method, status: "accepted" });
  for (let group = 0; group < 3; group++) {
    const ids = ["es-hot-poll", "es-hot-register"].flatMap((source) =>
      [group * 2, group * 2 + 1].map((i) => `oc:feature:${source}:${i}`),
    );
    for (let a = 0; a < ids.length; a++)
      for (let b = a + 1; b < ids.length; b++) pair(ids[a]!, ids[b]!, "external_id");
  }
  for (let i = 6; i < count; i++) {
    const polled = `oc:feature:es-hot-poll:${i}`;
    const registered = `oc:feature:es-hot-register:${i}`;
    if (i % 3 !== 2) {
      pair(polled, registered, i % 3 === 0 ? "external_id" : "spatial_attribute");
      expect(
        actual.canonical.find((r) => (r["member_ids"] as string[]).includes(polled))?.[
          "member_ids"
        ],
      ).toEqual([polled, registered]);
    } else {
      expect(
        actual.canonical.find((r) => (r["member_ids"] as string[]).includes(polled))?.[
          "member_ids"
        ],
      ).toEqual([polled]);
      expect(
        actual.canonical.find((r) => (r["member_ids"] as string[]).includes(registered))?.[
          "member_ids"
        ],
      ).toEqual([registered]);
    }
  }
  expectedLinks.sort((a, b) =>
    a.a_id < b.a_id ? -1 : a.a_id > b.a_id ? 1 : a.b_id < b.b_id ? -1 : a.b_id > b.b_id ? 1 : 0,
  );
  expect(actual.links).toEqual(expectedLinks);
}

describe("external-ID generated representation experiment", () => {
  it("runs the selected physical PostgreSQL version", async () => {
    const [{ server_version_num }] = await sql`SHOW server_version_num`;
    expect(Math.floor(Number(server_version_num) / 10000)).toBe(PROFILE === "pg18" ? 18 : 16);
    console.info(
      "external-ID profile",
      JSON.stringify({ profile: PROFILE, image: EXPECTED_IMAGE, version }),
    );
  });

  it("rejects an unsupported profile before creating a disposable database", async () => {
    vi.stubEnv("OC_TEST_POSTGIS_PROFILE", "unsupported");
    let unexpected: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
    let failure: unknown;
    try {
      unexpected = await createTestDatabase();
    } catch (error) {
      failure = error;
    } finally {
      await unexpected?.close();
      vi.unstubAllEnvs();
    }
    expect(failure).toMatchObject({ message: "Unsupported OC_TEST_POSTGIS_PROFILE: unsupported" });
  }, 180_000);

  it("keeps generated IDs outside all writable lists and prevents explicit generated writes", async () => {
    await prepare("generated");
    const record = sealed(
      featureDraft("writable", 1, { externalIds: [{ scheme: "provider", id: "one" }] }),
    );
    expect(CLASS_COLUMNS.feature.map((c) => c.name)).not.toContain("external_ids");
    expect(rowOf("feature", record)).not.toHaveProperty("external_ids");
    await store([record]);
    const [{ attgenerated }] = await sql`SELECT attgenerated FROM pg_attribute
      WHERE attrelid='conditions.feature'::regclass AND attname='external_ids'`;
    expect(attgenerated).toBe("s");
    await expect(sql`UPDATE conditions.feature SET external_ids='[]'::jsonb`).rejects.toMatchObject(
      { code: "428C9" },
    );
    await generatedIsExact();
  });

  it("maintains missing, JSON-null, empty and large TOAST IDs through the existing storeRecords path", async () => {
    await prepare("generated");
    const ids = Array.from({ length: 1000 }, (_, i) => ({
      scheme: "provider",
      id: sha256Hex(`large-id-${i}`),
    }));
    const base = sealed(featureDraft("base", 1));
    const records = [undefined, null, [], ids].map((externalIds, i) => {
      const record = {
        ...base,
        id: `oc:feature:nl-ndw-flow:matrix-${i}`,
        canonicalId: `oc:feature:nl-ndw-flow:matrix-${i}`,
      };
      return externalIds === undefined ? record : { ...record, externalIds };
    });
    // SQL JSON-null is a persistence compatibility case, not a newly valid draft.
    await store(records);
    await generatedIsExact();
    const rows =
      await sql`SELECT id, external_ids IS NULL AS sql_null, jsonb_typeof(external_ids) AS json_type,
      pg_column_size(external_ids)::int AS size FROM conditions.feature ORDER BY id`;
    expect(rows.map((r) => [r["sql_null"], r["json_type"]])).toEqual([
      [true, null],
      [false, "null"],
      [false, "array"],
      [false, "array"],
    ]);
    expect(Number(rows[3]?.["size"])).toBeGreaterThan(2048);
    const changed = records.map((record) => ({
      ...record,
      name: [{ lang: "en", text: "Updated record" }],
      revision: 2,
      recordedAt: LATER,
    }));
    await store(changed);
    await generatedIsExact();
    const lookup = [{ scheme: "provider", id: ids[37]!.id }];
    const generatedMatches =
      await sql`SELECT id FROM conditions.feature WHERE external_ids @> ${JSON.stringify(lookup)}::text::jsonb`;
    const expressionMatches =
      await sql`SELECT id FROM conditions.feature WHERE (record -> 'externalIds') @> ${JSON.stringify(lookup)}::text::jsonb`;
    expect(generatedMatches).toEqual([{ id: records[3]!["id"] }]);
    expect(generatedMatches).toEqual(expressionMatches);
    const moved = sealed(
      featureDraft("writable-geometry", 1, {
        externalIds: lookup,
        location: {
          geometry: { type: "Point", coordinates: [5, 52] },
          extent: "point",
          geometryOrigin: "source",
          fuzziness: "exact",
        },
      }),
    );
    await store([moved]);
    await store([
      {
        ...moved,
        location: {
          ...(moved["location"] as Rec),
          geometry: { type: "Point", coordinates: [6, 51] },
        },
        revision: 2,
        recordedAt: LATER,
      },
    ]);
    await generatedIsExact();
    expect(
      (
        await sql`SELECT ST_AsGeoJSON(geom)::jsonb AS geometry FROM conditions.feature WHERE id=${moved["id"] as string}`
      )[0]?.["geometry"],
    ).toEqual({ type: "Point", coordinates: [6, 51] });
    const newIds = [{ scheme: "provider", id: "replacement-id" }];
    await store([{ ...moved, externalIds: newIds, revision: 3, recordedAt: LATER }]);
    await generatedIsExact();
    expect(
      await sql`SELECT id FROM conditions.feature WHERE id=${moved["id"] as string}
      AND external_ids @> ${JSON.stringify(lookup)}::text::jsonb`,
    ).toEqual([]);
    expect(
      await sql`SELECT id FROM conditions.feature WHERE id=${moved["id"] as string}
      AND external_ids @> ${JSON.stringify(newIds)}::text::jsonb`,
    ).toEqual([{ id: moved["id"] }]);
  });

  it("preserves expiry JSON, rights erasure, restoration and federation under old writable columns", async () => {
    await prepare("generated");
    await syncSources(sql, [flowSource(false)]);
    await sql`UPDATE conditions.source SET federation_restricted=false WHERE id='nl-ndw-flow'`;
    await sql`INSERT INTO conditions.federation_subscription(id,peer_id,delivery_mode,filter,created_at,updated_at)
      VALUES('hot-sub','hot-peer','pull','{"classes":["feature"]}'::jsonb,now(),now())`;
    const draft = featureDraft("rights", 1, {
      externalIds: [{ scheme: "provider", id: "rights-private-id" }],
      freshness: { fetchedAt: NOW, expiresAt: "2026-10-02T10:00:00.000Z" },
    });
    const first = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('nl-ndw-flow'))`;
      return writeSnapshotIn(tx, "nl-ndw-flow", { features: [draft] }, context());
    });
    expect(first.rejected).toEqual([]);
    expect(await sql`SELECT snapshot FROM conditions.feature_revision`).toHaveLength(1);
    await sql.begin((tx) =>
      refreshExpiries(tx, "feature", [
        { ...draft, freshness: { fetchedAt: LATER, expiresAt: "2026-10-03T10:00:00.000Z" } },
      ]),
    );
    await generatedIsExact();
    expect(
      (await sql`SELECT record #>> '{freshness,expiresAt}' AS expiry FROM conditions.feature`)[0]?.[
        "expiry"
      ],
    ).toBe("2026-10-03T10:00:00.000Z");
    await syncSources(sql, [flowSource(true)]);
    await reconcileFederation(sql);
    expect(
      (
        await sql`SELECT operation FROM conditions.federation_outbox WHERE record_class='feature' ORDER BY seq DESC LIMIT 1`
      )[0]?.["operation"],
    ).toBe("delete");
    await sql.begin((tx) =>
      tombstoneRecords(tx, "feature", [draft["id"] as string], "rights_revoked", context(LATER)),
    );
    expect(
      (
        await sql`SELECT external_ids,record ? 'externalIds' AS has_ids,geom IS NULL AS no_geometry FROM conditions.feature`
      )[0],
    ).toEqual({ external_ids: null, has_ids: false, no_geometry: true });
    expect(
      await sql`SELECT snapshot FROM conditions.federation_outbox WHERE operation <> 'delete'`,
    ).toEqual([]);
    expect(await sql`SELECT snapshot FROM conditions.feature_revision`).toEqual([]);
    const restored = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('nl-ndw-flow'))`;
      return writeSnapshotIn(tx, "nl-ndw-flow", { features: [draft] }, context(LATER));
    });
    expect(restored.rejected).toEqual([]);
    expect(restored.counts.feature.restored).toBe(1);
    await generatedIsExact();
    await syncSources(sql, [flowSource(false)]);
    await reconcileFederation(sql);
    expect(
      (
        await sql`SELECT snapshot FROM conditions.federation_outbox WHERE operation='create' ORDER BY seq DESC LIMIT 1`
      )[0]?.["snapshot"],
    ).toMatchObject({ externalIds: draft["externalIds"] });
  });

  it("preserves exact far-ID, near-missing-ID and conflict separation through the actual writer and candidate proxy", async () => {
    const { baseline, polled } = firstRegisterDrafts(9);
    let expected: unknown;
    for (const mode of ["expression", "generated"] as Mode[]) {
      await prepare(mode);
      const trace: LookupTrace[] = [];
      for (const [source, features, now] of [
        ["es-hot-register", baseline, NOW],
        ["es-hot-poll", polled, LATER],
      ] as const) {
        const result = await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${source}))`;
          return writeSnapshotIn(
            mode === "generated" ? candidateLookup(tx, trace) : tx,
            source,
            { features },
            context(now),
          );
        });
        expect(result.rejected).toEqual([]);
        expect(result.counts.feature.created).toBe(9);
      }
      const actual = await firstRegisterOutput();
      assertFirstRegisterSemantics(actual, 9);
      if (expected === undefined) expected = actual;
      else expect(actual).toEqual(expected);
      if (mode === "generated") {
        expect(trace).toHaveLength(2);
        expect(
          trace.every(
            (t) => t.candidate.includes("f.external_ids") && t.candidate.includes("OFFSET 0"),
          ),
        ).toBe(true);
        await generatedIsExact();
      }
    }
  }, 180_000);

  it.skipIf(!RUN_BENCHMARK)(
    "measures actual expiry and upsert paths under default page space in five restored pairs",
    async () => {
      const runs: Rec[] = [];
      for (const shape of ["small", "toast"] as const) {
        const drafts = Array.from({ length: shape === "small" ? 1000 : 100 }, (_, i) =>
          featureDraft(`bench-${i}`, 1, {
            externalIds: Array.from({ length: shape === "small" ? 1 : 100 }, (_, j) => ({
              scheme: "provider",
              id: sha256Hex(`${i}:${j}`),
            })),
            freshness: { fetchedAt: NOW, expiresAt: "2026-10-02T10:00:00.000Z" },
          }),
        );
        for (let repetition = 0; repetition < 5; repetition++) {
          let expected: unknown;
          let expectedExpiry: unknown;
          for (const mode of (repetition % 2
            ? ["generated", "expression"]
            : ["expression", "generated"]) as Mode[]) {
            await prepare(mode);
            await store(drafts.map((d) => sealed(d)));
            await sql`VACUUM ANALYZE conditions.feature`;
            const expiryDrafts = drafts.map((d) => ({
              ...d,
              freshness: { fetchedAt: LATER, expiresAt: "2026-10-03T10:00:00.000Z" },
            }));
            const expiry = await measure(
              async () => {
                await sql.begin((tx) => refreshExpiries(tx, "feature", expiryDrafts));
              },
              { inserts: 0, updates: drafts.length },
            );
            if (mode === "generated") await generatedIsExact();
            const expiryOutput = await snapshots();
            if (expectedExpiry === undefined) expectedExpiry = expiryOutput;
            else expect(expiryOutput).toEqual(expectedExpiry);
            const changed = drafts.map((d) =>
              sealed(
                {
                  ...d,
                  name: [{ lang: "en", text: "Changed record, same IDs" }],
                  freshness: expiryDrafts[0]!["freshness"] as Rec,
                },
                LATER,
                2,
              ),
            );
            const upsert = await measure(
              async () => {
                await store(changed);
              },
              { inserts: 0, updates: changed.length },
            );
            if (mode === "generated") await generatedIsExact();
            const actual = await snapshots();
            if (expected === undefined) expected = actual;
            else expect(actual).toEqual(expected);
            runs.push({
              shape,
              repetition,
              mode,
              expiry,
              upsert,
              logicalHash: createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
            });
          }
        }
      }
      const aggregates: Rec[] = [];
      for (const shape of ["small", "toast"])
        for (const mode of ["expression", "generated"]) {
          const selected = runs.filter((r) => r["shape"] === shape && r["mode"] === mode);
          aggregates.push({
            shape,
            mode,
            expiryElapsedMs: summary(
              selected.map((r) => (r["expiry"] as { elapsedMs: number }).elapsedMs),
            ),
            upsertElapsedMs: summary(
              selected.map((r) => (r["upsert"] as { elapsedMs: number }).elapsedMs),
            ),
            expiryWalBytes: summary(
              selected.map((r) => (r["expiry"] as { walBytes: number }).walBytes),
            ),
            expiryHotRatio: summary(
              selected.map((r) => {
                const metric = r["expiry"] as { updates: number; hotUpdates: number };
                return metric.updates === 0 ? 0 : metric.hotUpdates / metric.updates;
              }),
            ),
            upsertWalBytes: summary(
              selected.map((r) => (r["upsert"] as { walBytes: number }).walBytes),
            ),
          });
        }
      mkdirSync("plans/097-evidence", { recursive: true });
      writeFileSync(
        `plans/097-evidence/hot-${PROFILE}.json`,
        JSON.stringify(
          {
            profile: PROFILE,
            image: EXPECTED_IMAGE,
            version,
            pagePolicy:
              "unchanged fillfactor and all existing indexes; expression index removed only in disposable generated case",
            budget: BENEFIT_BUDGET,
            runs,
            aggregates,
          },
          null,
          2,
        ),
      );
      console.info(
        "external-ID actual-path metrics",
        JSON.stringify({ profile: PROFILE, runs, aggregates }),
      );
    },
    600_000,
  );

  it.skipIf(!RUN_BENCHMARK)(
    "compares first-register linking through actual writeSnapshotIn and candidate lookup in five pairs",
    async () => {
      const { baseline, polled } = firstRegisterDrafts(1000);
      const runs: Rec[] = [];
      for (let repetition = 0; repetition < 5; repetition++) {
        let expected: unknown;
        for (const mode of (repetition % 2
          ? ["generated", "expression"]
          : ["expression", "generated"]) as Mode[]) {
          await prepare(mode);
          const initialMetrics = await measure(
            async () => {
              const initial = await sql.begin(async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(hashtext('es-hot-register'))`;
                return writeSnapshotIn(
                  mode === "generated" ? candidateLookup(tx, []) : tx,
                  "es-hot-register",
                  { features: baseline },
                  context(),
                );
              });
              expect(initial.rejected).toEqual([]);
              expect(initial.counts.feature.created).toBe(1000);
            },
            { inserts: 1000, updates: 0 },
          );
          await sql`VACUUM ANALYZE conditions.feature`;
          const trace: LookupTrace[] = [];
          const queries: { query: string; parameters: unknown[] }[] = [];
          const debug = sql.options.debug;
          sql.options.debug = (_connection, query, parameters) => {
            if (query.includes("UNION") && query.includes("external"))
              queries.push({ query, parameters: [...parameters] });
          };
          let metrics: Awaited<ReturnType<typeof measure>>;
          try {
            metrics = await measure(
              async () => {
                const result = await sql.begin(async (tx) => {
                  await tx`SELECT pg_advisory_xact_lock(hashtext('es-hot-poll'))`;
                  return writeSnapshotIn(
                    mode === "generated" ? candidateLookup(tx, trace) : tx,
                    "es-hot-poll",
                    { features: polled },
                    context(LATER),
                  );
                });
                expect(result.rejected).toEqual([]);
                expect(result.counts.feature.created).toBe(1000);
              },
              { inserts: 1000, updates: 0 },
            );
          } finally {
            sql.options.debug = debug;
          }
          const actual = await firstRegisterOutput();
          if (expected === undefined) expected = actual;
          else expect(actual).toEqual(expected);
          const ambiguous = [{ scheme: "provider", id: "ambiguous-0", authority: "hot-fixture" }];
          expect(
            await sql`SELECT id FROM conditions.feature
          WHERE (record -> 'externalIds') @> ${JSON.stringify(ambiguous)}::text::jsonb ORDER BY id`,
          ).toHaveLength(4);
          assertFirstRegisterSemantics(actual, 1000);
          if (mode === "generated") {
            expect(trace).toHaveLength(1);
            const search = trace[0]!;
            const executed = queries.find((q) => q.query.includes("f.external_ids"));
            expect(executed).toBeDefined();
            expect(executed!.query).toContain("OFFSET 0");
            const plan = await sql.unsafe(
              `EXPLAIN (FORMAT JSON) ${executed!.query}`,
              executed!.parameters as never,
            );
            expect(JSON.stringify(plan)).toContain(`"Index Name":"${GENERATED_INDEX}"`);
            expect(JSON.stringify(plan)).not.toContain('"Node Type":"BitmapAnd"');
            expect(search.candidate).toContain("f.external_ids");
            await generatedIsExact();
          }
          runs.push({
            repetition,
            mode,
            metrics,
            initialMetrics,
            lookupRewritten: trace.length,
            logicalHash: createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
          });
        }
      }
      const aggregates = ["expression", "generated"].map((mode) => {
        const selected = runs.filter((r) => r["mode"] === mode);
        return {
          mode,
          initialElapsedMs: summary(
            selected.map((r) => (r["initialMetrics"] as { elapsedMs: number }).elapsedMs),
          ),
          firstRegisterElapsedMs: summary(
            selected.map((r) => (r["metrics"] as { elapsedMs: number }).elapsedMs),
          ),
        };
      });
      mkdirSync("plans/097-evidence", { recursive: true });
      writeFileSync(
        `plans/097-evidence/first-register-${PROFILE}.json`,
        JSON.stringify(
          {
            profile: PROFILE,
            image: EXPECTED_IMAGE,
            version,
            budget: BENEFIT_BUDGET,
            aggregates,
            seam: "private transaction proxy rewrites exactly two external-ID fragments; parameters/spatial/OFFSET0 unchanged; not a production-reader or migration acceptance",
            runs,
          },
          null,
          2,
        ),
      );
      console.info(
        "external-ID first-register metrics",
        JSON.stringify({ profile: PROFILE, runs, aggregates }),
      );
    },
    600_000,
  );
});
