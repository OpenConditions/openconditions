import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type ReporterKey,
  type SignedReport,
  type SubClaimType,
  signReport,
  signSubClaim,
} from "@openconditions/contrib-core";
import { buildRegistry, crowdLocalId, observationId } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
  writeSnapshot,
} from "@openconditions/storage";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReportingGrant } from "../attester/grant.js";
import { sweepCrossValidateObservations } from "../evidence/crossValidateSweep.js";
import { build } from "../server.js";
import { createTestDatabase, enrolledKey, INSTANCE } from "./crowd-fixtures.integration.js";

type Rec = Record<string, unknown>;

/**
 * Crowd readings through the service against the tables: the crowd fit
 * fixtures' charge points (MobiData BW's charge-point database, CC BY 4.0) and
 * fuel prices (MINETUR, CC BY 4.0), written as a feed would, then reported on
 * by signed claims through `POST /contrib/reports`.
 */
const registry = buildRegistry(productionModules);
const GRANT_SECRET_VALUE = "observation-claims-test-secret";
const GRANT_SECRET = new TextEncoder().encode(GRANT_SECRET_VALUE);
const ENV = {
  OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
  OPENCONDITIONS_INSTANCE_ID: INSTANCE,
};
const MODEL_TESTS = path.resolve(
  import.meta.dirname,
  "../../../../packages/model-registry/src/__tests__",
);
const json = (file: string) => JSON.parse(readFileSync(path.join(MODEL_TESTS, file), "utf8"));

interface OcpdbLocation {
  id: string;
  source: string;
  original_id: string;
  coordinates: { latitude: number; longitude: number };
  evses: { uid: string; evse_id?: string; status: string; last_updated: string }[];
}

const point = (lon: number, lat: number) => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  extent: "point",
  geometryOrigin: "source",
  fuzziness: "exact",
});

/** One OCPDB location as a charging site draft and its charge points' statuses. */
function chargingSite(loc: OcpdbLocation, fetchedAt: string) {
  const id = `oc:feature:de-bw-mobidata-charging:${loc.id}`;
  const provenance = {
    origin: "feed",
    sourceId: "de-bw-mobidata-charging",
    sourceFormat: "ocpi",
    accessMode: "bulk",
    recordId: loc.id,
    attribution: { provider: "MobiData BW", license: "CC-BY-4.0" },
    privacy: { class: "authoritative" },
  };
  const location = point(loc.coordinates.longitude, loc.coordinates.latitude);
  const feature: Rec = {
    id,
    class: "feature",
    kind: "charging_site",
    temporality: "static",
    lifecycle: "operational",
    location,
    externalIds: [
      { scheme: "provider", id: loc.id, authority: `de-bw-mobidata-charging/${loc.source}` },
    ],
    provenance,
    freshness: { fetchedAt },
    components: loc.evses.map((evse) => ({
      key: evse.uid,
      kind: "evse",
      details: { kind: "evse", v: 1, uid: evse.uid },
    })),
    details: { kind: "charging_site", v: 1 },
  };
  // A register's `STATIC` row has no live state: no reading. A live state is
  // read as of the fetch, as the charging parser reads it: the feed states it
  // again on every poll, so its own change time is not the reading's.
  const statuses = loc.evses.flatMap((evse) => {
    if (evse.status === "STATIC") return [];
    const draft: Rec = {
      class: "observation",
      kind: "observation",
      property: "charging.evse_status",
      temporality: "live",
      location,
      provenance,
      freshness: { fetchedAt },
      subject: { kind: "feature", featureId: id, componentKey: evse.uid },
      result: {
        type: "category",
        value: registry.crosswalk.value("evse_status", "ocpi", evse.status) ?? "unknown",
        vocabulary: "evse_status",
      },
      phenomenonTime: { instant: fetchedAt },
      aggregation: "instantaneous",
    };
    return [{ id: observationId("de-bw-mobidata-charging", draft as never), ...draft }];
  });
  return { feature, statuses };
}

/** The draft a sealed golden record was made from. */
function draftOf(sealed: Rec): Rec {
  const {
    canonicalId: _c,
    domain: _d,
    revision: _r,
    recordedAt: _t,
    contentHash: _h,
    ...draft
  } = sealed;
  const { instanceId: _i, ...provenance } = draft["provenance"] as Rec;
  return { ...draft, provenance };
}

