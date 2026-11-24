import { readFileSync } from "node:fs";
import path from "node:path";
import { publicVerif } from "@cloudflare/privacypass-ts";
import {
  generateReporterKey,
  type ReporterKey,
  type SituationClaim,
  type SubClaimType,
  signReport,
  signSubClaim,
} from "@openconditions/contrib-core";
import {
  assertStoredCodesRegistered,
  runMigrations,
  waitForSchemaVersion,
} from "@openconditions/core/server";
import type { Registry } from "@openconditions/model";
import { observationId } from "@openconditions/model";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
  writeSnapshot,
} from "@openconditions/storage";
import {
  contributionsRoleUrl,
  createTestDatabase,
  type TestDatabase,
} from "@openconditions/test-database";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoCorroborateOnLanding } from "../evidence/autoCorroborate.js";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import { crossValidateObservation } from "../evidence/crossValidateObservation.js";
import {
  sweepCrossValidate,
  sweepCrossValidateObservations,
  sweepFederatedCrossValidate,
} from "../evidence/crossValidateSweep.js";
import { type PublicContext, redemptionContext, reportEpoch } from "../issuer/context.js";
import { DEFAULT_ISSUER_NAME } from "../issuer/keys.js";
import { flagOntoOpenFlagged } from "../reviewer/streetcomplete.js";
import { build } from "../server.js";
import {
  INSTANCE,
  registry,
  reportAs,
  seedFeedSituation,
  seedPeerCrowdReport,
  situationClaim,
} from "./crowd-fixtures.integration.js";

/**
 * The contributions service's flows, run as its own role holding only what
 * the custom migration grants it: boot, enrollment, tokens, crowd reports on
 * situations and readings, votes, the reviewer's decisions and block list,
 * and the cross-validation sweeps. A privilege the migration does not grant
 * fails the flow that needs it. Fixtures are written as the ingest service
 * writes them, by the schema's owner. The cases build on one another and run
 * in order.
 */

type Rec = Record<string, unknown>;
const { BlindRSAMode, Client, Origin, TokenResponse } = publicVerif;

const GRANT_SECRET_VALUE = "role-grants-test-grant-secret";
const REVIEWER_TOKEN = "role-grants-test-reviewer-token";
const ENV = {
  OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
  OPENCONDITIONS_REVIEWER_TOKEN: REVIEWER_TOKEN,
  OPENCONDITIONS_INSTANCE_ID: INSTANCE,
};
const MODEL_TESTS = path.resolve(
  import.meta.dirname,
  "../../../../packages/model-registry/src/__tests__",
);

interface OcpdbLocation {
  id: string;
  coordinates: { latitude: number; longitude: number };
  evses: { uid: string; status: string }[];
}

/** A charging site and its charge points' statuses, as the charging feed writes them. */
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
  const location = {
    geometry: { type: "Point", coordinates: [loc.coordinates.longitude, loc.coordinates.latitude] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  };
  const feature: Rec = {
    id,
    class: "feature",
    kind: "charging_site",
    temporality: "static",
    lifecycle: "operational",
    location,
    externalIds: [{ scheme: "provider", id: loc.id, authority: "de-bw-mobidata-charging/ocpdb" }],
    provenance,
    freshness: { fetchedAt },
    components: loc.evses.map((evse) => ({
      key: evse.uid,
      kind: "evse",
      details: { kind: "evse", v: 1, uid: evse.uid },
    })),
    details: { kind: "charging_site", v: 1 },
  };
  const statuses = loc.evses
    .filter((evse) => evse.status !== "STATIC")
    .map((evse) => {
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
      return { id: observationId("de-bw-mobidata-charging", draft as never), ...draft };
    });
  return { feature, statuses };
}

/** One site with live charge points, and a register's site of the same points without a state. */
const [site, register] = (
  JSON.parse(
    readFileSync(path.join(MODEL_TESTS, "fixtures/crowd/ocpdb-luisenstrasse-2f.json"), "utf8"),
  ).items as OcpdbLocation[]
).map((l) => chargingSite(l, "2026-10-01T06:40:00.000Z")) as [
  ReturnType<typeof chargingSite>,
  ReturnType<typeof chargingSite>,
];
const chargePoints = (site.feature["components"] as { key: string }[]).map((c) => c.key);

