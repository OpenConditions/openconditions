/**
 * The `@context` of a GeoJSON-LD collection: the GeoJSON-LD 1.1 base
 * context, then the OpenConditions, schema.org and SOSA terms a record's
 * fields map to.
 *
 * The base context aliases `id` to `@id` and `type` to `@type`, and GeoJSON-LD
 * forbids changing the meaning of its terms, so a feature carries its IRI as
 * its GeoJSON `id` and its classes beyond `Feature` in an explicit `@type`
 * (JSON-LD 1.1 merges the two type entries). A record's own `id` and `type`
 * sit in `properties`, where those aliases would turn a record id into a node
 * identifier and a classification code into a class; the context scoped to
 * `properties` (and the effects and components nested in it) reads them as
 * plain values instead.
 */
export function geoJsonLdContext(terms: Readonly<Record<string, string>>): unknown {
  return [
    "https://geojson.org/geojson-ld/geojson-context.jsonld",
    {
      oc: "https://openconditions.org/ns#",
      sosa: "http://www.w3.org/ns/sosa/",
      schema: "https://schema.org/",
      properties: {
        "@id": "geojson:properties",
        "@context": { id: "oc:id", type: "oc:type" },
      },
      ...terms,
    },
  ];
}

/** The IRI a record is identified by in GeoJSON-LD. */
export function recordIri(id: unknown): string {
  return `https://openconditions.org/id/${encodeURIComponent(String(id))}`;
}