const clock = { now: "2026-10-01T07:00:00.000Z" };
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;

const lorenz = (
  json("fixtures/facilities/ocpdb-charging-karlsruhe.json").items as OcpdbLocation[]
).find((l) => l.id === "309444")!;
const [live, register] = (
  json("fixtures/crowd/ocpdb-luisenstrasse-2f.json").items as OcpdbLocation[]
).map((l) => chargingSite(l, "2026-10-01T06:40:00.000Z")) as [
  ReturnType<typeof chargingSite>,
  ReturnType<typeof chargingSite>,
];
const lorenzSite = chargingSite(lorenz, "2026-09-22T12:00:00.000Z");
const golden = (json("golden/facilities.json") as Rec[]).filter(
  (r) => (r["provenance"] as Rec)["sourceId"] === "es-minetur-fuel",
);

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  app = await build({ sql, registry, env: ENV, logger: false, now: () => clock.now });
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date("2026-09-22T00:00:00.000Z"),
  });
  await syncSources(
    sql,
    ["de-bw-mobidata-charging", "es-minetur-fuel"].map((id) => ({
      id,
      domain: "facilities",
      format: "test",
      product: "facilities",
      tier: id === "es-minetur-fuel" ? "authoritative" : "aggregator",
      country: "DE",
      operator: id,
      license: "CC-BY-4.0",
      attribution: id,
      restricted: false,
      cadenceSec: 300,
      freshnessWindowSec: 900,
    })),
  );
  const write = { registry, instanceId: INSTANCE, complete: true };
  const sites = [live, register, lorenzSite];
  let summary = await writeSnapshot(
    sql,
    "de-bw-mobidata-charging",
    { features: sites.map((s) => s.feature), observations: sites.flatMap((s) => s.statuses) },
    { ...write, now: "2026-09-22T12:00:00.000Z" },
  );
  expect(summary.rejected).toEqual([]);
  summary = await writeSnapshot(
    sql,
    "es-minetur-fuel",
    {
      features: golden.filter((r) => r["class"] === "feature").map(draftOf),
      observations: golden.filter((r) => r["class"] === "observation").map(draftOf),
    },
    { ...write, now: "2026-09-22T11:10:00.000Z" },
  );
  expect(summary.rejected).toEqual([]);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

let nonces = 0;
const nextNonce = () => `obs-nonce-${String(++nonces).padStart(8, "0")}`;

async function reporter(): Promise<{ key: ReporterKey; grant: string }> {
  const key = await enrolledKey(sql, clock.now);
  return { key, grant: await createReportingGrant(key.keyId, clock.now, GRANT_SECRET) };
}

async function post(report: SignedReport, grant: string) {
  return app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report, reportingGrant: grant },
  });
}

const claimOf = (over: Rec) =>
  ({
    claimClass: "observation",
    property: "charging.evse_status",
    result: { type: "category", value: "out_of_order", vocabulary: "evse_status" },
    geometry: { type: "Point", coordinates: [8.40478, 49.00062] },
    reportedAt: clock.now,
    nonce: nextNonce(),
    ...over,
  }) as never;

const crowdRow = async (id: string) => {
  const [row] = await sql<
    {
      feature_id: string;
      component_key: string;
      evidence_state: string | null;
      corroborations: number;
      expires_at: Date | null;
      record: Rec;
    }[]
  >`
    SELECT feature_id, component_key, evidence_state, corroborations, expires_at,
           conditions.observation_record(template, reading) AS record
      FROM conditions.observation_latest WHERE crowd_record_id = ${id}`;
  return row;
};

const evidence = (id: string) =>
  sql<{ evidence_kind: string; actor_key_id: string | null; details: Rec }[]>`
    SELECT evidence_kind, actor_key_id, details FROM conditions.report_evidence
     WHERE record_class = 'observation' AND record_id = ${id} ORDER BY id`;

const canonicalOf = async (featureId: string) => {
  const [row] = await sql<
    {
      canonical_feature_id: string;
      components: { key: string; members: { featureId: string; key: string }[] }[];
    }[]
  >`
    SELECT canonical_feature_id, components FROM conditions.feature_canonical WHERE ${featureId} = ANY(member_ids)`;
  return row!;
};