/** The ministry's fuel stations and prices (MINETUR, CC BY 4.0), as sealed golden records. */
const fuel = (
  JSON.parse(readFileSync(path.join(MODEL_TESTS, "golden/facilities.json"), "utf8")) as Rec[]
).filter((r) => (r["provenance"] as Rec)["sourceId"] === "es-minetur-fuel");
const station = fuel.find((r) => r["id"] === "oc:feature:es-minetur-fuel:3119")!;
const e5 = fuel.find(
  (r) =>
    r["class"] === "observation" &&
    (r["subject"] as Rec)["componentKey"] === "e5" &&
    (r["subject"] as Rec)["featureId"] === station["id"],
)!;

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

const clock = { now: "2026-07-12T08:00:00.000Z" };
let db: TestDatabase;
let contributions: postgres.Sql;
let app: FastifyInstance;
/** Errors of the landing hooks, which the routes log and swallow. */
const hookErrors: unknown[] = [];

/** The sweeps log a candidate that failed and go on; these are those lines. */
const sweepFailures: string[] = [];
const sweepLog = {
  log: (message: string) => {
    if (message.includes(" failed: ")) sweepFailures.push(message);
  },
};

/** A landing hook that records its error before the route swallows it. */
function surfaced<T>(
  hook: (sql: postgres.Sql, registry: Registry, id: string, now: string) => Promise<T>,
) {
  return async (sql: postgres.Sql, reg: Registry, id: string, now: string): Promise<T> => {
    try {
      return await hook(sql, reg, id, now);
    } catch (err) {
      hookErrors.push(err);
      throw err;
    }
  };
}

beforeAll(async () => {
  // The roles exist before the first migrate, as on an OpenMapX install.
  db = await createTestDatabase({ empty: true, pool: { max: 4 } });
  await runMigrations(db.url);
  const owner = db.sql;
  await syncSources(
    owner,
    ["de-autobahn-events", "de-bw-mobidata-charging", "es-minetur-fuel"].map((id) => ({
      id,
      domain: id === "de-autobahn-events" ? "traffic" : "facilities",
      format: "test",
      product: id === "de-autobahn-events" ? "events" : "facilities",
      tier: "authoritative",
      country: "DE",
      operator: id,
      license: "CC-BY-4.0",
      attribution: id,
      restricted: false,
      cadenceSec: 300,
      freshnessWindowSec: 900,
    })),
  );
  // A peer subscribed to every class, so the capture triggers journal.
  await owner`
    INSERT INTO conditions.federation_subscription (id, peer_id, created_at, updated_at)
    VALUES ('sub-1', 'peer.example.net', now(), now())`;
  await seedFeedSituation(owner, "feed-1");
  await seedPeerCrowdReport(owner, "peer-1", [8.7, 49.2]);
  await ensureObservationPartitions(owner, {
    classes: retentionClasses(registry),
    now: new Date("2026-09-22T00:00:00.000Z"),
  });
  const summary = await writeSnapshot(
    owner,
    "de-bw-mobidata-charging",
    {
      features: [site.feature, register.feature],
      observations: [...site.statuses, ...register.statuses],
    },
    { registry, instanceId: INSTANCE, complete: true, now: "2026-10-01T06:40:00.000Z" },
  );
  expect(summary.rejected).toEqual([]);
  const prices = await writeSnapshot(
    owner,
    "es-minetur-fuel",
    {
      features: fuel.filter((r) => r["class"] === "feature").map(draftOf),
      observations: fuel.filter((r) => r["class"] === "observation").map(draftOf),
    },
    { registry, instanceId: INSTANCE, complete: true, now: "2026-09-22T11:10:00.000Z" },
  );
  expect(prices.rejected).toEqual([]);

  // The service's boot, as main.ts runs it.
  contributions = postgres(contributionsRoleUrl(db), { max: 5, onnotice: () => {} });
  await waitForSchemaVersion(contributions, { timeoutMs: 5_000 });
  await assertStoredCodesRegistered(contributions, registry, { sourceFormats: false });
  app = await build({
    sql: contributions,
    registry,
    env: ENV,
    logger: false,
    now: () => clock.now,
    streetCompleteCheck: surfaced(flagOntoOpenFlagged),
    autoCorroborate: surfaced(autoCorroborateOnLanding),
    crossValidateAgainstFeeds: surfaced(crossValidateAgainstFeeds),
    crossValidateObservation: surfaced(crossValidateObservation),
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await contributions?.end();
  await db?.close();
}, 30_000);

let ips = 0;
let nonces = 0;
const nextNonce = () => `grant-nonce-${String(++nonces).padStart(8, "0")}`;

async function enroll(key: ReporterKey): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/contrib/enroll",
    payload: { pubJwk: key.publicJwk, proof: { keyId: key.keyId, accountAgeDays: 30 } },
    remoteAddress: `198.51.100.${++ips}`,
  });
  return (ok(res).json() as { reportingGrant: string }).reportingGrant;
}

