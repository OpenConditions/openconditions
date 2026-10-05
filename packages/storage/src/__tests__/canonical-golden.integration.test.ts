import { fusableProperties } from "@openconditions/core";
import { type CanonicalComponent, landClaim } from "@openconditions/model";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rekeyCrowdSeries } from "../canonical-view.js";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { sweepRecords } from "../sweep.js";
import { writeRecord } from "../write-record.js";
import { type WriteContext, writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";
import { goldenFacilities, polled, registry, seedSources } from "./facility-fixtures.js";

type Rec = Record<string, unknown>;

/**
 * The facilities golden records written per source through the writer, with
 * the canonical view and the fused rows kept by the write itself: every
 * feature gets one canonical row, every fusable reading a fused row on its
 * canonical subject, and two stations two sources describe fuse into one
 * value under the stricter of their rights.
 */
const NOW = "2026-09-22T12:00:00.000Z";
const INSTANCE = "test.local";
const ctx: WriteContext = { registry, instanceId: INSTANCE, now: NOW, complete: true };
const TIERS = {
  "de-bw-ocpdb": "aggregator",
  "de-bw-mobidata-parking": "aggregator",
  "nl-ndw-truck-parking": "authoritative",
  "de-autobahn-events": "operator",
  "es-minetur-fuel": "authoritative",
  "it-mimit": "authoritative",
  "at-econtrol-fuel": "authoritative",
  "es-fuel-test": "authoritative",
};
const golden = goldenFacilities();

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
  await seedSources(sql, TIERS);
  for (const sourceId of Object.keys(TIERS)) await polled(sql, sourceId, NOW);
  for (const [sourceId, drafts] of golden) {
    const summary = await writeSnapshot(sql, sourceId, drafts, ctx);
    expect(summary.rejected, sourceId).toEqual([]);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

const fusedRows = () =>
  sql<
    {
      feature_id: string;
      component_key: string | null;
      property: string;
      fused_from: string[];
      access_mode: string;
      expires_at: Date | null;
      record: Rec;
    }[]
  >`
    SELECT feature_id, component_key, property, fused_from, access_mode, expires_at,
           conditions.observation_record(template, reading) AS record
      FROM conditions.observation_latest WHERE source_id = '@fused'`;

const canonicalOf = async (featureId: string) => {
  const [row] = await sql<
    { canonical_feature_id: string; member_ids: string[]; components: Rec[] }[]
  >`
    SELECT canonical_feature_id, member_ids, components FROM conditions.feature_canonical
     WHERE ${featureId} = ANY(member_ids)`;
  return row;
};

describe("the canonical view of the golden facilities", () => {
  it("holds every feature in exactly one canonical row", async () => {
    const features = [...golden.values()].flatMap((d) => d.features.map((f) => f["id"] as string));
    const rows = await sql<
      { member_ids: string[] }[]
    >`SELECT member_ids FROM conditions.feature_canonical`;
    const members = rows.flatMap((r) => r.member_ids);
    expect(members.sort()).toEqual([...features].sort());
  });

  it("keeps the two Neuhaus rest areas on opposite carriageways apart", async () => {
    const links = await sql`
      SELECT status FROM conditions.feature_link
       WHERE a_id = 'oc:feature:de-autobahn-events:DE-SL-000008' AND b_id = 'oc:feature:de-autobahn-events:DE-SL-000009'`;
    expect(links.filter((l) => l["status"] === "accepted")).toEqual([]);
    const east = await canonicalOf("oc:feature:de-autobahn-events:DE-SL-000008");
    expect(east!.member_ids).toEqual(["oc:feature:de-autobahn-events:DE-SL-000008"]);
  });

  it("stores a lone station's components as its canonical components, keys kept", async () => {
    const station = await canonicalOf("oc:feature:es-minetur-fuel:15493");
    expect(station!.canonical_feature_id).toMatch(/^oc:feature:test\.local:[0-9a-f]{64}$/);
    expect(station!.components).toEqual([
      {
        key: "e5",
        kind: "fuel_product",
        members: [{ featureId: "oc:feature:es-minetur-fuel:15493", key: "e5" }],
      },
      {
        key: "diesel",
        kind: "fuel_product",
        members: [{ featureId: "oc:feature:es-minetur-fuel:15493", key: "diesel" }],
      },
    ]);
  });

  it("gives every fusable reading a fused row on its canonical subject, and history none", async () => {
    const fusable = fusableProperties(registry);
    const all = [...golden.values()].flatMap((d) => d.observations);
    expect(all.every((r) => fusable.has(r["property"] as string))).toBe(true);
    // A reading past its validity (a car park's count, half an hour on) is in effect no more.
    const inEffect = (r: Rec) =>
      r["validUntil"] === undefined || Date.parse(r["validUntil"] as string) > Date.parse(NOW);
    const readings = all.filter(inEffect);
    expect(readings.length).toBeLessThan(all.length);
    const rows = await fusedRows();
    expect(rows).toHaveLength(readings.length);
    for (const reading of readings) {
      const subject = reading["subject"] as { featureId: string; componentKey?: string };
      const canonical = await canonicalOf(subject.featureId);
      const row = rows.find(
        (r) =>
          r.feature_id === canonical!.canonical_feature_id &&
          r.component_key === (subject.componentKey ?? null) &&
          r.property === reading["property"],
      );
      expect(row?.fused_from, reading["id"] as string).toEqual([reading["id"]]);
      expect(row!.record["result"]).toEqual(reading["result"]);
      expect(row!.record["provenance"]).toMatchObject({ sourceId: "@fused", origin: "derived" });
    }
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.observation o
        JOIN conditions.observation_latest l USING (series_id) WHERE l.source_id = '@fused'`;
    expect(n).toBe(0);
  });

  it("keeps a fused value of an on-demand source on demand, expiring with it", async () => {
    const station = await canonicalOf("oc:feature:at-econtrol-fuel:34026");
    const [row] = (await fusedRows()).filter((r) => r.feature_id === station!.canonical_feature_id);
    expect(row!.access_mode).toBe("on_demand");
    const reading = golden
      .get("at-econtrol-fuel")!
      .observations.find(
        (o) => (o["subject"] as Rec)["featureId"] === "oc:feature:at-econtrol-fuel:34026",
      )!;
    expect(row!.expires_at?.toISOString()).toBe(
      new Date((reading["freshness"] as Rec)["expiresAt"] as string).toISOString(),
    );
  });

  it("does not federate a fused row", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.federation_outbox WHERE record_id LIKE 'oc:observation:test.local:%'`;
    expect(n).toBe(0);
  });
});

describe("a station two sources describe", () => {
  const minetur = golden.get("es-minetur-fuel")!;
  const station = minetur.features.find((f) => f["id"] === "oc:feature:es-minetur-fuel:3119")!;
  const e5 = minetur.observations.find(
    (o) =>
      (o["subject"] as Rec)["featureId"] === station["id"] &&
      (o["subject"] as Rec)["componentKey"] === "e5",
  )!;
  const RIGHTS = {
    source_redistribution: "yes",
    derived_redistribution: "no",
    commercial_use: "yes",
    retention: "yes",
    attribution_required: "yes",
    evidence_origin: null,
    evidence_version: null,
    reviewed_at: null,
  };
  const stationLocation = station["location"] as { geometry: { coordinates: number[] } };
  const twin = {
    ...station,
    id: "oc:feature:es-fuel-test:3119",
    // A couple of metres off: the mirror geocodes the station itself.
    location: {
      ...stationLocation,
      geometry: {
        ...stationLocation.geometry,
        coordinates: [
          stationLocation.geometry.coordinates[0]! + 0.00002,
          stationLocation.geometry.coordinates[1]!,
        ],
      },
    },
    provenance: {
      ...(station["provenance"] as Rec),
      sourceId: "es-fuel-test",
      attribution: { provider: "A second ministry mirror", license: "CC-BY-4.0", rights: RIGHTS },
    },
    components: [(station["components"] as Rec[]).find((c) => c["key"] === "e5")],
  };
  const twinPrice = (() => {
    const draft: Rec = {
      ...e5,
      subject: { kind: "feature", featureId: twin.id, componentKey: "e5" },
      provenance: twin.provenance,
    };
    delete draft["id"];
    return draft;
  })();

  beforeAll(async () => {
    const { observationId } = await import("@openconditions/model");
    twinPrice["id"] = observationId("es-fuel-test", twinPrice as never);
    const summary = await writeSnapshot(
      sql,
      "es-fuel-test",
      { features: [twin], observations: [twinPrice] },
      { ...ctx, now: "2026-09-22T12:05:00.000Z" },
    );
    expect(summary.rejected).toEqual([]);
  }, 60_000);

  it("links the two and keeps one canonical feature for them", async () => {
    const [link] = await sql`
      SELECT method, status FROM conditions.feature_link
       WHERE a_id = 'oc:feature:es-fuel-test:3119' AND b_id = 'oc:feature:es-minetur-fuel:3119'`;
    expect(link).toMatchObject({ status: "accepted" });
    const canonical = await canonicalOf(station["id"] as string);
    expect(canonical!.member_ids).toEqual([
      "oc:feature:es-fuel-test:3119",
      "oc:feature:es-minetur-fuel:3119",
    ]);
    expect(await canonicalOf(twin.id)).toEqual(canonical);
  });

  it("fuses the price both publish into one row, under the stricter of their rights", async () => {
    const canonical = await canonicalOf(station["id"] as string);
    const e5Key = (
      canonical!.components as { key: string; members: { featureId: string; key: string }[] }[]
    ).find((c) => c.members.some((m) => m.featureId === station["id"] && m.key === "e5"))!.key;
    const rows = (await fusedRows()).filter(
      (r) => r.feature_id === canonical!.canonical_feature_id,
    );
    const fused = rows.find((r) => r.component_key === e5Key && r.property === "fuel.price")!;
    expect([...fused.fused_from].sort()).toEqual([e5["id"], twinPrice["id"]].sort());
    expect((fused.record["provenance"] as Rec)["attribution"]).toMatchObject({
      rights: { derived_redistribution: "no", source_redistribution: "unknown" },
    });
    // The station's other products come from the ministry alone.
    expect(rows.filter((r) => r.fused_from.length === 1).length).toBe(rows.length - 1);
  });

  it("puts a fused row where the record whose value it shows puts the station", async () => {
    const canonical = await canonicalOf(station["id"] as string);
    const [{ survivor_id }] = await sql`
      SELECT survivor_id FROM conditions.feature_canonical
       WHERE canonical_feature_id = ${canonical!.canonical_feature_id}`;
    expect(survivor_id).toBe(twin.id);
    const ministryOnly = (await fusedRows()).filter(
      (r) => r.feature_id === canonical!.canonical_feature_id && r.fused_from.length === 1,
    );
    expect(ministryOnly.length).toBeGreaterThan(0);
    for (const row of ministryOnly) {
      expect(row.record["location"]).toEqual(station["location"]);
    }
  });

  it("drops the fused rows of the station's former lone canonical feature", async () => {
    const lone = await sql`
      SELECT 1 FROM conditions.observation_latest l
       WHERE l.source_id = '@fused' AND NOT EXISTS (
         SELECT 1 FROM conditions.feature_canonical c WHERE c.canonical_feature_id = l.feature_id)`;
    expect(lone).toEqual([]);
  });
});

describe("when an on-demand answer lapses", () => {
  it("drops the answer, its canonical row and the fused rows it fed", async () => {
    const station = "oc:feature:at-econtrol-fuel:34026";
    const canonical = await canonicalOf(station);
    const expiry = (golden.get("at-econtrol-fuel")!.features[0]!["freshness"] as Rec)["expiresAt"];
    const later = new Date(Date.parse(expiry as string) + 1000).toISOString();
    const counts = await sweepRecords(sql, {
      registry,
      instanceId: INSTANCE,
      now: later,
      maxAgeSec: 30 * 86400,
      historyDays: 90,
    });
    expect(counts.dropped).toBeGreaterThan(0);
    expect(await canonicalOf(station)).toBeUndefined();
    const fused = (await fusedRows()).filter(
      (r) => r.feature_id === canonical!.canonical_feature_id,
    );
    expect(fused).toEqual([]);
  });
});

describe("a national register's first poll", () => {
  it("links ten thousand stations by their neighbours, not by every pair", async () => {
    const template = golden
      .get("es-minetur-fuel")!
      .features.find((f) => f["id"] === "oc:feature:es-minetur-fuel:3119")!;
    const location = template["location"] as Rec;
    // A grid with ~1 km between stations: none is a candidate of another.
    const stations = Array.from({ length: 10_000 }, (_, i) => ({
      ...template,
      id: `oc:feature:es-fuel-grid:${i}`,
      externalIds: [{ scheme: "provider", id: `${i}`, authority: "es-fuel-grid" }],
      location: {
        ...location,
        geometry: {
          type: "Point",
          coordinates: [-4 + (i % 100) * 0.012, 40 + Math.floor(i / 100) * 0.009],
        },
      },
      provenance: {
        ...(template["provenance"] as Rec),
        sourceId: "es-fuel-grid",
        recordId: `${i}`,
      },
    }));
    const started = Date.now();
    const summary = await writeSnapshot(
      sql,
      "es-fuel-grid",
      { features: stations },
      { ...ctx, complete: false },
    );
    expect(summary.rejected).toEqual([]);
    // Comparing every pair took about 90 s alone (far longer under the full
    // suite's load); neighbours only, well under half that even under load.
    expect(Date.now() - started).toBeLessThan(60_000);
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM conditions.feature_link
       WHERE a_id LIKE 'oc:feature:es-fuel-grid:%' OR b_id LIKE 'oc:feature:es-fuel-grid:%'`;
    expect(n).toBe(0);
  }, 180_000);
});

describe("moving crowd rows", () => {
  it("waits for the crowd's lock, so a report landing meanwhile cannot miss the move", async () => {
    const holder = await sql.reserve();
    await holder`SELECT pg_advisory_lock(hashtext('crowd'))`;
    let moving: Promise<unknown> | undefined;
    try {
      moving = sql.begin((tx) =>
        rekeyCrowdSeries(
          tx,
          registry,
          [
            {
              canonicalFeatureId: "oc:feature:test.local:gone",
              survivorId: "a",
              memberIds: ["a"],
              components: [],
            },
          ],
          [],
          { instanceId: INSTANCE, now: NOW },
        ),
      );
      await expect
        .poll(
          async () =>
            (
              await sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                AND objid = (hashtext('crowd') & x'ffffffff'::bigint)::oid`
            ).length,
          { timeout: 3000 },
        )
        .toBe(1);
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtext('crowd'))`;
      holder.release();
      await moving;
    }
  });
});

describe("a crowd reading on a component whose canonical key changes", () => {
  const minetur = golden.get("es-minetur-fuel")!;
  const station = minetur.features.find((f) => f["id"] === "oc:feature:es-minetur-fuel:15493")!;
  const e5 = (station["components"] as Rec[]).find((c) => c["key"] === "e5")!;
  /** The station as a second mirror has it, its e5 at the given price level. */
  const mirror = (priceLevel: string): Rec => ({
    ...station,
    id: "oc:feature:es-fuel-test:15493",
    provenance: { ...(station["provenance"] as Rec), sourceId: "es-fuel-test" },
    components: [{ ...e5, details: { ...(e5["details"] as Rec), priceLevel } }],
  });
  const crowdRows = () =>
    sql<{ feature_id: string; component_key: string | null; record: Rec }[]>`
      SELECT feature_id, component_key, conditions.observation_record(template, reading) AS record
        FROM conditions.observation_latest
       WHERE source_id = 'crowd' AND feature_id = (
         SELECT canonical_feature_id FROM conditions.feature_canonical
          WHERE 'oc:feature:es-minetur-fuel:15493' = ANY(member_ids))`;

  it("follows the component when its member matches another and the canonical id stays", async () => {
    const at = "2026-09-22T12:10:00.000Z";
    await writeSnapshot(
      sql,
      "es-fuel-test",
      { features: [mirror("card")] },
      { ...ctx, now: at, complete: false },
    );
    const before = (await canonicalOf(station["id"] as string))!;
    expect(before.member_ids).toContain("oc:feature:es-fuel-test:15493");
    // The ministry's e5, which the mirror's survives over while the two differ.
    const holding = (components: unknown, featureId: string) =>
      (components as CanonicalComponent[]).find((c) =>
        c.members.some((m) => m.featureId === featureId && m.key === "e5"),
      )!.key;
    const reportedKey = holding(before.components, station["id"] as string);
    expect(reportedKey).not.toBe(holding(before.components, "oc:feature:es-fuel-test:15493"));

    const landed = landClaim(
      registry,
      {
        claim: {
          claimClass: "observation",
          subject: { featureId: before.canonical_feature_id, componentKey: reportedKey },
          property: "fuel.price",
          result: { type: "money", amount: "1.879", currency: "EUR", per: "L" },
          geometry: (station["location"] as Rec)["geometry"] as never,
          reportedAt: "2026-09-22T12:08:00.000Z",
          nonce: "nonce-mirror-e5-0001",
        },
        keyId: "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY",
      },
      {
        instanceId: INSTANCE,
        now: at,
        attribution: {
          provider: `OpenConditions contributors at ${INSTANCE}`,
          license: "ODbL-1.0",
        },
        resolveFeature: (featureId, key) =>
          featureId === before.canonical_feature_id && key === reportedKey
            ? { featureId, componentKey: key, location: station["location"] as never }
            : undefined,
      },
    );
    if (!landed.ok) throw new Error(JSON.stringify(landed.issues));
    const written = await writeRecord(
      sql,
      { draft: landed.draft },
      { registry, instanceId: INSTANCE, now: at },
    );
    expect(written.status).toBe("updated");
    expect((await crowdRows()).map((r) => r.component_key)).toEqual([reportedKey]);

    // The mirror's e5 now says what the ministry's says: one product, not two.
    await writeSnapshot(
      sql,
      "es-fuel-test",
      { features: [mirror("standard")] },
      { ...ctx, now: "2026-09-22T12:15:00.000Z", complete: false },
    );
    const after = (await canonicalOf(station["id"] as string))!;
    expect(after.canonical_feature_id).toBe(before.canonical_feature_id);
    expect(after.components.map((c) => c["key"])).not.toContain(reportedKey);
    const survivorKey = holding(after.components, station["id"] as string);

    const [row] = await crowdRows();
    expect(row).toMatchObject({
      feature_id: before.canonical_feature_id,
      component_key: survivorKey,
    });
    expect(row!.record["subject"]).toEqual({
      kind: "feature",
      featureId: before.canonical_feature_id,
      componentKey: survivorKey,
    });
  });
});
