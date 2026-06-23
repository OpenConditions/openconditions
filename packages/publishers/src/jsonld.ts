import type { Observation } from "@openconditions/core";
import { type ConditionsFeatureCollection, observationsToGeoJSON } from "./geojson.js";
import type { FeedInfo } from "./types.js";

export type JsonLdFeatureCollection = ConditionsFeatureCollection & { "@context": unknown };

/** GeoJSON-LD base context + SOSA/Schema.org terms — makes the GeoJSON RDF-compatible.
 * Widely-understood Schema.org terms are preferred; domain-specifics stay under oc:. */
const CONTEXT: unknown = [
  "https://geojson.org/geojson-ld/geojson-context.jsonld",
  {
    oc: "https://openconditions.org/ns#",
    sosa: "http://www.w3.org/ns/sosa/",
    schema: "https://schema.org/",
    type: "oc:conditionType",
    subtype: "oc:subtype",
    category: "schema:category",
    severity: "oc:severity",
    status: "oc:status",
    headline: "schema:headline",
    description: "schema:description",
    label: "schema:name",
    validFrom: "schema:startDate",
    validTo: "schema:endDate",
    dataUpdatedAt: "schema:dateModified",
    provider: "schema:provider",
    license: "schema:license",
    attributionUrl: "schema:url",
    confidence: "oc:confidence",
    metric: "sosa:observedProperty",
    value: "sosa:hasSimpleResult",
    unit: "schema:unitText",
  },
];

/** Per-feature JSON-LD node type by kind. */
function nodeType(kind: unknown): string {
  return kind === "measurement" ? "sosa:Observation" : "schema:SpecialAnnouncement";
}

/**
 * Projects observations to JSON-LD: the GeoJSON FeatureCollection with a
 * SOSA/Schema.org `@context` and a per-feature `@type`/`@id`, so semantic-web,
 * research and search-index consumers can read it as RDF. A lossless superset
 * of the GeoJSON emitter (inherits its full property payload).
 */
export function observationsToJsonLd(
  obs: Observation[],
  info: FeedInfo = {}
): JsonLdFeatureCollection {
  const fc = observationsToGeoJSON(obs, info);
  const features = fc.features.map((f) => {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    return {
      ...f,
      properties: { "@id": props["id"], "@type": nodeType(props["kind"]), ...props },
    };
  });
  return { "@context": CONTEXT, ...fc, features };
}
