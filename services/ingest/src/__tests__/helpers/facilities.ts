/**
 * Published facility records for the record API suites: the facilities fit
 * check's golden records (charging and parking sites, fuel stations, their
 * readings and tariffs) written per source the way a poll writes them, a
 * second source describing one of the fuel stations so the canonical view
 * holds a linked cluster, and crowd readings landed on a canonical subject.
 * OpenConditions parses none of these formats yet, so the registry registers
 * them. Test-only: no runtime module imports this file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildRegistry,
  extendVocabulary,
  landClaim,
  observationId,
  type Registry,
} from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
  writeRecord,
  writeSnapshot,
} from "@openconditions/storage";
import type postgres from "postgres";

type Rec = Record<string, unknown>;

const GOLDEN = path.resolve(
  import.meta.dirname,
  "../../../../../packages/model-registry/src/__tests__/golden/facilities.json",
);

export const INSTANCE = "test.local";
export const NOW = "2026-09-22T12:00:00.000Z";

export const facilitiesRegistry: Registry = buildRegistry([
  ...productionModules,
  {
    name: "facilities-fit",
    entries: [
      extendVocabulary({
        vocabulary: "source_format",
        values: ["ocpi", "parkapi", "datex2-parking", "autobahn-parking", "mimit"],
      }),
    ],
  },
]);

export const TIERS: Record<string, string> = {
  "de-bw-ocpdb": "aggregator",
  "de-bw-parkapi": "aggregator",
  "nl-ndw-truckparking": "authoritative",
  "de-autobahn-events": "operator",
  "es-minetur-fuel": "authoritative",
  "it-mimit": "authoritative",
  "at-econtrol-fuel": "authoritative",
  "es-fuel-test": "authoritative",
};

/** The draft a sealed record was made from: sealing adds only these fields. */
function draftOf(sealed: Rec): Rec {
  const {
    canonicalId: _canonical,
    domain: _domain,
    revision: _revision,
    recordedAt: _recorded,
    contentHash: _hash,
    ...draft
  } = sealed;
  const { instanceId: _instance, ...provenance } = draft["provenance"] as Rec;
  return { ...draft, provenance };
}

export interface SourceDrafts {
  features: Rec[];
  observations: Rec[];
  offers: Rec[];
}

/** The facilities golden records as drafts, grouped by source. */
export function goldenFacilities(): Map<string, SourceDrafts> {
  const out = new Map<string, SourceDrafts>();
  for (const record of JSON.parse(readFileSync(GOLDEN, "utf8")) as Rec[]) {
    const sourceId = (record["provenance"] as Rec)["sourceId"] as string;
    const drafts = out.get(sourceId) ?? { features: [], observations: [], offers: [] };
    const cls = record["class"] as string;
    (cls === "feature"
      ? drafts.features
      : cls === "offer"
        ? drafts.offers
        : drafts.observations
    ).push(draftOf(record));
    out.set(sourceId, drafts);
  }
  return out;
}

/** The fuel station both the ministry and a second (share-alike-free) mirror publish. */
export const STATION = "oc:feature:es-minetur-fuel:3119";
export const TWIN = "oc:feature:es-fuel-test:3119";

/**
 * A second source's copy of the ministry station with its E5 price, so the
 * two link into one canonical feature whose E5 price is fused from both.
 */
export function twinOf(golden: Map<string, SourceDrafts>): SourceDrafts {
  const minetur = golden.get("es-minetur-fuel")!;
  const station = minetur.features.find((f) => f["id"] === STATION)!;
  const e5 = minetur.observations.find(
    (o) =>
      (o["subject"] as Rec)["featureId"] === STATION &&
      (o["subject"] as Rec)["componentKey"] === "e5",
  )!;
  const provenance = {
    ...(station["provenance"] as Rec),
    sourceId: "es-fuel-test",
    attribution: { provider: "A second ministry mirror", license: "CC-BY-4.0" },
  };
  const feature = {
    ...station,
    id: TWIN,
    provenance,
    components: [(station["components"] as Rec[]).find((c) => c["key"] === "e5")],
  };
  const price: Rec = {
    ...e5,
    subject: { kind: "feature", featureId: TWIN, componentKey: "e5" },
    provenance,
  };
  delete price["id"];
  price["id"] = observationId("es-fuel-test", price as never);
  return { features: [feature], observations: [price], offers: [] };
}

