import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "../bulk.js";
import { LatestCache } from "../latest-cache.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { type WriteContext, writeSnapshotIn } from "../write-records.js";
import { FETCHED_AT, featureDraft, observationDraft } from "./drafts.js";

type Rec = Record<string, unknown>;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
const registry = productionRegistry();
const NOW = "2026-10-01T10:00:05.000Z";
const SOURCE = "nl-ndw-flow";
const ctx: WriteContext = { registry, instanceId: "test.local", now: NOW, complete: false };

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

const clear = async () => {
  await sql`TRUNCATE conditions.observation_latest CASCADE`;
  await sql`TRUNCATE conditions.observation, conditions.source_shrink`;
};

beforeEach(clear);

const site = (s: string) => ({ kind: "feature", featureId: `oc:feature:nl-ndw-flow:${s}` });
/** A polled change-only reading: a level of service. */
const los = (s: string, value: string, at: string, over: Rec = {}) =>
  observationDraft(
    "traffic.los",
    { type: "category", value, vocabulary: "los" },
    { at, subject: site(s), ...over },
  );
/** A reading of a property that keeps every reading: a speed. */
const speed = (s: string, value: number, at: string, over: Rec = {}) =>
  observationDraft(
    "traffic.speed",
    { type: "quantity", value, unit: "km/h" },
    { at, aggregation: "mean", subject: site(s), ...over },
  );

/** One poll of the source, and what happens around it. */
interface Step {
  drafts: Rec[];
  features?: Rec[];
  ctx?: Partial<WriteContext>;
  /** Another writer's change before the poll. */
  meanwhile?: () => Promise<unknown>;
  /** The poll's transaction rolls back after the write. */
  rollsBack?: boolean;
  /** The source polled, when not `SOURCE`. */
  source?: string;
}

class RolledBack extends Error {}

/** A transaction that records the series each latest-row lookup asks for. */
function counting(tx: postgres.TransactionSql, lookups: number[]): Sql {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
      return (query: string, params?: unknown[], ...rest: unknown[]) => {
        if (/FROM conditions\.observation_latest l\s+JOIN jsonb_to_recordset/.test(query)) {
          lookups.push(JSON.parse(params![0] as string).length);
        }
        return (target.unsafe as (...args: unknown[]) => unknown)(query, params, ...rest);
      };
    },
  }) as unknown as Sql;
}

interface Outcome {
  observations: unknown;
  latest: unknown;
  history: unknown;
}

/**
 * Runs the steps from an empty source, each poll with the cache `cacheAt`
 * gives for it (none: today's path), and returns what each poll wrote and
 * left, and how many series each looked up.
 */
