/**
 * Records and a database for the outbox suites: minimal valid drafts of each
 * class (what a parser hands the write seam), a crowd report as landing a
 * claim drafts it, a peer's record as the inbox admits it, and a disposable
 * PostGIS database with every migration applied. Test-only.
 */
import { runMigrations } from "@openconditions/core/server";
import {
  landClaim,
  observationId,
  type Registry,
  schemaVersions,
  sealRecord,
} from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  writeRecord,
} from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { admitFederatedRecord } from "../admit.js";
import type { RecordFilter } from "../record-filter.js";

type Rec = Record<string, unknown>;

export const registry: Registry = productionRegistry();
export const INSTANCE = "test.local";
export const PEER = "peer.example.net";
export const FETCHED_AT = "2026-10-01T10:00:00.000Z";
export const WRITTEN_AT = "2026-10-01T10:00:05.000Z";

/** The write context of this instance at `now`. */
export const writeCtx = (now = WRITTEN_AT) => ({ registry, instanceId: INSTANCE, now });

export async function startDatabase(): Promise<{
  sql: postgres.Sql;
  close(): Promise<void>;
}> {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  await runMigrations(url);
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(FETCHED_AT),
  });
  return {
    sql,
    async close() {
      try {
        await sql.end();
      } finally {
        await container.stop();
      }
    },
  };
}

/** Adds a subscription with the given filter: what gates the capture. */
export async function subscribe(sql: postgres.Sql, id: string, filter: RecordFilter = {}) {
  await sql`
    INSERT INTO conditions.federation_subscription
      (id, peer_id, filter, delivery_mode, created_at, updated_at)
    VALUES (${id}, ${`peer-${id}`}, ${sql.json(filter as never)}, 'pull', now(), now())`;
}

const provenance = (sourceId: string, recordId: string) => ({
  origin: "feed",
  sourceId,
  sourceFormat: "datex2",
  accessMode: "bulk",
  recordId,
  attribution: { provider: "Test publisher", license: "CC0-1.0" },
  privacy: { class: "authoritative" },
});

const pointAt = (lon: number, lat = 52.37) => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  extent: "point",
  geometryOrigin: "source",
  fuzziness: "exact",
});

export const situationId = (local: string, sourceId = "nl-ndw-events") =>
  `oc:situation:${sourceId}:${local}`;

/** An accident closing a carriageway: kind `incident` with a `closure` effect. */
export function incidentDraft(
  local: string,
  over: Rec & { lon?: number; sourceId?: string } = {},
): Rec {
  const { lon, sourceId = "nl-ndw-events", ...rest } = over;
  return {
    id: situationId(local, sourceId),
    class: "situation",
    kind: "incident",
    type: "accident",
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "major", source: "declared", declaredRaw: "high" },
    headline: [{ lang: "nl", text: "Ongeval" }],
    validity: { status: "active", start: "2026-10-01T09:00:00Z" },
    effects: [
      {
        id: `${local}/closure`,
        kind: "closure",
        v: 1,
        scope: "carriageway",
        applicability: { kind: "all" },
        compliance: "mandatory",
        normalization: "complete",
      },
    ],
    details: { kind: "incident", v: 1 },
    location: pointAt(lon ?? 4.9),
    provenance: provenance(sourceId, local),
    freshness: { fetchedAt: FETCHED_AT },
    ...rest,
  };
}

/** Works whose lane closure applies only during a phase: no priority. */
export function roadworksDraft(local: string, over: Rec & { lon?: number } = {}): Rec {
  return incidentDraft(local, {
    kind: "roadworks",
    type: "works",
    planned: true,
    severity: { label: "minor", source: "derived" },
    effects: [],
    details: {
      kind: "roadworks",
      v: 1,
      phases: [
        {
          id: "p1",
          validity: {
            status: "planned",
            start: "2026-10-05T20:00:00Z",
            end: "2026-10-06T05:00:00Z",
          },
          effects: [laneRestriction(local, "some_lanes_closed")],
        },
      ],
    },
    ...over,
  });
}

export function laneRestriction(local: string, vehicleImpact: string): Rec {
  return {
    id: `${local}/lane_restriction`,
    kind: "lane_restriction",
    v: 1,
    vehicleImpact,
    lanesClosed: 1,
    applicability: { kind: "all" },
    compliance: "mandatory",
    normalization: "complete",
  };
}

export const featureId = (local: string) => `oc:feature:nl-ndw-flow:${local}`;

