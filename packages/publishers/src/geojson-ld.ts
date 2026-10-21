/** A JSON-LD term definition: an IRI, or an expanded definition. */
export type TermDefinition = string | Readonly<Record<string, string>>;

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
 *
 * Every other field resolves through the OpenConditions vocabulary, so a
 * JSON-LD processor drops nothing. Source token maps, whose keys are data
 * rather than terms, are JSON literals.
 */
export function geoJsonLdContext(terms: Readonly<Record<string, TermDefinition>>): unknown {
  return [
    "https://geojson.org/geojson-ld/geojson-context.jsonld",
    {
      "@vocab": "https://openconditions.org/ns#",
      oc: "https://openconditions.org/ns#",
      sosa: "http://www.w3.org/ns/sosa/",
      schema: "https://schema.org/",
      properties: {
        "@id": "geojson:properties",
        "@context": { id: "oc:id", type: "oc:type" },
      },
      extras: { "@id": "oc:extras", "@type": "@json" },
      sourceTokens: { "@id": "oc:sourceTokens", "@type": "@json" },
      tokens: { "@id": "oc:tokens", "@type": "@json" },
      ...terms,
    },
  ];
}

/** The IRI a record is identified by in GeoJSON-LD. */
export function recordIri(id: unknown): string {
  return `https://openconditions.org/id/${encodeURIComponent(String(id))}`;
}