describe("a charge point two sources describe", () => {
  const charging = "262397002";
  const liveId = live.feature["id"] as string;

  it("lands a driver's report on the canonical charge point, with its evidence", async () => {
    clock.now = "2026-10-01T07:00:00.000Z";
    const { key, grant } = await reporter();
    const nonce = nextNonce();
    const report = await signReport(
      registry,
      claimOf({
        subject: { featureId: liveId, componentKey: charging },
        reportedAt: "2026-10-01T06:58:00.000Z",
        nonce,
      }),
      key,
    );
    const res = await post(report, grant);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { record: { class: string; id: string }; evidenceState: string };
    expect(body.record.class).toBe("observation");
    expect(body.evidenceState).toBe("self_reported");
    const canonical = await canonicalOf(liveId);
    const row = await crowdRow(body.record.id);
    expect(row).toMatchObject({
      feature_id: canonical.canonical_feature_id,
      component_key: charging,
    });
    expect((row!.record["freshness"] as Rec)["expiresAt"]).toBe(row!.expires_at!.toISOString());
    expect((row!.record["provenance"] as Rec)["reporter"]).toEqual({ keyId: key.keyId });
    const [ledger] = await evidence(body.record.id);
    expect(ledger).toMatchObject({
      evidence_kind: "report",
      actor_key_id: key.keyId,
      details: { reportedAt: "2026-10-01T06:58:00.000Z", localId: crowdLocalId(key.keyId, nonce) },
    });

    // A replay lands nothing new.
    const again = await post(report, grant);
    expect(again.json()).toEqual(body);
    expect(await evidence(body.record.id)).toHaveLength(1);
  }, 60_000);

  it("lands a report about the register's charge point on its canonical component", async () => {
    const { key, grant } = await reporter();
    const registerId = register.feature["id"] as string;
    const uid = (register.feature["components"] as { key: string }[])[0]!.key;
    const res = await post(
      await signReport(
        registry,
        claimOf({ subject: { featureId: registerId, componentKey: uid } }),
        key,
      ),
      grant,
    );
    expect(res.statusCode).toBe(200);
    const row = await crowdRow((res.json() as { record: { id: string } }).record.id);
    expect(row!.component_key).toBe(`de-bw-mobidata-charging/${uid}`);
  }, 60_000);

  it("refuses a report about a charge point neither source has", async () => {
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({ subject: { featureId: liveId, componentKey: "no-such-point" } }),
        key,
      ),
      grant,
    );
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ issues: [{ code: "unknown_subject" }] });
  }, 60_000);

  it("takes the same reading from a second driver as a confirmation, and refuses a different one", async () => {
    const at = "2026-10-01T06:59:00.000Z";
    const first = await reporter();
    const second = await reporter();
    const third = await reporter();
    const subject = { featureId: liveId, componentKey: "262397007" };
    const a = await post(
      await signReport(registry, claimOf({ subject, reportedAt: at }), first.key),
      first.grant,
    );
    const id = (a.json() as { record: { id: string } }).record.id;
    const b = await post(
      await signReport(registry, claimOf({ subject, reportedAt: at }), second.key),
      second.grant,
    );
    expect(b.statusCode).toBe(200);
    expect((b.json() as { record: { id: string } }).record.id).toBe(id);
    expect((await evidence(id)).map((e) => [e.evidence_kind, e.actor_key_id])).toEqual([
      ["report", first.key.keyId],
      ["confirm", second.key.keyId],
    ]);
    expect((await crowdRow(id))!.corroborations).toBe(1);
    const c = await post(
      await signReport(
        registry,
        claimOf({
          subject,
          reportedAt: at,
          result: { type: "category", value: "available", vocabulary: "evse_status" },
        }),
        third.key,
      ),
      third.grant,
    );
    expect(c.statusCode).toBe(409);
    expect(c.json()).toMatchObject({ reason: "conflicting_report" });
  }, 60_000);

  it("shows the report in the fused row once the feed has gone stale", async () => {
    const canonical = await canonicalOf(liveId);
    const fused = async () => {
      const [row] = await sql<{ fused_from: string[] }[]>`
        SELECT fused_from FROM conditions.observation_latest
         WHERE source_id = '@fused' AND feature_id = ${canonical.canonical_feature_id}
           AND component_key = ${charging} AND property = 'charging.evse_status'`;
      return row!.fused_from;
    };
    const feedStatus = live.statuses.find(
      (s) => ((s as Rec)["subject"] as Rec)["componentKey"] === charging,
    )! as Rec;
    expect(await fused()).toEqual([feedStatus["id"]]);
    await sql`
      INSERT INTO conditions.source_status (source, last_success_at, freshness_window_sec)
      VALUES ('de-bw-mobidata-charging', '2026-10-01T05:00:00Z', 900)`;
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({
          subject: { featureId: liveId, componentKey: charging },
          reportedAt: "2026-10-01T06:59:30.000Z",
        }),
        key,
      ),
      grant,
    );
    expect(await fused()).toEqual([(res.json() as { record: { id: string } }).record.id]);
  }, 60_000);

  it("takes votes on a crowd reading, recomputing its evidence", async () => {
    const author = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({ subject: { featureId: liveId, componentKey: "262397003" } }),
        author.key,
      ),
      author.grant,
    );
    const id = (res.json() as { record: { id: string } }).record.id;
    const voter = await reporter();
    const vote = async (action: SubClaimType) =>
      app.inject({
        method: "POST",
        url: `/contrib/reports/observation/${encodeURIComponent(id)}/${action}`,
        payload: {
          subClaim: await signSubClaim(
            {
              subject: { class: "observation", id },
              claimType: action,
              reportedAt: clock.now,
              nonce: nextNonce(),
            },
            voter.key,
          ),
          reportingGrant: voter.grant,
        },
      });
    const confirmed = await vote("confirm");
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      record: { class: "observation", id },
      action: "confirm",
    });
    expect((await crowdRow(id))!.corroborations).toBe(1);
    expect((await vote("flag")).json()).toEqual({ flagged: true });
    const reviewer = await app.inject({
      method: "POST",
      url: `/contrib/reviewer/observation/${encodeURIComponent(id)}/accept`,
    });
    expect([401, 422]).toContain(reviewer.statusCode);
  }, 60_000);
});

