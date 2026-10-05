/**
 * Real published facility records as drafts, for the canonical view suites:
 * the facilities fit check's golden records, and the linking and crowd fit
 * fixtures (MobiData BW charge points and car parks, OpenStreetMap's for the
 * same streets) as a parser would hand them to the write seam. The registry
 * registers the formats among them OpenConditions does not parse.
 * Test-only: no runtime module imports this file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type Registry,
} from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import type postgres from "postgres";
import { syncSources } from "../sources.js";

type Rec = Record<string, unknown>;

const MODEL_TESTS = path.resolve(import.meta.dirname, "../../../model-registry/src/__tests__");

export const registry: Registry = buildRegistry([
  ...productionModules,
  {
    name: "facilities-fit",
    entries: [
      extendVocabulary({
        vocabulary: "source_format",
        values: ["ocpi", "autobahn-parking", "mimit", "osm"],
      }),
    ],
  },
]);

const json = (file: string) => JSON.parse(readFileSync(path.join(MODEL_TESTS, file), "utf8"));

/** The draft a sealed record was made from: sealing adds only these fields. */
export function draftOf(sealed: Rec): Rec {
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

/** The facilities golden records as drafts, grouped by source. */
export function goldenFacilities(): Map<
  string,
  { features: Rec[]; observations: Rec[]; offers: Rec[] }
> {
  const out = new Map<string, { features: Rec[]; observations: Rec[]; offers: Rec[] }>();
  for (const record of json("golden/facilities.json") as Rec[]) {
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

/** The catalogue rows the fusion reads tiers from, for the sources these suites write. */
export async function seedSources(sql: postgres.Sql, tiers: Record<string, string>) {
  await syncSources(
    sql,
    Object.entries(tiers).map(([id, tier]) => ({
      id,
      domain: "facilities",
      format: "test",
      product: "facilities",
      tier,
      country: "DE",
      operator: id,
      license: "CC-BY-4.0",
      attribution: id,
      restricted: false,
      cadenceSec: 300,
      freshnessWindowSec: 900,
    })),
  );
}

/** Records the sources' last successful poll, which their staleness is read from. */
export async function polled(sql: postgres.Sql, sourceId: string, at: string) {
  await sql`
    INSERT INTO conditions.source_status (source, last_success_at, freshness_window_sec)
    VALUES (${sourceId}, ${at}, 900)
    ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`;
}

const feed = (
  sourceId: string,
  format: string,
  recordId: string,
  provider: string,
  license: string,
) => ({
  origin: "feed",
  sourceId,
  sourceFormat: format,
  accessMode: "bulk",
  recordId,
  attribution: { provider, license },
  privacy: { class: "authoritative" },
});

const point = (lon: number, lat: number) => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  extent: "point",
  geometryOrigin: "source",
  fuzziness: "exact",
});

interface OcpdbLocation {
  id: string;
  source: string;
  original_id: string;
  address?: string;
  postal_code?: string;
  city?: string;
  coordinates: { latitude: number; longitude: number };
  operator?: { name: string };
  evses?: {
    uid: string;
    evse_id?: string;
    status: string;
    last_updated: string;
    connectors: { id: string; standard: string; format: string; power_type: string }[];
  }[];
}

/** eMI3 EVSE ids: country, operator, `E`, outlet — with or without the separators. */
const EMI3 = /^[A-Z]{2}\*?[A-Z0-9]{3}\*?E[A-Z0-9*]{1,31}$/;

/**
 * One OCPDB location as a charging site draft and its charge points'
 * statuses, as the crowd fit check builds them: the database's row id is the
 * aggregator's own (`provider`), and the register's EVSE ids are `bnetza`
 * ids, not eMI3 ones.
 */
export function chargingSite(loc: OcpdbLocation, fetchedAt: string) {
  const id = `oc:feature:de-bw-ocpdb:${loc.id}`;
  const provenance = {
    ...feed("de-bw-ocpdb", "ocpi", loc.id, "MobiData BW", "CC-BY-4.0"),
    upstream: [{ publisher: loc.source, recordId: loc.original_id }],
  };
  const location = point(loc.coordinates.longitude, loc.coordinates.latitude);
  const evses = loc.evses ?? [];
  const components = evses.flatMap((evse) => [
    {
      key: evse.uid,
      kind: "evse",
      ...(evse.evse_id === undefined
        ? {}
        : {
            externalIds: [
              { scheme: EMI3.test(evse.evse_id) ? "emi3:evse" : "bnetza", id: evse.evse_id },
            ],
          }),
      details: {
        kind: "evse",
        v: 1,
        uid: evse.uid,
        ...(evse.evse_id ? { evseId: evse.evse_id } : {}),
      },
    },
    ...evse.connectors.map((c) => ({
      key: c.id,
      parentKey: evse.uid,
      kind: "connector",
      details: {
        kind: "connector",
        v: 1,
        standard: registry.crosswalk.value("connector_standard", "ocpi", c.standard) ?? "UNKNOWN",
        format: c.format.toLowerCase(),
        powerType: c.power_type,
      },
    })),
  ]);
  const feature: Rec = {
    id,
    class: "feature",
    kind: "charging_site",
    temporality: "static",
    lifecycle: "operational",
    location,
    externalIds: [
      { scheme: "provider", id: loc.id, authority: "de-bw-ocpdb" },
      ...(loc.source === "bnetza_api" ? [{ scheme: "bnetza", id: loc.original_id }] : []),
    ],
    ...(loc.operator === undefined
      ? {}
      : { operator: { role: "operator", name: [{ lang: "de", text: loc.operator.name }] } }),
    provenance,
    freshness: { fetchedAt },
    ...(components.length > 0 ? { components } : {}),
    details: { kind: "charging_site", v: 1 },
  };
  const statuses = evses.map((evse) => {
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
      phenomenonTime: { instant: evse.last_updated },
      aggregation: "instantaneous",
    };
    return { id: observationId("de-bw-ocpdb", draft as never), ...draft };
  });
  return { feature, statuses };
}

