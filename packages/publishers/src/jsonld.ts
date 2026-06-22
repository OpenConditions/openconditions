import type { Observation } from "@openconditions/core";
import { type ConditionsFeatureCollection, observationsToGeoJSON } from "./geojson.js";
import type { FeedInfo } from "./types.js";

export type JsonLdFeatureCollection = ConditionsFeatureCollection & { "@context": unknown };

/** GeoJSON-LD base context + SOSA/Schema.org terms — makes the GeoJSON RDF-compatible. */
const CONTEXT: unknown = [
  "https://geojson.org/geojson-ld/geojson-context.jsonld",
  {
    oc: "https://openconditions.org/ns#",
    sosa: "http://www.w3.org/ns/sosa/",
    schema: "https://schema.org/",
    type: "oc:conditionType",
    severity: "oc:severity",
    headline: "schema:headline",
    description: "schema:description",
    validFrom: "schema:validFrom",
    validTo: "schema:validThrough",
  },
];

/**
 * Projects observations to JSON-LD: the GeoJSON FeatureCollection with a
 * SOSA/Schema.org `@context`, so semantic-web + research consumers can read it
 * as RDF for free. A cheap, lossless superset of the GeoJSON emitter.
 */
export function observationsToJsonLd(
  obs: Observation[],
  info: FeedInfo = {}
): JsonLdFeatureCollection {
  return { "@context": CONTEXT, ...observationsToGeoJSON(obs, info) };
}