/** Expects a 200 and shows the body otherwise, where a refused privilege surfaces as a 500. */
function ok<T extends { statusCode: number; body: string }>(res: T): T {
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

async function reporter(): Promise<{ key: ReporterKey; grant: string }> {
  const key = await generateReporterKey();
  return { key, grant: await enroll(key) };
}

async function report(
  who: { key: ReporterKey; grant: string },
  over: Partial<SituationClaim>,
): Promise<{ statusCode: number; body: string; id?: string }> {
  const signed = await reportAs(
    who.key,
    situationClaim({ reportedAt: clock.now, nonce: nextNonce(), ...over }),
  );
  const res = await app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report: signed, reportingGrant: who.grant },
  });
  return {
    statusCode: res.statusCode,
    body: res.body,
    id: res.statusCode === 200 ? (res.json() as { record: { id: string } }).record.id : undefined,
  };
}

async function vote(
  who: { key: ReporterKey; grant: string },
  recordClass: "situation" | "observation",
  id: string,
  action: SubClaimType,
) {
  const subClaim = await signSubClaim(
    {
      subject: { class: recordClass, id },
      claimType: action,
      reportedAt: clock.now,
      nonce: nextNonce(),
    },
    who.key,
  );
  return app.inject({
    method: "POST",
    url: `/contrib/reports/${recordClass}/${encodeURIComponent(id)}/${action}`,
    payload: { subClaim, reportingGrant: who.grant },
  });
}