/** An NDW measurement site with one channel per lane. */
export function featureDraft(local: string, lanes = 2): Rec {
  return {
    id: featureId(local),
    class: "feature",
    kind: "measurement_site",
    type: "traffic",
    temporality: "static",
    lifecycle: "operational",
    details: { kind: "measurement_site", v: 1, measuredProperties: ["traffic.speed"] },
    components: Array.from({ length: lanes }, (_, i) => ({
      key: `lane${i + 1}`,
      kind: "sensor_channel",
      position: { type: "Point", coordinates: [4.536, 52.0235] },
      details: { kind: "sensor_channel", v: 1, index: i + 1, property: "traffic.speed" },
    })),
    location: { ...pointAt(4.536069, 52.0235558), geometryOrigin: "site_table" },
    provenance: provenance("nl-ndw-flow", local),
    freshness: { fetchedAt: FETCHED_AT },
  };
}

export const offerId = (local: string) => `oc:offer:de-parking:${local}`;

/** A car park's day rate. */
export function offerDraft(local: string, maxPrice = "20.00"): Rec {
  return {
    id: offerId(local),
    class: "offer",
    kind: "parking_rate",
    temporality: "static",
    subject: { class: "feature", id: "oc:feature:de-parking:p1" },
    currency: "EUR",
    elements: [
      { components: [{ type: "parking_time", price: { amount: "2.50", currency: "EUR" } }] },
    ],
    minPrice: { amount: "2.50", currency: "EUR" },
    maxPrice: { amount: maxPrice, currency: "EUR" },
    validity: { status: "active" },
    location: pointAt(8.4, 49.0),
    provenance: provenance("de-parking", local),
    freshness: { fetchedAt: FETCHED_AT },
  };
}

/** A speed reading of an NDW site, with its derived id. */
export function speedReading(value: number, at: string, property = "traffic.speed"): Rec {
  const draft: Rec = {
    class: "observation",
    kind: "observation",
    property,
    subject: { kind: "feature", featureId: featureId("s1") },
    result: { type: "quantity", value, unit: "km/h" },
    phenomenonTime: { instant: at },
    aggregation: "instantaneous",
    temporality: "live",
    location: { ...pointAt(4.536069, 52.0235558), geometryOrigin: "site_table" },
    provenance: provenance("nl-ndw-flow", "s1"),
    freshness: { fetchedAt: FETCHED_AT },
  };
  draft["id"] = observationId("nl-ndw-flow", draft as Parameters<typeof observationId>[1]);
  return draft;
}

/** A reporter's key: the landed draft carries it, the outbox must never. */
export const REPORTER_KEY = "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY";

/** A crowd report of an accident, as landing a claim drafts it. */
export function crowdReportDraft(nonce: string, now = WRITTEN_AT): Rec {
  const landed = landClaim(
    registry,
    {
      claim: {
        claimClass: "situation",
        kind: "incident",
        type: "accident",
        geometry: { type: "Point", coordinates: [4.9, 52.37] },
        fuzziness: "exact",
        reportedAt: now,
        nonce: `outbox-test-nonce-${nonce}`,
      },
      keyId: REPORTER_KEY,
    },
    { instanceId: INSTANCE, now, attribution: { provider: INSTANCE, license: "CC0-1.0" } },
  );
  if (!landed.ok) throw new Error(JSON.stringify(landed.issues));
  return landed.draft as Rec;
}

/** A peer's situation, sealed by the peer and admitted as the inbox admits it. */
export function peerSituation(local: string, revision = 1): Rec {
  const sealed = sealRecord(registry, incidentDraft(local, { sourceId: "be-flanders-events" }), {
    instanceId: PEER,
    revision,
    recordedAt: WRITTEN_AT,
  });
  if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
  const admitted = admitFederatedRecord(
    registry,
    { peerInstanceId: PEER, peerVersions: schemaVersions(registry), receivedAt: WRITTEN_AT },
    sealed.value,
  );
  if (!admitted.admitted) throw new Error(JSON.stringify(admitted));
  return admitted.record as Rec;
}

/** Writes a draft as this instance's own record; fails the test on anything but a write. */
export async function writeOwn(sql: postgres.Sql, draft: Rec, now = WRITTEN_AT) {
  const result = await writeRecord(sql, { draft }, writeCtx(now));
  if (result.status === "rejected") throw new Error(JSON.stringify(result.issues));
  return result;
}