async function run(
  steps: readonly Step[],
  cacheAt: (step: number) => LatestCache | undefined,
): Promise<{ outcomes: Outcome[]; lookups: number[] }> {
  await clear();
  const outcomes: Outcome[] = [];
  const lookups: number[] = [];
  for (const [i, step] of steps.entries()) {
    await step.meanwhile?.();
    const source = step.source ?? SOURCE;
    const write = cacheAt(i)?.begin(source);
    const asked: number[] = [];
    let observations: unknown;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${source}))`;
        const summary = await writeSnapshotIn(
          counting(tx, asked),
          source,
          { observations: step.drafts, ...(step.features ? { features: step.features } : {}) },
          { ...ctx, ...step.ctx, ...(write ? { latestCache: write } : {}) },
        );
        observations = summary.observations;
        if (step.rollsBack) throw new RolledBack();
      });
      write?.commit();
    } catch (err) {
      write?.discard();
      if (!(err instanceof RolledBack)) throw err;
    }
    lookups.push(asked.reduce((a, b) => a + b, 0));
    outcomes.push({
      observations,
      latest: await sql`
        SELECT subject_key, property, qualifier_key, source_id, reading, template, template_hash,
               contributor_receipt_id, value_num, value_text, effective_from, effective_until,
               since_at, expires_at, updated_at
          FROM conditions.observation_latest ORDER BY source_id, subject_key, property`,
      history: await sql`
        SELECT phenomenon_start, issued_at, value_num, value_text, valid_until, recorded_at
          FROM conditions.observation ORDER BY phenomenon_start, value_text, value_num`,
    });
  }
  return { outcomes, lookups };
}

/**
 * Runs the steps with no cache and again with one cache throughout (or the
 * caches `cacheAt` gives), expects every poll to write and leave the same,
 * and returns the cached run's lookups.
 */
async function sameAsUncached(
  steps: readonly Step[],
  cacheAt?: (step: number) => LatestCache | undefined,
): Promise<number[]> {
  const uncached = await run(steps, () => undefined);
  const cache = new LatestCache();
  const cached = await run(steps, cacheAt ?? (() => cache));
  for (const [i, outcome] of cached.outcomes.entries()) {
    expect(outcome, `poll ${i}`).toEqual(uncached.outcomes[i]);
  }
  return cached.lookups;
}

const T0 = "2026-10-01T09:00:00Z";
const T1 = "2026-10-01T09:01:00Z";
const T2 = "2026-10-01T09:02:00Z";
const T3 = "2026-10-01T09:03:00Z";

const statuses = (at: string, s3 = "free_flow") => [
  los("s1", "queuing", at),
  los("s2", "free_flow", at),
  los("s3", s3, at),
];

describe("a latest cache in front of the readings write", () => {
  it("looks up no series a polled feed restates unchanged, and writes a change as before", async () => {
    const lookups = await sameAsUncached([
      { drafts: statuses(T0) },
      { drafts: statuses(T1) },
      { drafts: statuses(T2, "queuing") },
      { drafts: statuses(T3, "queuing") },
    ]);
    expect(lookups).toEqual([3, 0, 1, 0]);
  });

  it("looks up no series once a feed sent its reading again, and every series whose reading moved", async () => {
    const readings = (at: string, s2 = 80) => [speed("s1", 90, T0), speed("s2", s2, at)];
    const lookups = await sameAsUncached([
      { drafts: readings(T0) },
      { drafts: readings(T0) },
      { drafts: readings(T1, 70) },
      { drafts: readings(T1, 70) },
    ]);
    // A series of a property that keeps every reading is cached once a poll
    // finds it unchanged: a feed whose every reading moves (flow) holds none.
    expect(lookups).toEqual([2, 2, 1, 0]);
  });

  it("starts cold after a restart and behaves as the write without a cache", async () => {
    const caches = [new LatestCache(), new LatestCache(), new LatestCache()];
    const lookups = await sameAsUncached(
      [{ drafts: statuses(T0) }, { drafts: statuses(T1) }, { drafts: statuses(T2) }],
      (i) => caches[Math.min(i, 1)],
    );
    expect(lookups).toEqual([3, 3, 0]);
  });

  it("forgets what a poll whose transaction rolled back wrote", async () => {
    const lookups = await sameAsUncached([
      { drafts: statuses(T0) },
      { drafts: statuses(T1, "queuing"), rollsBack: true },
      { drafts: statuses(T2, "queuing") },
      { drafts: statuses(T3, "queuing") },
    ]);
    expect(lookups).toEqual([3, 1, 1, 0]);
  });

  it("checks what it holds against the rows, so a write it never saw committed cannot mislead it", async () => {
    const cache = new LatestCache();
    // A poll that rolled back, its cache entries committed all the same.
    const careless = {
      begin: (source: string) => {
        const write = cache.begin(source);
        return Object.assign(write, { discard: () => write.commit() });
      },
    } as unknown as LatestCache;
    const lookups = await sameAsUncached(
      [
        { drafts: statuses(T0) },
        { drafts: statuses(T1, "queuing"), rollsBack: true },
        { drafts: statuses(T2, "queuing") },
      ],
      () => careless,
    );
    expect(lookups).toEqual([3, 1, 1]);
  });

  it("writes a series again when a complete poll ended it", async () => {
    const complete = { statesComplete: true };
    await sameAsUncached([
      { drafts: statuses(T0), ctx: complete },
      { drafts: statuses(T1).slice(0, 2), ctx: complete },
      { drafts: statuses(T2), ctx: complete },
      { drafts: statuses(T3), ctx: complete },
    ]);
  });

  it("writes a series again when this poll changed its site", async () => {
    const location = {
      geometry: { type: "Point", coordinates: [4.6, 52.1] },
      extent: "point",
      geometryOrigin: "site_table",
      fuzziness: "exact",
    };
    await sameAsUncached([
      { drafts: statuses(T0), features: [featureDraft("s1")] },
      { drafts: statuses(T1), features: [featureDraft("s1")] },
      {
        drafts: [los("s1", "queuing", T2, { location }), ...statuses(T2).slice(1)],
        features: [featureDraft("s1", 2, { location })],
      },
    ]);
  });

  it("writes a series whose row went away again", async () => {
    await sameAsUncached([
      { drafts: statuses(T0) },
      { drafts: statuses(T1) },
      {
        drafts: statuses(T2),
        meanwhile: () =>
          sql`DELETE FROM conditions.observation_latest WHERE subject_key LIKE '%:s2'`,
      },
    ]);
  });

  it("weighs a reading against a row another writer changed", async () => {
    await sameAsUncached([
      { drafts: [...statuses(T0), speed("s1", 90, T0)] },
      { drafts: [...statuses(T1), speed("s1", 90, T0)] },
      {
        drafts: [...statuses(T2), speed("s1", 90, T0)],
        meanwhile: () => sql`
          UPDATE conditions.observation_latest
             SET reading = jsonb_set(jsonb_set(reading, '{result,value}', '"queuing"'),
                   '{contentHash}', to_jsonb(repeat('0', 64)))
           WHERE subject_key LIKE '%:s2' AND property = 'traffic.los'`,
      },
      {
        drafts: [...statuses(T3), speed("s1", 90, T0)],
        meanwhile: () => sql`
          UPDATE conditions.observation_latest
             SET reading = jsonb_set(reading, '{contentHash}', to_jsonb(repeat('0', 64)))
           WHERE property = 'traffic.speed'`,
      },
    ]);
  });

  it("moves an expiry another writer moved back to the one the feed states", async () => {
    const expiring = (at: string) =>
      statuses(at).map((d) => ({
        ...d,
        freshness: { fetchedAt: FETCHED_AT, expiresAt: "2026-10-01T11:00:00.000Z" },
      }));
    await sameAsUncached([
      { drafts: expiring(T0) },
      { drafts: expiring(T1) },
      {
        drafts: expiring(T2),
        meanwhile: () => sql`
          UPDATE conditions.observation_latest SET expires_at = '2026-10-01T12:00:00Z'
           WHERE subject_key LIKE '%:s3'`,
      },
      { drafts: statuses(T3) },
    ]);
  });

  it("attaches a receipt to a row that lost it when the poll was freshly acquired", async () => {
    const acquired = { captureEvidence: "acquired" as const };
    await sameAsUncached([
      { drafts: statuses(T0), ctx: acquired },
      { drafts: statuses(T1), ctx: acquired },
      {
        drafts: statuses(T2),
        ctx: acquired,
        meanwhile: () => sql`
          UPDATE conditions.observation_latest SET contributor_receipt_id = NULL
           WHERE subject_key LIKE '%:s1'`,
      },
    ]);
  });

  it("weighs a poll stating a series twice, or an older state, as before", async () => {
    await sameAsUncached([
      { drafts: statuses(T1) },
      { drafts: statuses(T2) },
      {
        drafts: [los("s1", "free_flow", T0), los("s2", "free_flow", T3), los("s2", "queuing", T3)],
      },
      { drafts: statuses(T3) },
    ]);
  });

  it("leaves a source that does not fit its budget uncached and correct, and the others cached whole", async () => {
    const OTHER = "be-test-flow";
    const other = (at: string, s3 = "free_flow") =>
      statuses(at, s3).map((d) => {
        const { id: _id, ...draft } = d;
        return observationDraft("traffic.los", draft["result"] as Rec, {
          ...draft,
          at,
          sourceId: OTHER,
          provenance: { ...(draft["provenance"] as Rec), sourceId: OTHER },
        });
      });
    const logged: string[] = [];
    const cache = new LatestCache(4, { log: (m) => logged.push(m) });
    const lookups = await sameAsUncached(
      [
        { drafts: statuses(T0) },
        { drafts: other(T0), source: OTHER },
        { drafts: statuses(T1) },
        { drafts: other(T1), source: OTHER },
        { drafts: statuses(T2, "queuing") },
        { drafts: other(T2, "queuing"), source: OTHER },
        { drafts: statuses(T3, "queuing") },
        { drafts: other(T3, "queuing"), source: OTHER },
      ],
      () => cache,
    );
    expect(lookups).toEqual([3, 3, 0, 3, 1, 3, 0, 3]);
    expect(cache.sizeOf(SOURCE)).toBe(3);
    expect(cache.sizeOf(OTHER)).toBe(0);
    expect(logged).toEqual([expect.stringMatching(/be-test-flow: 3 series/)]);
  });
});