function asReviewer(method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${REVIEWER_TOKEN}` },
    ...(payload === undefined ? {} : { payload: payload as Rec }),
  });
}

const point = (lon: number, lat: number): SituationClaim["geometry"] => ({
  type: "Point",
  coordinates: [lon, lat],
});

describe("the contributions service as its own role", () => {
  it("serves its issuer keys", async () => {
    const res = ok(await app.inject({ method: "GET", url: "/contrib/issuer-keys" }));
    expect((res.json() as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
  });

  it("enrolls a reporter, issues and redeems a token, and reports its standing", async () => {
    const { grant } = await reporter();
    const keys = await app.inject({ method: "GET", url: "/contrib/issuer-keys" });
    const [issuerKey] = (keys.json() as { keys: { publicKey: string }[] }).keys;
    const ctx: PublicContext = { purpose: "report", epoch: reportEpoch(clock.now) };
    const client = new Client(BlindRSAMode.PSS);
    const challenge = new Origin(BlindRSAMode.PSS).createTokenChallenge(
      DEFAULT_ISSUER_NAME,
      await redemptionContext(ctx),
    );
    const request = await client.createTokenRequest(
      challenge,
      new Uint8Array(Buffer.from(issuerKey!.publicKey, "base64url")),
    );
    const issued = ok(
      await app.inject({
        method: "POST",
        url: "/contrib/tokens",
        payload: {
          reportingGrant: grant,
          blindedRequest: Buffer.from(request.serialize()).toString("base64url"),
        },
      }),
    );
    const token = await client.finalize(
      TokenResponse.deserialize(
        new Uint8Array(Buffer.from((issued.json() as { token: string }).token, "base64url")),
      ),
    );
    expect(await app.tokenVerifier.verify(contributions, token.serialize(), ctx, clock.now)).toBe(
      true,
    );
    expect(await app.tokenVerifier.verify(contributions, token.serialize(), ctx, clock.now)).toBe(
      false,
    );
    ok(
      await app.inject({
        method: "GET",
        url: "/contrib/reporter/me",
        headers: { authorization: `Bearer ${grant}` },
      }),
    );
  }, 60_000);

  it("lands crowd situations, corroborates them and cross-validates one against a feed", async () => {
    // Where the feed's obstruction is: cross-validated against it.
    ok(await report(await reporter(), { geometry: point(8.4, 49) }));
    // Two independent reports of one phenomenon corroborate each other.
    ok(await report(await reporter(), { geometry: point(9.0, 44.0) }));
    ok(await report(await reporter(), { geometry: point(9.0, 44.0) }));
    // A report the landing refuses counts against its reporter's rate.
    const stale = await report(await reporter(), {
      geometry: point(9.5, 44.5),
      reportedAt: new Date(Date.parse(clock.now) - 36 * 3_600_000).toISOString(),
    });
    expect(stale.statusCode, stale.body).toBe(422);
    // A report of closed lanes carries its effect.
    ok(
      await report(await reporter(), {
        geometry: point(12.0, 47.0),
        effects: [
          {
            id: "lanes",
            kind: "lane_restriction",
            v: 1,
            vehicleImpact: "some_lanes_closed",
            applicability: { kind: "all" },
            compliance: "mandatory",
            normalization: "complete",
          },
        ],
      } as Partial<SituationClaim>),
    );
    expect(hookErrors).toEqual([]);
    const [journalled] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.federation_outbox WHERE record_class = 'situation'`;
    expect(journalled!.n).toBeGreaterThan(0);
  }, 60_000);

  it("takes votes on a situation, and the reviewer's decisions on flagged ones", async () => {
    const id = ok(await report(await reporter(), { geometry: point(10.0, 45.0) })).id!;
    ok(await vote(await reporter(), "situation", id, "confirm"));
    ok(await vote(await reporter(), "situation", id, "negate"));
    ok(await vote(await reporter(), "situation", id, "flag"));
    // A report landing onto the open-flagged phenomenon is flagged too.
    ok(await report(await reporter(), { geometry: point(10.0, 45.0) }));
    const queue = ok(await asReviewer("GET", "/contrib/reviewer/flagged"));
    expect(queue.body).toContain(id);
    ok(await asReviewer("POST", `/contrib/reviewer/situation/${encodeURIComponent(id)}/accept`));

    const rejectedId = ok(await report(await reporter(), { geometry: point(11.0, 46.0) })).id!;
    ok(await vote(await reporter(), "situation", rejectedId, "flag"));
    const rejected = ok(
      await asReviewer(
        "POST",
        `/contrib/reviewer/situation/${encodeURIComponent(rejectedId)}/reject`,
      ),
    );
    expect((rejected.json() as { tombstoned: boolean }).tombstoned).toBe(true);
    expect(hookErrors).toEqual([]);
  }, 60_000);

  it("blocks and unblocks a reporter", async () => {
    const { key } = await reporter();
    ok(await asReviewer("POST", "/contrib/reviewer/blocklist", { keyId: key.keyId, reason: "x" }));
    // Blocking again replaces the reason.
    ok(await asReviewer("POST", "/contrib/reviewer/blocklist", { keyId: key.keyId, reason: "y" }));
    expect(ok(await asReviewer("GET", "/contrib/reviewer/blocklist")).body).toContain(key.keyId);
    ok(await asReviewer("DELETE", `/contrib/reviewer/blocklist/${key.keyId}`));
  });

  it("lands crowd fuel prices and checks one against a later feed price", async () => {
    clock.now = "2026-09-22T12:01:00.000Z";
    const published = Number((e5["result"] as { amount: string }).amount);
    const price = async (delta: number, reportedAt: string) => {
      const who = await reporter();
      const claim = {
        claimClass: "observation",
        property: "fuel.price",
        subject: { featureId: station["id"], componentKey: "e5" },
        result: {
          type: "money",
          amount: (published + delta).toFixed(3),
          currency: "EUR",
          per: "L",
        },
        geometry: (station["location"] as { geometry: unknown }).geometry,
        reportedAt,
        nonce: nextNonce(),
      } as never;
      return app.inject({
        method: "POST",
        url: "/contrib/reports",
        payload: { report: await signReport(registry, claim, who.key), reportingGrant: who.grant },
      });
    };
    // Within a cent of the ministry's price: resolved as it lands.
    ok(await price(0.009, "2026-09-22T12:00:00.000Z"));
    ok(await price(0.02, "2026-09-22T12:00:30.000Z"));
    // The ministry publishes a later price: the sweep reads the series' history table.
    const repriced: Rec = {
      ...draftOf(e5),
      result: { ...(e5["result"] as Rec), amount: (published + 0.02).toFixed(3) },
      phenomenonTime: { instant: "2026-09-22T12:05:00.000Z" },
      freshness: { fetchedAt: "2026-09-22T12:06:00.000Z" },
    };
    const { id: _old, ...later } = repriced;
    const summary = await writeSnapshot(
      db.sql,
      "es-minetur-fuel",
      { observations: [{ ...later, id: observationId("es-minetur-fuel", later as never) }] },
      { registry, instanceId: INSTANCE, now: "2026-09-22T12:06:00.000Z", complete: false },
    );
    expect(summary.rejected).toEqual([]);
    clock.now = "2026-09-22T12:07:00.000Z";
    const swept = await sweepCrossValidateObservations(
      contributions,
      registry,
      clock.now,
      sweepLog,
    );
    expect(swept.scanned).toBeGreaterThan(0);
    expect(sweepFailures).toEqual([]);
    expect(hookErrors).toEqual([]);
  }, 60_000);

  it("lands crowd readings of a charge point, confirms them and takes votes", async () => {
    clock.now = "2026-10-01T07:00:00.000Z";
    const claim = (
      componentKey: string,
      value: string,
      reportedAt: string,
      featureId = site.feature["id"],
    ) =>
      ({
        claimClass: "observation",
        property: "charging.evse_status",
        result: { type: "category", value, vocabulary: "evse_status" },
        geometry: { type: "Point", coordinates: [8.40478, 49.00062] },
        subject: { featureId, componentKey },
        reportedAt,
        nonce: nextNonce(),
      }) as never;
    const post = async (who: { key: ReporterKey; grant: string }, body: never) =>
      app.inject({
        method: "POST",
        url: "/contrib/reports",
        payload: { report: await signReport(registry, body, who.key), reportingGrant: who.grant },
      });
    const at = "2026-10-01T06:59:00.000Z";
    const first = ok(await post(await reporter(), claim(chargePoints[0]!, "out_of_order", at)));
    const id = (first.json() as { record: { id: string } }).record.id;
    // The same reading from a second driver confirms it.
    ok(await post(await reporter(), claim(chargePoints[0]!, "out_of_order", at)));
    ok(await vote(await reporter(), "observation", id, "confirm"));
    ok(await vote(await reporter(), "observation", id, "flag"));

    // A charge point only the register lists has no feed reading: a driver's
    // report is its fused row's only source, and the row goes once drivers negate it.
    const listed = (register.feature["components"] as { key: string }[])[0]!.key;
    const lone = ok(
      await post(await reporter(), claim(listed, "out_of_order", at, register.feature["id"])),
    );
    const loneId = (lone.json() as { record: { id: string } }).record.id;
    const fused = async () => {
      const [row] = await db.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conditions.observation_latest
         WHERE source_id = '@fused' AND ${loneId} = ANY(fused_from)`;
      return row!.n;
    };
    expect(await fused()).toBe(1);
    // Negated, the reading has ended and takes no more votes.
    for (let votes = 0; (await fused()) > 0 && votes < 5; votes++) {
      ok(await vote(await reporter(), "observation", loneId, "negate"));
    }
    expect(await fused()).toBe(0);
    expect(hookErrors).toEqual([]);
  }, 60_000);

  it("runs the cross-validation sweeps", async () => {
    clock.now = "2026-07-12T08:05:00.000Z";
    const local = await sweepCrossValidate(contributions, registry, clock.now, sweepLog);
    const federated = await sweepFederatedCrossValidate(
      contributions,
      registry,
      clock.now,
      sweepLog,
    );
    clock.now = "2026-10-01T07:05:00.000Z";
    const readings = await sweepCrossValidateObservations(
      contributions,
      registry,
      clock.now,
      sweepLog,
    );
    expect([local.scanned, federated.scanned, readings.scanned]).not.toContain(0);
    expect(sweepFailures).toEqual([]);
  }, 60_000);
});
