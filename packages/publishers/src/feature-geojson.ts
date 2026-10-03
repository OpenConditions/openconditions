import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { FeedInfo } from "./types.js";

type Rec = Record<string, unknown>;

export type FeatureRecordCollection = FeatureCollection<Geometry | null, Rec> & {
  attribution?: string;
  license?: string;
  url?: string;
  timestamp?: string;
  /** The cursor of the next page; null when this page is the last. */
  next?: string | null;
};

/**
 * Feature records as a GeoJSON FeatureCollection: each record as a GeoJSON
 * feature whose geometry is its location's and whose properties are the
 * record itself (its location without the geometry the GeoJSON feature
 * already carries). Components ride along exactly when the records carry
 * them. Records are never rebuilt, only wrapped.
 */
export function featuresToGeoJSON(
  features: readonly Rec[],
  info: FeedInfo = {},
  opts: { next?: string | null } = {},
): FeatureRecordCollection {
  return {
    type: "FeatureCollection",
    ...(info.attribution ? { attribution: info.attribution } : {}),
    ...(info.license ? { license: info.license } : {}),
    ...(info.url ? { url: info.url } : {}),
    ...(info.timestamp ? { timestamp: info.timestamp } : {}),
    ...(opts.next !== undefined ? { next: opts.next } : {}),
    features: features.map((record): Feature<Geometry | null, Rec> => {
      const { geometry, ...location } = (record["location"] as Rec | undefined) ?? {};
      return {
        type: "Feature",
        id: String(record["id"]),
        geometry: (geometry as Geometry | null | undefined) ?? null,
        properties: { ...record, location },
      };
    }),
  };
}

/** GeoJSON-LD base context plus the schema.org and SOSA terms a feature's fields map to. */
const CONTEXT: unknown = [
  "https://geojson.org/geojson-ld/geojson-context.jsonld",
  {
    oc: "https://openconditions.org/ns#",
    sosa: "http://www.w3.org/ns/sosa/",
    schema: "https://schema.org/",
    kind: "oc:kind",
    subtype: "oc:subtype",
    lifecycle: "oc:lifecycle",
    components: "sosa:hosts",
    name: "schema:name",
    description: "schema:description",
    operator: "schema:provider",
    owner: "schema:owner",
    address: "schema:address",
    openingHours: "schema:openingHours",
    externalIds: "schema:identifier",
    provenance: "oc:provenance",
    recordedAt: "schema:dateModified",
  },
];

export type FeatureRecordJsonLd = FeatureRecordCollection & { "@context": unknown };

/**
 * Feature records as GeoJSON-LD: the GeoJSON collection with a
 * schema.org/SOSA `@context` and a per-feature `@id`/`@type`. Every feature is
 * a `schema:Place`; a measurement site is also a `sosa:Platform` hosting its
 * channels.
 */
export function featuresToJsonLd(
  features: readonly Rec[],
  info: FeedInfo = {},
  opts: { next?: string | null } = {},
): FeatureRecordJsonLd {
  const fc = featuresToGeoJSON(features, info, opts);
  return {
    "@context": CONTEXT,
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      "@id": `https://openconditions.org/id/${encodeURIComponent(String(f.id))}`,
      "@type":
        f.properties["kind"] === "measurement_site"
          ? ["schema:Place", "sosa:Platform"]
          : "schema:Place",
    })) as FeatureRecordCollection["features"],
  };
}
