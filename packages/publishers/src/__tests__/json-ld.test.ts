import { readFileSync } from "node:fs";
import jsonld from "jsonld";
import { describe, expect, it } from "vitest";
import { featuresToJsonLd } from "../feature-geojson.js";
import { situationsToJsonLd } from "../situation-geojson.js";

type Rec = Record<string, unknown>;

const GEOJSON_LD_CONTEXT = "https://geojson.org/geojson-ld/geojson-context.jsonld";
const pinnedContext: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/geojson-ld/geojson-context.jsonld", import.meta.url), "utf8"),
);

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const GEOJSON = "https://purl.org/geojson/vocab#";
const SCHEMA = "https://schema.org/";
const SOSA = "http://www.w3.org/ns/sosa/";
const OC = "https://openconditions.org/ns#";

/**
 * Converts a document to N-Quads the way any JSON-LD 1.1 processor would,
 * serving the GeoJSON-LD context from the pinned copy and refusing every
 * other remote document. Records every processor event apart from the
 * dropping of keys the context deliberately leaves unmapped.
 */
async function toTriples(doc: unknown): Promise<{ triples: string[]; events: string[] }> {
  const events: string[] = [];
  const options = {
    format: "application/n-quads",
    documentLoader: async (url: string) => {
      if (url !== GEOJSON_LD_CONTEXT) throw new Error(`unexpected remote document ${url}`);
      return { contextUrl: null, documentUrl: url, document: pinnedContext };
    },
    eventHandler: ({ event }: { event: { code: string } }) => {
      if (event.code !== "invalid property") events.push(event.code);
    },
  };
  const nquads = (await jsonld.toRDF(doc as never, options as never)) as unknown as string;
  return { triples: nquads.split("\n").filter(Boolean), events };
}

const literal = (value: string) => JSON.stringify(value);
const subjectsOf = (triples: string[], p: string, o: string) =>
  triples.filter((t) => t.endsWith(` <${p}> ${o} .`)).map((t) => t.slice(0, t.indexOf(" ")));
const typesOf = (triples: string[], s: string) =>
  triples
    .filter((t) => t.startsWith(`<${s}> <${RDF_TYPE}> `))
    .map((t) => t.slice(`<${s}> <${RDF_TYPE}> <`.length, -3))
    .sort();

const situation: Rec = {
  id: "oc:situation:de-autobahn-events:a46",
  class: "situation",
  kind: "roadworks",
  type: "works",
  temporality: "live",
  headline: "A46 closed",
  validity: { status: "active", start: "2026-09-06T08:00:00Z", end: "2026-09-07T08:00:00Z" },
  effects: [
    {
      id: "a46/closure",
      kind: "closure",
      v: 1,
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
      scope: "road",
    },
  ],
  location: {
    geometry: {
      type: "LineString",
      coordinates: [
        [6.805, 51.2],
        [6.818, 51.2],
      ],
    },
  },
  provenance: { sourceUpdatedAt: "2026-09-06T09:00:00Z" },
};

const site: Rec = {
  id: "oc:feature:nl-ndw-sites:RWS01_MONIBAS_0021hrl0403ra",
  class: "feature",
  kind: "measurement_site",
  type: "inductive_loop",
  name: "A2 km 40.3",
  components: [
    { id: "oc:component:nl-ndw-sites:RWS01_MONIBAS_0021hrl0403ra:1", kind: "sensor_channel" },
  ],
  location: { geometry: { type: "Point", coordinates: [4.9, 52.3] } },
};

describe("GeoJSON-LD emitters", () => {
  it("emit situations a JSON-LD processor turns into typed, identified announcements", async () => {
    const doc = situationsToJsonLd([situation], {}, { at: new Date("2026-09-06T10:00:00Z") });
    const { triples, events } = await toTriples(doc);
    const id = `https://openconditions.org/id/${encodeURIComponent(String(situation["id"]))}`;

    expect(events).toEqual([]);
    expect(typesOf(triples, id)).toEqual([`${GEOJSON}Feature`, `${SCHEMA}SpecialAnnouncement`]);
    expect(triples.some((t) => t.startsWith(`<${id}> <${GEOJSON}geometry> _:`))).toBe(true);
    expect(triples.some((t) => t.endsWith(` <${RDF_TYPE}> <${GEOJSON}LineString> .`))).toBe(true);
    // The record's own id and type are literals of its properties, not identities or classes.
    const [props] = subjectsOf(triples, `${OC}type`, literal("works"));
    expect(triples).toContain(`<${id}> <${GEOJSON}properties> ${props} .`);
    expect(triples).toContain(`${props} <${OC}id> ${literal(String(situation["id"]))} .`);
    expect(triples).toContain(`${props} <${SCHEMA}headline> ${literal("A46 closed")} .`);
    const [effect] = subjectsOf(triples, `${OC}id`, literal("a46/closure"));
    expect(triples).toContain(`${props} <${OC}effects> ${effect} .`);
    expect(triples.filter((t) => t.includes(`<${OC}situation:`))).toEqual([]);
  });

  it("emit features a JSON-LD processor turns into typed, identified places and platforms", async () => {
    const { triples, events } = await toTriples(featuresToJsonLd([site]));
    const id = `https://openconditions.org/id/${encodeURIComponent(String(site["id"]))}`;

    expect(events).toEqual([]);
    expect(typesOf(triples, id)).toEqual([
      `${SOSA}Platform`,
      `${GEOJSON}Feature`,
      `${SCHEMA}Place`,
    ]);
    expect(triples.some((t) => t.startsWith(`<${id}> <${GEOJSON}geometry> _:`))).toBe(true);
    expect(triples.some((t) => t.endsWith(` <${RDF_TYPE}> <${GEOJSON}Point> .`))).toBe(true);
    const [props] = subjectsOf(triples, `${OC}type`, literal("inductive_loop"));
    expect(triples).toContain(`<${id}> <${GEOJSON}properties> ${props} .`);
    expect(triples).toContain(`${props} <${SCHEMA}name> ${literal("A2 km 40.3")} .`);
    const [channel] = subjectsOf(triples, `${OC}kind`, literal("sensor_channel"));
    expect(triples).toContain(`${props} <${SOSA}hosts> ${channel} .`);
  });

  it("identify a record whose id holds a lone surrogate rather than fail the collection", () => {
    const lone = { ...situation, id: `oc:situation:test:a${String.fromCharCode(0xd800)}b` };
    expect(situationsToJsonLd([lone]).features[0]!.id).toBe(
      "https://openconditions.org/id/oc%3Asituation%3Atest%3Aa%EF%BF%BDb",
    );
  });

  it("keep each feature valid GeoJSON: type Feature and a string id", () => {
    const [situationFeature] = situationsToJsonLd([situation]).features;
    const [siteFeature] = featuresToJsonLd([site]).features;
    for (const f of [situationFeature, siteFeature]) {
      expect(f?.type).toBe("Feature");
      expect(typeof f?.id).toBe("string");
      expect(f).not.toHaveProperty("@id");
    }
  });
});