/** Registers the sources in the catalogue the fusion reads tiers from, and their last poll. */
export async function seedSources(sql: postgres.Sql, now = NOW): Promise<void> {
  await syncSources(
    sql,
    Object.entries(TIERS).map(([id, tier]) => ({
      id,
      domain: "facilities",
      format: "test",
      product: "facilities",
      tier,
      country: id.slice(0, 2).toUpperCase(),
      operator: id,
      license: "CC-BY-4.0",
      attribution: id,
      restricted: false,
      cadenceSec: 300,
      freshnessWindowSec: 900,
    })),
  );
  for (const id of Object.keys(TIERS)) {
    await sql`
      INSERT INTO conditions.source_status (source, last_success_at, freshness_window_sec)
      VALUES (${id}, ${now}, 900)
      ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`;
  }
}

/** Writes the golden facilities and the twin station, each source as one complete poll. */
export async function writeFacilities(sql: postgres.Sql): Promise<Map<string, SourceDrafts>> {
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(facilitiesRegistry),
    now: new Date(NOW),
  });
  await seedSources(sql);
  const golden = goldenFacilities();
  golden.set("es-fuel-test", twinOf(golden));
  for (const [sourceId, drafts] of golden) {
    const summary = await writeSnapshot(sql, sourceId, drafts, {
      registry: facilitiesRegistry,
      instanceId: INSTANCE,
      now: NOW,
      complete: true,
    });
    if (summary.rejected.length > 0) throw new Error(JSON.stringify(summary.rejected));
  }
  return golden;
}

/**
 * A crowd report that a charge point is out of order, landed on the canonical
 * charging site and component the way the contributions service lands it.
 */
export async function landEvseReport(
  sql: postgres.Sql,
  opts: {
    canonicalId: string;
    componentKey: string;
    location: Rec;
    nonce: string;
    license?: string;
  },
): Promise<string> {
  const landed = landClaim(
    facilitiesRegistry,
    {
      claim: {
        claimClass: "observation",
        subject: { featureId: opts.canonicalId, componentKey: opts.componentKey },
        property: "charging.evse_status",
        result: { type: "category", value: "out_of_order", vocabulary: "evse_status" },
        geometry: opts.location["geometry"],
        reportedAt: "2026-09-22T11:58:00.000Z",
        nonce: opts.nonce,
      },
      keyId: "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY",
    },
    {
      instanceId: INSTANCE,
      now: NOW,
      attribution: {
        provider: `OpenConditions contributors at ${INSTANCE}`,
        license: opts.license ?? "CC0-1.0",
      },
      resolveFeature: (featureId, key) => ({
        featureId,
        ...(key === undefined ? {} : { componentKey: key }),
        location: opts.location as never,
      }),
    },
  );
  return writeLanded(sql, landed);
}

/**
 * A driver's E5 price for a place (a location subject, not a feature), landed
 * at `location` the way a contribution does; its id.
 */
export async function landPlacePriceReport(
  sql: postgres.Sql,
  opts: { location: Rec; nonce: string },
): Promise<string> {
  const landed = landClaim(
    facilitiesRegistry,
    {
      claim: {
        claimClass: "observation",
        subject: { location: opts.location },
        property: "fuel.price",
        qualifiers: { product: "e5" },
        result: { type: "money", amount: "1.705", currency: "EUR", per: "L" },
        geometry: opts.location["geometry"],
        reportedAt: "2026-09-22T11:58:00.000Z",
        nonce: opts.nonce,
      },
      keyId: "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY",
    },
    {
      instanceId: INSTANCE,
      now: NOW,
      attribution: {
        provider: `OpenConditions contributors at ${INSTANCE}`,
        license: "CC0-1.0",
      },
      resolveFeature: () => undefined,
    },
  );
  return writeLanded(sql, landed);
}

async function writeLanded(
  sql: postgres.Sql,
  landed: ReturnType<typeof landClaim>,
): Promise<string> {
  if (!landed.ok) throw new Error(JSON.stringify(landed.issues));
  const written = await writeRecord(
    sql,
    { draft: landed.draft },
    { registry: facilitiesRegistry, instanceId: INSTANCE, now: NOW },
  );
  if (written.status === "rejected") throw new Error(JSON.stringify(written));
  await sql`
    UPDATE conditions.observation_latest SET evidence_state = 'self_reported', confidence_score = 0.5
     WHERE crowd_record_id = ${landed.draft["id"] as string}`;
  return landed.draft["id"] as string;
}