/** The OCPDB charging sites of central Karlsruhe (linking fit). */
export const karlsruheCharging = (fetchedAt: string) =>
  (json("fixtures/facilities/ocpdb-charging-karlsruhe.json").items as OcpdbLocation[]).map((l) =>
    chargingSite(l, fetchedAt),
  );

/** The two OCPDB rows of the Luisenstraße 2F car park (crowd fit): a live feed and the register. */
export const luisenstrasse = (fetchedAt: string) =>
  (json("fixtures/crowd/ocpdb-luisenstrasse-2f.json").items as OcpdbLocation[]).map((l) =>
    chargingSite(l, fetchedAt),
  );

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags: Record<string, string>;
}

/** OpenStreetMap's `parking=*` as a car park's type: kerbside parking is on the street. */
const parkingType = (parking: string | undefined) =>
  ["street_side", "lane", "on_kerb", "half_on_kerb"].includes(parking ?? "")
    ? "on_street"
    : "off_street";

/** OpenStreetMap's elements of one amenity as per-source features of source `osm`. */
export function osmFeatures(kind: string, amenity: string, fetchedAt: string): Rec[] {
  return (json("fixtures/facilities/osm-karlsruhe.json").elements as OsmElement[])
    .filter((e) => e.tags["amenity"] === amenity)
    .flatMap((e) => {
      const at = e.lat !== undefined && e.lon !== undefined ? e : e.center;
      if (at?.lat === undefined || at.lon === undefined) return [];
      const name = e.tags["name"];
      const operator = e.tags["operator"];
      return [
        {
          id: `oc:feature:osm:${e.type}-${e.id}`,
          class: "feature",
          kind,
          ...(kind === "parking_site" ? { type: parkingType(e.tags["parking"]) } : {}),
          temporality: "static",
          lifecycle: "operational",
          location: point(at.lon, at.lat),
          ...(name === undefined ? {} : { name: [{ lang: "de", text: name }] }),
          ...(operator === undefined
            ? {}
            : { operator: { role: "operator", name: [{ lang: "de", text: operator }] } }),
          externalIds: [{ scheme: `osm:${e.type}`, id: String(e.id) }],
          provenance: feed(
            "osm",
            "osm",
            `${e.type}-${e.id}`,
            "OpenStreetMap contributors",
            "ODbL-1.0",
          ),
          freshness: { fetchedAt },
          details: { kind, v: 1 },
        },
      ];
    });
}

interface ParkapiSite {
  id: number;
  name: string;
  address?: string;
  lat: number;
  lon: number;
  operator_name?: string;
}

/** MobiData BW ParkAPI's car parks of central Karlsruhe. */
export function parkapiKarlsruhe(fetchedAt: string): Rec[] {
  return (json("fixtures/facilities/parkapi-karlsruhe.json").items as ParkapiSite[]).map(
    (site) => ({
      id: `oc:feature:de-bw-parkapi:${site.id}`,
      class: "feature",
      kind: "parking_site",
      type: "off_street",
      temporality: "static",
      lifecycle: "operational",
      location: {
        ...point(site.lon, site.lat),
        ...(site.address === undefined ? {} : { address: { country: "DE", text: site.address } }),
      },
      name: [{ lang: "de", text: site.name }],
      ...(site.operator_name === undefined
        ? {}
        : { operator: { role: "operator", name: [{ lang: "de", text: site.operator_name }] } }),
      provenance: feed("de-bw-parkapi", "parkapi-v3", String(site.id), "MobiData BW", "CC-BY-4.0"),
      freshness: { fetchedAt },
      details: { kind: "parking_site", v: 1 },
    }),
  );
}
