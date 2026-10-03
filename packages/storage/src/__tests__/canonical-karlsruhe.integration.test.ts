import { seriesKeyOf } from "@openconditions/core";
import { readCanonical, readLatestObservation } from "@openconditions/core/server";
import { type CanonicalComponent, landClaim, observationId } from "@openconditions/model";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateCanonicalView } from "../canonical-view.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { sweepRecords } from "../sweep.js";
import { writeRecord } from "../write-record.js";
import { type WriteContext, writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import {
  karlsruheCharging,
  luisenstrasse,
  osmFeatures,
  parkapiKarlsruhe,
  polled,
  registry,
  seedSources,
} from "./facility-fixtures.js";

type Rec = Record<string, unknown>;

const observationIdOf = (draft: Rec) => observationId("de-bw-ocpdb", draft as never);

/**
 * Linking through the tables against real records of one city: MobiData BW's
 * charge points and car parks of central Karlsruhe and OpenStreetMap's for
 * the same streets, and the car park two of the charge-point database's
 * sources describe. Crowd readings on the canonical charge points follow
 * their cluster when a person splits it, and lapse with their report.
 */
const FETCHED = "2026-10-01T06:40:00.000Z";
const NOW = "2026-10-01T07:00:00.000Z";
const INSTANCE = "test.local";
const ctx: WriteContext = { registry, instanceId: INSTANCE, now: NOW, complete: true };
const LIVE = "oc:feature:de-bw-ocpdb:332714";
const REGISTER = "oc:feature:de-bw-ocpdb:341736";

const charging = karlsruheCharging(FETCHED);
const [live, register] = luisenstrasse(FETCHED) as [
  ReturnType<typeof luisenstrasse>[number],
  ReturnType<typeof luisenstrasse>[number],
];

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
  await seedSources(sql, {
    "de-bw-ocpdb": "aggregator",
    "de-bw-parkapi": "aggregator",
    osm: "community",
  });
  for (const source of ["de-bw-ocpdb", "de-bw-parkapi", "osm"]) await polled(sql, source, NOW);
  const sites = [...charging, live, register];
  const writes: [string, Rec[], Rec[]][] = [
    ["de-bw-ocpdb", sites.map((s) => s.feature), sites.flatMap((s) => s.statuses)],
    ["de-bw-parkapi", parkapiKarlsruhe(FETCHED), []],
    [
      "osm",
      [
        ...osmFeatures("charging_site", "charging_station", FETCHED),
        ...osmFeatures("parking_site", "parking", FETCHED),
      ],
      [],
    ],
  ];
  for (const [sourceId, features, observations] of writes) {
    const summary = await writeSnapshot(sql, sourceId, { features, observations }, ctx);
    expect(summary.rejected, sourceId).toEqual([]);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

interface CanonicalDbRow {
  canonical_feature_id: string;
  survivor_id: string;
  member_ids: string[];
  components: CanonicalComponent[];
}

const canonicalOf = async (featureId: string) => {
  const [row] = await sql<CanonicalDbRow[]>`
    SELECT canonical_feature_id, survivor_id, member_ids, components
      FROM conditions.feature_canonical WHERE ${featureId} = ANY(member_ids)`;
  return row!;
};

const links = (kind: string) =>
  sql<
    {
      a_id: string;
      b_id: string;
      method: string;
      status: string;
      name_a: string | null;
      name_b: string | null;
    }[]
  >`
    SELECT l.a_id, l.b_id, l.method, l.status,
           a.record #>> '{name,0,text}' AS name_a, b.record #>> '{name,0,text}' AS name_b
      FROM conditions.feature_link l
      JOIN conditions.feature a ON a.id = l.a_id
      JOIN conditions.feature b ON b.id = l.b_id
     WHERE a.kind = ${kind}`;

const fusedOn = (canonicalId: string) =>
  sql<{ component_key: string | null; property: string; fused_from: string[]; record: Rec }[]>`
    SELECT component_key, property, fused_from,
           conditions.observation_record(template, reading) AS record
      FROM conditions.observation_latest
     WHERE source_id = '@fused' AND feature_id = ${canonicalId}`;

describe("linking Karlsruhe's charge points and car parks through the tables", () => {
  it("links the one charging site OpenStreetMap maps within the close window, and the car park two rows describe", async () => {
    const accepted = (await links("charging_site")).filter((l) => l.status === "accepted");
    expect(accepted.map((l) => [l.a_id, l.b_id.split(":")[2]])).toEqual(
      expect.arrayContaining([
        ["oc:feature:de-bw-ocpdb:206019", "osm"],
        [LIVE, "de-bw-ocpdb"],
      ]),
    );
    expect(accepted.find((l) => l.a_id === LIVE)!.b_id).toBe(REGISTER);
  });

  it("links the garages both sources name alike, and not neighbours with unrelated names", async () => {
    const accepted = (await links("parking_site")).filter((l) => l.status === "accepted");
    const pairs = accepted.map((l) => [l.name_a, l.name_b].sort());
    expect(pairs).toContainEqual(["Parkgarage Waldhornstraße", "Parkgarage Waldhornstraße"]);
    expect(pairs).not.toContainEqual(["Akademiestraße", "Karlstraße"]);
  });

  it("holds every feature in exactly one canonical row", async () => {
    const [{ features }] = await sql<{ features: number }[]>`
      SELECT count(*)::int AS features FROM conditions.feature WHERE tombstoned_at IS NULL`;
    const [{ members, distinct }] = await sql<{ members: number; distinct: number }[]>`
      SELECT count(*)::int AS members, count(DISTINCT m)::int AS distinct
        FROM conditions.feature_canonical, unnest(member_ids) m`;
    expect(members).toBe(features);
    expect(distinct).toBe(features);
  });

  it("keeps all twenty charge points of the car park in its canonical components", async () => {
    const canonical = await canonicalOf(LIVE);
    expect(canonical.member_ids).toEqual([LIVE, REGISTER]);
    expect(canonical.survivor_id).toBe(LIVE);
    const evses = canonical.components.filter((c) => c.kind === "evse");
    expect(evses).toHaveLength(20);
    expect(evses.filter((c) => c.key.startsWith("de-bw-ocpdb/"))).toHaveLength(10);
  });

  it("gives every canonical charge point with a status one fused row, credited to the database", async () => {
    const canonical = await canonicalOf(LIVE);
    const fused = (await fusedOn(canonical.canonical_feature_id)).filter(
      (r) => r.property === "charging.evse_status",
    );
    const evses = canonical.components.filter((c) => c.kind === "evse");
    expect(fused.map((r) => r.component_key).sort()).toEqual(evses.map((c) => c.key).sort());
    for (const row of fused) {
      expect(row.fused_from).toHaveLength(1);
      expect(row.record["provenance"]).toMatchObject({
        sourceId: "@fused",
        attribution: { provider: "MobiData BW" },
      });
    }
  });
});

describe("a crowd reading on the canonical car park", () => {
  const liveComponents = live.feature["components"] as { key: string; kind: string }[];
  const survivorEvse = liveComponents.find((c) => c.kind === "evse")!.key;
  const registerEvse = (register.feature["components"] as { key: string; kind: string }[]).find(
    (c) => c.kind === "evse",
  )!.key;
  let before: CanonicalDbRow;

  const report = async (
    componentKey: string,
    nonce: string,
    reportedAt = "2026-10-01T06:58:00.000Z",
  ) => {
    const canonical = await canonicalOf(LIVE);
    const feature = await sql<
      { record: Rec }[]
    >`SELECT record FROM conditions.feature WHERE id = ${LIVE}`;
    const landed = landClaim(
      registry,
      {
        claim: {
          claimClass: "observation",
          subject: { featureId: canonical.canonical_feature_id, componentKey },
          property: "charging.evse_status",
          result: { type: "category", value: "out_of_order", vocabulary: "evse_status" },
          geometry: { type: "Point", coordinates: [8.40478, 49.00062] },
          reportedAt,
          nonce,
        },
        keyId: "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY",
      },
      {
        instanceId: INSTANCE,
        now: NOW,
        attribution: {
          provider: `OpenConditions contributors at ${INSTANCE}`,
          license: "ODbL-1.0",
        },
        resolveFeature: (featureId, key) =>
          featureId === canonical.canonical_feature_id &&
          (key === undefined || canonical.components.some((c) => c.key === key))
            ? {
                featureId,
                ...(key === undefined ? {} : { componentKey: key }),
                location: feature[0]!.record["location"] as never,
              }
            : undefined,
      },
    );
    if (!landed.ok) throw new Error(JSON.stringify(landed.issues));
    const written = await writeRecord(
      sql,
      { draft: landed.draft },
      { registry, instanceId: INSTANCE, now: NOW },
    );
    expect(written.status).not.toBe("rejected");
    await sql`
      UPDATE conditions.observation_latest SET evidence_state = 'self_reported', confidence_score = 0.5
       WHERE crowd_record_id = ${landed.draft["id"] as string}`;
    return landed.draft["id"] as string;
  };

  beforeAll(async () => {
    before = await canonicalOf(LIVE);
    await report(survivorEvse, "nonce-survivor-0001");
    await report(
      before.components.find((c) =>
        c.members.some((m) => m.featureId === REGISTER && m.key === registerEvse),
      )!.key,
      "nonce-register-0001",
    );
  }, 60_000);

  it("lands beside the feed's row on the canonical subject", async () => {
    const rows = await sql`
      SELECT feature_id, component_key FROM conditions.observation_latest WHERE source_id = 'crowd'`;
    expect(rows.every((r) => r["feature_id"] === before.canonical_feature_id)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("reads back with its evidence, and its subject resolves through the canonical view", async () => {
    const [row] = await sql<{ record: Rec }[]>`
      SELECT conditions.observation_record(template, reading) AS record
        FROM conditions.observation_latest WHERE source_id = 'crowd' LIMIT 1`;
    const read = await readLatestObservation(sql, seriesKeyOf(row!.record));
    expect(read!["evidence"]).toEqual({
      state: "self_reported",
      confidenceScore: 0.5,
      routingEligible: false,
      corroborations: 0,
    });
    expect(await readCanonical(sql, REGISTER)).toEqual({
      canonicalFeatureId: before.canonical_feature_id,
      survivorId: LIVE,
      memberIds: [LIVE, REGISTER],
      components: before.components,
    });
    expect(await readCanonical(sql, before.canonical_feature_id)).toEqual(
      await readCanonical(sql, LIVE),
    );
  });

  it("moves with the charge point it reports when a person splits the car park, and a rejected link sticks", async () => {
    await sql`
      UPDATE conditions.feature_link SET status = 'rejected', decided_by = 'reviewer', decided_at = ${NOW}
       WHERE a_id = ${LIVE} AND b_id = ${REGISTER}`;
    await sql.begin((tx) =>
      updateCanonicalView(
        tx,
        registry,
        { sourceId: "de-bw-ocpdb", featureIds: [LIVE, REGISTER], observations: [] },
        { instanceId: INSTANCE, now: NOW },
      ),
    );
    const [link] =
      await sql`SELECT status, decided_by FROM conditions.feature_link WHERE a_id = ${LIVE} AND b_id = ${REGISTER}`;
    expect(link).toMatchObject({ status: "rejected", decided_by: "reviewer" });
    const survivor = await canonicalOf(LIVE);
    expect(survivor.member_ids).toEqual([LIVE]);
    expect((await canonicalOf(REGISTER)).member_ids).toEqual([REGISTER]);

    const crowd = await sql<{ feature_id: string; component_key: string; record: Rec }[]>`
      SELECT feature_id, component_key,
             conditions.observation_record(template, reading) AS record
        FROM conditions.observation_latest
       WHERE source_id = 'crowd' ORDER BY feature_id = ${survivor.canonical_feature_id} DESC`;
    // Each reading follows the charge point it reports: the register's charge point
    // has no counterpart on the live feed's site, so its reading moves to the register's
    // own canonical feature.
    const registerCanonical = (await canonicalOf(REGISTER)).canonical_feature_id;
    expect(crowd).toHaveLength(2);
    expect(crowd[0]).toMatchObject({
      feature_id: survivor.canonical_feature_id,
      component_key: survivorEvse,
    });
    expect(crowd[0]!.record["subject"]).toEqual({
      kind: "feature",
      featureId: survivor.canonical_feature_id,
      componentKey: survivorEvse,
    });
    expect(crowd[1]).toMatchObject({ feature_id: registerCanonical, component_key: registerEvse });
    expect(crowd[1]!.record["subject"]).toEqual({
      kind: "feature",
      featureId: registerCanonical,
      componentKey: registerEvse,
    });
    expect(await fusedOn(before.canonical_feature_id)).toEqual([]);
    expect((await fusedOn(survivor.canonical_feature_id)).length).toBe(10);

    // Writing the site again does not bring the link back.
    await writeSnapshot(
      sql,
      "de-bw-ocpdb",
      {
        features: [...charging, live, register].map((s) =>
          s.feature["id"] === REGISTER
            ? { ...s.feature, freshness: { fetchedAt: NOW } }
            : s.feature,
        ),
        observations: [],
      },
      { ...ctx, complete: false },
    );
    const [again] =
      await sql`SELECT status FROM conditions.feature_link WHERE a_id = ${LIVE} AND b_id = ${REGISTER}`;
    expect(again).toMatchObject({ status: "rejected" });
  });

  it("shows a fresh report over a stale feed, and drops it from the fused row once it lapses", async () => {
    const survivor = await canonicalOf(LIVE);
    await polled(sql, "de-bw-ocpdb", "2026-10-01T05:00:00.000Z");
    const id = await report(survivorEvse, "nonce-survivor-0002", "2026-10-01T06:59:00.000Z");
    const shown = async () =>
      (await fusedOn(survivor.canonical_feature_id)).find(
        (r) => r.component_key === survivorEvse && r.property === "charging.evse_status",
      )!;
    expect((await shown()).fused_from).toEqual([id]);

    const lapse = "2026-10-01T23:00:00.000Z";
    const counts = await sweepRecords(sql, {
      registry,
      instanceId: INSTANCE,
      now: lapse,
      maxAgeSec: 10 * 86400,
      historyDays: 90,
    });
    // This report and the register's, which moved with its charge point.
    expect(counts.crowdExpired).toBe(2);
    const [row] = await sql`
      SELECT evidence_state FROM conditions.observation_latest WHERE crowd_record_id = ${id}`;
    expect(row).toMatchObject({ evidence_state: "expired" });
    expect((await shown()).fused_from).not.toContain(id);
  });
});

describe("federation of the canonical view", () => {
  it("journals a feed's reading for a subscriber, never a crowd reading or a fused row", async () => {
    await sql`
      INSERT INTO conditions.federation_subscription
        (id, peer_id, delivery_mode, filter, created_at, updated_at)
      VALUES ('sub-status', 'peer-status', 'pull',
        ${sql.json({ classes: ["observation"], properties: ["charging.evse_status"] })}, now(), now())`;
    const later = "2026-10-02T07:00:00.000Z";
    const status = live.statuses[0]!;
    await writeSnapshot(
      sql,
      "de-bw-ocpdb",
      {
        observations: [
          { ...status, phenomenonTime: { instant: later }, freshness: { fetchedAt: later } },
        ].map((d) => {
          const { id: _id, ...rest } = d;
          return { ...rest, id: observationIdOf(rest) };
        }),
      },
      { ...ctx, now: later, complete: false },
    );
    const journal = await sql<{ snapshot: Rec }[]>`
      SELECT snapshot FROM conditions.federation_outbox WHERE record_class = 'observation'`;
    const sources = journal.map((j) => (j.snapshot["provenance"] as Rec)["sourceId"]);
    expect(sources).toEqual(["de-bw-ocpdb"]);

    await sql`
      UPDATE conditions.observation_latest SET reading = jsonb_set(reading, '{freshness,fetchedAt}', to_jsonb(${later}::text))
       WHERE source_id IN ('crowd', '@fused')`;
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.federation_outbox WHERE record_class = 'observation'`;
    expect(n).toBe(1);
  });
});
