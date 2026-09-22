import { readFileSync } from "node:fs";
import {
  canonicalClusters,
  type FeatureLink,
  type LinkableFeature,
  matchOsm,
  type OsmCandidate,
  proposeLink,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { productionRegistry } from "../index.js";

/**
 * Feature identity linking against real records of one city. Captured
 * 2026-09-22 for central Karlsruhe: charging sites from the MobiData BW
 * charge-point database (OCPI 2.2, CC BY 4.0), parking sites from MobiData BW
 * ParkAPI v3, and the charging stations and car parks OpenStreetMap holds for
 * the same streets (ODbL). OSM is treated as a second source here, which is
 * what it is: a publisher of the same real-world things under its own ids.
 */
const registry = productionRegistry();
const chargingRules = registry.kind("feature", "charging_site")!.linking;
const parkingRules = registry.kind("feature", "parking_site")!.linking;

const json = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/facilities/${name}`, import.meta.url), "utf8"));

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags: Record<string, string>;
}

const osmElements = (amenity: string): OsmElement[] =>
  (json("osm-karlsruhe.json").elements as OsmElement[]).filter(
    (e) => e.tags["amenity"] === amenity,
  );

const osmPoint = (e: OsmElement) =>
  e.lat !== undefined && e.lon !== undefined
    ? { type: "Point", coordinates: [e.lon, e.lat] }
    : e.center === undefined
      ? undefined
      : { type: "Point", coordinates: [e.center.lon, e.center.lat] };

const osmCandidates = (amenity: string): OsmCandidate[] =>
  osmElements(amenity).flatMap((e) => {
    const geometry = osmPoint(e);
    return geometry === undefined
      ? []
      : [{ id: { scheme: `osm:${e.type}` as const, id: String(e.id) }, tags: e.tags, geometry }];
  });

/** OSM elements as per-source features, the way an OSM import would produce them. */
const osmFeatures = (kind: string, amenity: string): LinkableFeature[] =>
  osmElements(amenity).flatMap((e) => {
    const geometry = osmPoint(e);
    if (geometry === undefined) return [];
    const name = e.tags["name"];
    const operator = e.tags["operator"];
    return [
      {
        id: `oc:feature:osm:${e.type}/${e.id}`,
        kind,
        location: { geometry, fuzziness: "exact" },
        ...(name === undefined ? {} : { name: [{ lang: "de", text: name }] }),
        ...(operator === undefined ? {} : { operator: { name: [{ lang: "de", text: operator }] } }),
        externalIds: [{ scheme: `osm:${e.type}`, id: String(e.id) }],
        provenance: { sourceId: "osm" },
      },
    ];
  });

interface OcpdbLocation {
  id: string;
  address?: string;
  postal_code?: string;
  city?: string;
  coordinates: { latitude: number; longitude: number };
  operator?: { name: string };
  evses?: { evse_id?: string }[];
}

const chargingFeatures = (): LinkableFeature[] =>
  (json("ocpdb-charging-karlsruhe.json").items as OcpdbLocation[]).map((loc) => ({
    id: `oc:feature:de-bw-ocpdb:${loc.id}`,
    kind: "charging_site",
    location: {
      geometry: {
        type: "Point",
        coordinates: [loc.coordinates.longitude, loc.coordinates.latitude],
      },
      fuzziness: "exact",
      address: { street: loc.address, postalCode: loc.postal_code, city: loc.city },
    },
    ...(loc.operator === undefined
      ? {}
      : { operator: { name: [{ lang: "de", text: loc.operator.name }] } }),
    externalIds: [{ scheme: "ocpi:location", id: loc.id }],
    components: (loc.evses ?? []).flatMap((evse) =>
      evse.evse_id === undefined
        ? []
        : [{ externalIds: [{ scheme: "emi3:evse", id: evse.evse_id }] }],
    ),
    provenance: { sourceId: "de-bw-ocpdb" },
  }));

interface ParkapiSite {
  id: number;
  name: string;
  address?: string;
  lat: number;
  lon: number;
  operator_name?: string;
}

const parkingFeatures = (): LinkableFeature[] =>
  (json("parkapi-karlsruhe.json").items as ParkapiSite[]).map((site) => ({
    id: `oc:feature:de-bw-parkapi:${site.id}`,
    kind: "parking_site",
    location: {
      geometry: { type: "Point", coordinates: [site.lon, site.lat] },
      fuzziness: "exact",
      ...(site.address === undefined ? {} : { address: { text: site.address } }),
    },
    name: [{ lang: "de", text: site.name }],
    ...(site.operator_name === undefined
      ? {}
      : { operator: { name: [{ lang: "de", text: site.operator_name }] } }),
    provenance: { sourceId: "de-bw-parkapi" },
  }));

/** Every cross-source pair a linking pass would consider. */
function linkAll(
  left: readonly LinkableFeature[],
  right: readonly LinkableFeature[],
  rules: typeof chargingRules,
): FeatureLink[] {
  return left.flatMap((a) =>
    right.flatMap((b) => {
      const link = proposeLink(a, b, rules);
      return link === undefined ? [] : [link];
    }),
  );
}

const named = (links: readonly FeatureLink[], features: readonly LinkableFeature[]) => {
  const byId = new Map(features.map((f) => [f.id, f]));
  return links.map((l) => ({
    a: byId.get(l.aId)?.name?.[0]?.text ?? l.aId,
    b: byId.get(l.bId)?.name?.[0]?.text ?? l.bId,
    status: l.status,
  }));
};

describe("charging sites against OpenStreetMap", () => {
  const ocpdb = chargingFeatures();
  const osm = osmFeatures("charging_site", "charging_station");
  const links = linkAll(ocpdb, osm, chargingRules);

  it("has real records to work with", () => {
    expect(ocpdb.length).toBe(12);
    expect(osm.length).toBe(24);
  });

  it("links only what stands close enough to be the same installation", () => {
    // The database publishes no site names, so position is the only evidence,
    // and only one pair in the city centre is inside the 20 m window.
    expect(links.filter((l) => l.status === "accepted")).toHaveLength(1);
    const [link] = links;
    expect(link?.aId).toBe("oc:feature:de-bw-ocpdb:206019");
    expect(link?.method).toBe("spatial_attribute");
    expect(link?.reasons[0]).toMatch(/^12\.\d m$/);
  });

  it("declines two sites of one source that share a neighbour", () => {
    // Two charge points at the same address stand about 40 m from one OSM
    // node. Linking either would be a guess, so neither is linked.
    const ambiguous = links.filter((l) => l.bId === "oc:feature:osm:node/4793460914");
    expect(ambiguous).toEqual([]);
  });

  it("finds the OSM element that carries a charge point's own reference", () => {
    const candidates = osmCandidates("charging_station");
    const withRef = candidates.filter((c) => c.tags["ref:EU:EVSE"] !== undefined);
    expect(withRef.length).toBeGreaterThan(0);
    // The tag holds every charge point of the site, separated by semicolons.
    expect(withRef.some((c) => c.tags["ref:EU:EVSE"]!.includes(";"))).toBe(true);
    const listed = withRef[0]!.tags["ref:EU:EVSE"]!.split(";")[0]!;
    const site: LinkableFeature = {
      id: "oc:feature:de-bw-ocpdb:test",
      kind: "charging_site",
      location: { geometry: { type: "Point", coordinates: [0, 0] }, fuzziness: "exact" },
      components: [{ externalIds: [{ scheme: "emi3:evse", id: listed }] }],
      provenance: { sourceId: "de-bw-ocpdb" },
    };
    expect(matchOsm(site, candidates, chargingRules)).toEqual({
      id: withRef[0]!.id,
      method: "id",
      confidence: 1,
    });
  });
});

describe("parking sites against OpenStreetMap", () => {
  const parkapi = parkingFeatures();
  const osm = osmFeatures("parking_site", "parking");
  const links = linkAll(parkapi, osm, parkingRules);
  const accepted = links.filter((l) => l.status === "accepted");

  it("links a garage both sources name the same, just beyond the close window", () => {
    const pairs = named(accepted, [...parkapi, ...osm]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { a: "Parkgarage Waldhornstraße", b: "Parkgarage Waldhornstraße", status: "accepted" },
        {
          a: "Parkgarage Badische Landesbibliothek (BLB)",
          b: "Landesbibliothek",
          status: "accepted",
        },
      ]),
    );
  });

  it("leaves two neighbouring car parks with unrelated names apart", () => {
    const wrong = named(accepted, [...parkapi, ...osm]).filter(
      (p) => p.a === "Karlstraße" && p.b === "Akademiestraße",
    );
    expect(wrong).toEqual([]);
  });

  it("gives every site a canonical cluster, merged or alone", () => {
    const all = [...parkapi, ...osm];
    const clusters = canonicalClusters(all, accepted, { instanceId: "oc.example" });
    expect(clusters.flatMap((c) => c.memberIds)).toHaveLength(all.length);
    expect(clusters.filter((c) => c.memberIds.length > 1).length).toBe(accepted.length);
    for (const cluster of clusters) {
      expect(cluster.canonicalFeatureId).toMatch(/^oc:feature:oc\.example:[0-9a-f]{64}$/);
      expect(cluster.mergedSources.map((s) => s.source)).toEqual(
        cluster.memberIds.map((id) => (id.includes(":osm:") ? "osm" : "de-bw-parkapi")),
      );
    }
  });

  it("matches a site to the OSM car park of the same name", () => {
    const site = parkapi.find((f) => f.name?.[0]?.text === "Parkgarage Waldhornstraße")!;
    expect(matchOsm(site, osmCandidates("parking"), parkingRules)).toMatchObject({
      method: "spatial_tag",
    });
  });
});