describe("a charge point the operator reports out of order", () => {
  const subject = {
    featureId: lorenzSite.feature["id"] as string,
    componentKey: lorenz.evses[0]!.uid,
  };
  const here = {
    type: "Point",
    coordinates: [lorenz.coordinates.longitude, lorenz.coordinates.latitude],
  };

  it("resolves a driver who says the same, and trains the driver", async () => {
    clock.now = "2026-09-22T12:31:00.000Z";
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({ subject, geometry: here, reportedAt: "2026-09-22T12:30:00.000Z" }),
        key,
      ),
      grant,
    );
    expect(res.statusCode).toBe(200);
    const id = (res.json() as { record: { id: string } }).record.id;
    expect((await crowdRow(id))!.evidence_state).toBe("externally_resolved");
    const official = (await evidence(id)).find((e) => e.evidence_kind === "official_match")!;
    expect(official.details).toMatchObject({
      source: "official",
      matchedRecord: { class: "observation", id: lorenzSite.statuses[0]!["id"] },
    });
    const [reputation] = await sql<{ reputation_alpha: number }[]>`
      SELECT reputation_alpha FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    expect(reputation!.reputation_alpha).toBeGreaterThan(2);
  }, 60_000);

  it("does not resolve a driver who says it works", async () => {
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({
          subject: { ...subject, componentKey: lorenz.evses[1]!.uid },
          geometry: here,
          reportedAt: "2026-09-22T12:30:30.000Z",
          result: { type: "category", value: "available", vocabulary: "evse_status" },
        }),
        key,
      ),
      grant,
    );
    expect(res.statusCode).toBe(200);
    const id = (res.json() as { record: { id: string } }).record.id;
    expect((await crowdRow(id))!.evidence_state).toBe("self_reported");
    const swept = await sweepCrossValidateObservations(sql, registry, clock.now);
    expect(swept.routed).toBe(0);

    // The operator repairs it a few minutes later: the sweep resolves the driver then.
    const repaired = lorenzSite.statuses[1]!;
    const { id: _old, ...draft } = {
      ...repaired,
      result: { type: "category", value: "available", vocabulary: "evse_status" },
      phenomenonTime: { instant: "2026-09-22T12:40:00.000Z" },
      freshness: { fetchedAt: "2026-09-22T12:41:00.000Z" },
    };
    const summary = await writeSnapshot(
      sql,
      "de-bw-mobidata-charging",
      {
        observations: [{ ...draft, id: observationId("de-bw-mobidata-charging", draft as never) }],
      },
      { registry, instanceId: INSTANCE, now: "2026-09-22T12:41:00.000Z", complete: false },
    );
    expect(summary.observations.latest).toBe(1);
    clock.now = "2026-09-22T12:42:00.000Z";
    const later = await sweepCrossValidateObservations(sql, registry, clock.now);
    expect(later.routed).toBe(1);
    expect((await crowdRow(id))!.evidence_state).toBe("externally_resolved");
  }, 60_000);

  it("does not resolve a driver against a feed that stopped polling hours ago", async () => {
    const [status] = await sql<{ last_success_at: Date }[]>`
      SELECT last_success_at FROM conditions.source_status
       WHERE source = 'de-bw-mobidata-charging'`;
    await sql`UPDATE conditions.source_status SET last_success_at = '2026-09-22T10:00:00Z'
      WHERE source = 'de-bw-mobidata-charging'`;
    try {
      clock.now = "2026-09-22T12:51:00.000Z";
      const { key, grant } = await reporter();
      const res = await post(
        await signReport(
          registry,
          claimOf({ subject, geometry: here, reportedAt: "2026-09-22T12:50:00.000Z" }),
          key,
        ),
        grant,
      );
      expect(res.statusCode).toBe(200);
      const id = (res.json() as { record: { id: string } }).record.id;
      // The feed's out-of-order state held until half an hour after its last poll.
      expect((await crowdRow(id))!.evidence_state).toBe("self_reported");
    } finally {
      await sql`UPDATE conditions.source_status SET last_success_at = ${status!.last_success_at}
        WHERE source = 'de-bw-mobidata-charging'`;
    }
  }, 60_000);
});

describe("a fuel price a driver reads off the pole", () => {
  const station = golden.find((r) => r["id"] === "oc:feature:es-minetur-fuel:3119")!;
  const price = golden.find(
    (r) =>
      r["class"] === "observation" &&
      (r["subject"] as Rec)["componentKey"] === "e5" &&
      (r["subject"] as Rec)["featureId"] === station["id"],
  )!;
  const published = Number((price["result"] as { amount: string }).amount);
  const at = (station["location"] as { geometry: unknown }).geometry;
  const report = async (delta: number, reportedAt: string) => {
    clock.now = "2026-09-22T12:01:00.000Z";
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({
          property: "fuel.price",
          subject: { featureId: station["id"], componentKey: "e5" },
          result: {
            type: "money",
            amount: (published + delta).toFixed(3),
            currency: "EUR",
            per: "L",
          },
          geometry: at,
          reportedAt,
        }),
        key,
      ),
      grant,
    );
    expect(res.statusCode).toBe(200);
    return crowdRow((res.json() as { record: { id: string } }).record.id);
  };

  it("agrees with the ministry's price within a cent", async () => {
    expect((await report(0.009, "2026-09-22T12:00:00.000Z"))!.evidence_state).toBe(
      "externally_resolved",
    );
  }, 60_000);

  it("does not agree two cents off", async () => {
    expect((await report(0.02, "2026-09-22T12:00:30.000Z"))!.evidence_state).toBe("self_reported");
  }, 60_000);

  it("refuses a price for a place no feed publishes one for", async () => {
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({
          property: "fuel.price",
          subject: { location: point(-3.5, 40.5) },
          result: { type: "money", amount: "1.500", currency: "EUR", per: "L" },
          geometry: { type: "Point", coordinates: [-3.5, 40.5] },
        }),
        key,
      ),
      grant,
    );
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ issues: [{ code: "unknown_subject" }] });
  }, 60_000);
});

describe("a regional price a driver reports", () => {
  const region = point(-3.7, 40.4);
  it("lands only beside a feed's series for that place, at the series' location", async () => {
    clock.now = "2026-09-22T12:01:00.000Z";
    const average: Rec = {
      class: "observation",
      kind: "observation",
      property: "fuel.price",
      temporality: "live",
      subject: { kind: "location" },
      qualifiers: { product: "e5" },
      location: { ...region, admin: { country: "ES" } },
      provenance: {
        origin: "feed",
        sourceId: "es-minetur-fuel",
        sourceFormat: "minetur",
        accessMode: "bulk",
        recordId: "avg-e5",
        attribution: { provider: "MINETUR", license: "CC-BY-4.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: "2026-09-22T11:10:00.000Z" },
      result: { type: "money", amount: "1.700", currency: "EUR", per: "L" },
      phenomenonTime: { instant: "2026-09-22T11:00:00.000Z" },
      aggregation: "mean",
    };
    average["id"] = observationId("es-minetur-fuel", average as never);
    const summary = await writeSnapshot(
      sql,
      "es-minetur-fuel",
      { observations: [average] },
      { registry, instanceId: INSTANCE, now: "2026-09-22T11:10:00.000Z", complete: false },
    );
    expect(summary.rejected).toEqual([]);
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({
          property: "fuel.price",
          qualifiers: { product: "e5" },
          subject: {
            location: { ...region, geometryOrigin: "crowd_device", fuzziness: "low_res" },
          },
          result: { type: "money", amount: "1.705", currency: "EUR", per: "L" },
          geometry: region.geometry,
        }),
        key,
      ),
      grant,
    );
    expect(res.statusCode).toBe(200);
    const row = await crowdRow((res.json() as { record: { id: string } }).record.id);
    expect(row!.record["location"]).toEqual(average["location"]);
  }, 60_000);
});

/**
 * A mirror whose terms restrict it: its twin of the ministry's station
 * survives their cluster (its id sorts first), and a station only it knows.
 * The public scope serves crowd readings, so none may sit where only the
 * mirror puts a station.
 */
describe("a crowd reading never takes a restricted source's location", () => {
  const MIRROR = "es-fuel-mirror";
  const station = draftOf(golden.find((r) => r["id"] === "oc:feature:es-minetur-fuel:3119")!);
  const stationLocation = station["location"] as { geometry: { coordinates: number[] } };
  const [lon, lat] = stationLocation.geometry.coordinates as [number, number];
  const mirrored = (local: string, at: [number, number]): Rec => ({
    ...station,
    id: `oc:feature:${MIRROR}:${local}`,
    location: { ...stationLocation, geometry: { type: "Point", coordinates: at } },
    provenance: {
      ...(station["provenance"] as Rec),
      sourceId: MIRROR,
      recordId: local,
      attribution: { provider: MIRROR, license: "CC-BY-4.0" },
    },
  });
  const twin = mirrored("3119", [lon + 0.0002, lat]);
  const lone: Rec = {
    ...mirrored("lone", [-3.6, 40.45]),
    name: [{ lang: "es", text: "Gasolinera del espejo" }],
    externalIds: [{ scheme: "provider", id: "lone", authority: MIRROR }],
  };
  /** The mirror's E5 price at the station only it knows: what the crowd reports there. */
  const lonePrice = (() => {
    const e5 = draftOf(
      golden.find(
        (r) =>
          r["class"] === "observation" &&
          (r["subject"] as Rec)["componentKey"] === "e5" &&
          (r["subject"] as Rec)["featureId"] === "oc:feature:es-minetur-fuel:3119",
      )!,
    );
    const draft: Rec = {
      ...e5,
      subject: { kind: "feature", featureId: lone["id"], componentKey: "e5" },
      location: lone["location"],
      provenance: lone["provenance"],
      result: { type: "money", amount: "1.650", currency: "EUR", per: "L" },
    };
    delete draft["id"];
    return { ...draft, id: observationId(MIRROR, draft as never) };
  })();
  const region = point(-3.65, 40.42);

  const reportPrice = async (
    subject: Rec,
    geometry: unknown,
    qualifiers?: Rec,
    reportedAt = "2026-09-22T12:01:00.000Z",
  ) => {
    clock.now = "2026-09-22T12:01:00.000Z";
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({
          property: "fuel.price",
          subject,
          ...(qualifiers === undefined ? {} : { qualifiers }),
          result: { type: "money", amount: "1.650", currency: "EUR", per: "L" },
          geometry,
          reportedAt,
        }),
        key,
      ),
      grant,
    );
    expect(res.statusCode, res.body).toBe(200);
    return crowdRow((res.json() as { record: { id: string } }).record.id);
  };

  const average = (sourceId: string, amount: string, observedAt: string): Rec => {
    const draft: Rec = {
      class: "observation",
      kind: "observation",
      property: "fuel.price",
      temporality: "live",
      subject: { kind: "location" },
      qualifiers: { product: "e10" },
      location: { ...region, admin: { country: "ES", subdivision: sourceId } },
      provenance: {
        origin: "feed",
        sourceId,
        sourceFormat: "minetur",
        accessMode: "bulk",
        recordId: "avg-e10",
        attribution: { provider: sourceId, license: "CC-BY-4.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: "2026-09-22T11:10:00.000Z" },
      result: { type: "money", amount, currency: "EUR", per: "L" },
      phenomenonTime: { instant: observedAt },
      aggregation: "mean",
    };
    return { ...draft, id: observationId(sourceId, draft as never) };
  };
  /** The mirror's average for a province, keyed by its geocode rather than its geometry. */
  const province = {
    ...point(-3.5, 40.3),
    admin: { country: "ES", geocodes: [{ scheme: "iso3166-2", code: "ES-M" }] },
  };
  const provinceAverage = (() => {
    const { id: _id, ...draft } = average(MIRROR, "1.630", "2026-09-22T11:05:00.000Z");
    const placed: Rec = {
      ...draft,
      location: province,
      provenance: { ...(draft["provenance"] as Rec), recordId: "avg-e10-es-m" },
    };
    return { ...placed, id: observationId(MIRROR, placed as never) };
  })();

  const refusal = async (subject: Rec, geometry: unknown, qualifiers?: Rec) => {
    clock.now = "2026-09-22T12:01:00.000Z";
    const { key, grant } = await reporter();
    const res = await post(
      await signReport(
        registry,
        claimOf({
          property: "fuel.price",
          subject,
          ...(qualifiers === undefined ? {} : { qualifiers }),
          result: { type: "money", amount: "1.650", currency: "EUR", per: "L" },
          geometry,
          reportedAt: "2026-09-22T12:01:00.000Z",
        }),
        key,
      ),
      grant,
    );
    return res;
  };

  beforeAll(async () => {
    await syncSources(
      sql,
      ["de-bw-mobidata-charging", "es-minetur-fuel", MIRROR].map((id) => ({
        id,
        domain: "facilities",
        format: "test",
        product: "facilities",
        tier: id === "de-bw-mobidata-charging" ? "aggregator" : "authoritative",
        country: "ES",
        operator: id,
        license: "CC-BY-4.0",
        attribution: id,
        restricted: id === MIRROR,
        cadenceSec: 300,
        freshnessWindowSec: 900,
      })),
    );
    const summary = await writeSnapshot(
      sql,
      MIRROR,
      {
        features: [twin, lone],
        // The mirror's regional average is newer than the ministry's.
        observations: [
          average(MIRROR, "1.640", "2026-09-22T11:05:00.000Z"),
          provinceAverage,
          lonePrice,
        ],
      },
      { registry, instanceId: INSTANCE, now: "2026-09-22T11:10:00.000Z", complete: true },
    );
    expect(summary.rejected).toEqual([]);
  }, 60_000);

  it("lands a feature report at the cluster's public member, not the restricted survivor", async () => {
    const [cluster] = await sql<{ survivor_id: string }[]>`
      SELECT survivor_id FROM conditions.feature_canonical
       WHERE ${twin["id"] as string} = ANY(member_ids)`;
    expect(cluster!.survivor_id).toBe(twin["id"]);
    const row = await reportPrice(
      { featureId: twin["id"], componentKey: "e5" },
      stationLocation.geometry,
    );
    expect((row!.record["location"] as Rec)["geometry"]).toEqual(stationLocation.geometry);
  }, 60_000);

  it("refuses a feature report from beyond reach of a station only a restricted source has", async () => {
    // Five kilometres north of the mirror's lone station.
    const res = await refusal(
      { featureId: lone["id"], componentKey: "e5" },
      { type: "Point", coordinates: [-3.6, 40.495] },
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ issues: [{ code: "out_of_reach" }] });
  }, 60_000);

  it("lands a feature report a restricted source alone has at the reporter's coarse cell", async () => {
    const stood = { type: "Point", coordinates: [-3.6001, 40.45] };
    const row = await reportPrice({ featureId: lone["id"], componentKey: "e5" }, stood);
    const location = row!.record["location"] as Rec;
    expect(location).toMatchObject({ geometryOrigin: "crowd_device", fuzziness: "low_res" });
    // The centre of the kilometre cell the reporter stood in, not the device's point.
    const step = 1000 / 111_320;
    const centre = (v: number) => (Math.floor(v / step) + 0.5) * step;
    const [x, y] = (location["geometry"] as { coordinates: [number, number] }).coordinates;
    expect(location["geometry"]).not.toEqual(stood);
    expect(x).toBeCloseTo(centre(-3.6001), 9);
    expect(y).toBeCloseTo(centre(40.45), 9);
    // The mirror's equal price does not vouch for it: that would publish what it holds.
    expect(row!.evidence_state).toBe("self_reported");
  }, 60_000);

  it("refuses a place report from beyond reach of a series only a restricted source has", async () => {
    // The reporter names the province by its geocode, placed where they stand,
    // five kilometres north of where the mirror's series is.
    const stood = { type: "Point", coordinates: [-3.5, 40.345] };
    const res = await refusal(
      {
        location: {
          geometry: stood,
          extent: "point",
          geometryOrigin: "crowd_device",
          fuzziness: "low_res",
          admin: province.admin,
        },
      },
      stood,
      { product: "e10" },
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ issues: [{ code: "out_of_reach" }] });
  }, 60_000);

  it("lands a geocode-keyed place only restricted sources publish at its coarse cell, keyed as theirs", async () => {
    // The reporter names the province by its geocode, placed where they stand,
    // within reach of the mirror's series.
    const stood = { type: "Point", coordinates: [-3.5003, 40.3002] };
    const row = await reportPrice(
      {
        location: {
          geometry: stood,
          extent: "point",
          geometryOrigin: "crowd_device",
          fuzziness: "exact",
          admin: province.admin,
        },
      },
      stood,
      { product: "e10" },
    );
    const location = row!.record["location"] as Rec;
    expect(location["geometry"]).not.toEqual(stood);
    expect(location).toMatchObject({ fuzziness: "low_res", admin: province.admin });
    const step = 1000 / 111_320;
    const centre = (v: number) => (Math.floor(v / step) + 0.5) * step;
    const [x, y] = (location["geometry"] as { coordinates: [number, number] }).coordinates;
    expect(x).toBeCloseTo(centre(-3.5003), 9);
    expect(y).toBeCloseTo(centre(40.3002), 9);
    const keys = await sql<{ source_id: string; subject_key: string }[]>`
      SELECT source_id, subject_key FROM conditions.observation_latest
       WHERE subject_key = 'location:iso3166-2:ES-M' AND property = 'fuel.price'
         AND source_id IN ('crowd', ${MIRROR})`;
    expect(keys.map((k) => k.source_id).sort()).toEqual(["crowd", MIRROR].sort());
  }, 60_000);

  it("lands a place report at a public series' location, and else at the reporter's", async () => {
    const reported = { ...region, geometryOrigin: "crowd_device", fuzziness: "low_res" };
    const onlyRestricted = await reportPrice(
      { location: reported },
      region.geometry,
      { product: "e10" },
      "2026-09-22T12:00:45.000Z",
    );
    expect(onlyRestricted!.record["location"]).toEqual(reported);

    const summary = await writeSnapshot(
      sql,
      "es-minetur-fuel",
      { observations: [average("es-minetur-fuel", "1.660", "2026-09-22T11:00:00.000Z")] },
      { registry, instanceId: INSTANCE, now: "2026-09-22T11:10:00.000Z", complete: false },
    );
    expect(summary.rejected).toEqual([]);
    const withPublic = await reportPrice(
      { location: reported },
      region.geometry,
      { product: "e10" },
      "2026-09-22T12:01:00.000Z",
    );
    expect((withPublic!.record["location"] as Rec)["admin"]).toEqual({
      country: "ES",
      subdivision: "es-minetur-fuel",
    });
  }, 60_000);
});

describe("crowd readings and the federation", () => {
  it("never journals a crowd reading", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.federation_outbox
       WHERE record_class = 'observation' AND snapshot #>> '{provenance,sourceId}' = 'crowd'`;
    expect(n).toBe(0);
  });
});
