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

/** Serves the GeoJSON-LD context from the pinned copy and refuses every other remote document. */
const documentLoader = async (url: string) => {
  if (url !== GEOJSON_LD_CONTEXT) throw new Error(`unexpected remote document ${url}`);
  return { contextUrl: null, documentUrl: url, document: pinnedContext };
};

/**
 * Converts a document to N-Quads the way any JSON-LD 1.1 processor would.
 * Records every processor event, including any key it had to drop.
 */
async function toTriples(doc: unknown): Promise<{ triples: string[]; events: string[] }> {
  const events: string[] = [];
  const options = {
    format: "application/n-quads",
    documentLoader,
    eventHandler: ({ event }: { event: { code: string } }) => {
      events.push(event.code);
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

/** A situation using every part of the record a source can fill. */
const fullSituation: Rec = {
  ...situation,
  id: "oc:situation:de-autobahn-events:a46/full#1",
  subtype: "maintenance",
  certainty: "observed",
  severity: { label: "major", source: "derived" },
  headline: [
    { lang: "de", text: "A46 gesperrt – Düsseldorf ↔ Wuppertal" },
    { lang: "en", text: "A46 closed" },
  ],
  description: [{ lang: "de", text: 'Zeile eins\nZeile zwei\r\n"Anführung" <b>&</b> 🚧' }],
  effects: [
    {
      ...(situation["effects"] as Rec[])[0],
      sourceRecordRef: "SR1/v3",
      direction: { value: "positive", basis: "alert_c" },
      laneScope: [{ index: 1, position: "left" }],
      issues: [
        {
          code: "unresolved_lane",
          sourcePath: "/situationRecord/0/lanes",
          sourceTokens: { "datex:lane": "lane1", "with space": [1, [2, 3]], "@odd": null },
        },
      ],
      source: { path: "/situationRecord/0", tokens: { "": "empty key", "a:b": { c: true } } },
    },
    {
      id: "a46/speed",
      kind: "speed_limit",
      v: 1,
      limit: { value: 60, unit: "km/h" },
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
      validity: { status: "planned", start: "2026-09-08T00:00:00Z", end: "2026-09-09T00:00:00Z" },
    },
  ],
  location: {
    geometry: (situation["location"] as Rec)["geometry"],
    direction: { value: "both", basis: "text", text: "beide Richtungen" },
    roads: [{ ref: "A 46", name: [{ lang: "de", text: "Autobahn 46" }], class: "motorway" }],
    description: "AK Düsseldorf-Süd – AS Erkrath",
  },
  externalIds: [{ scheme: "datex_situation", id: "SIT-1", authority: "autobahn.de" }],
  relations: [{ type: "related", target: "oc:situation:de-autobahn-events:a3" }],
  extras: { "datex:situationVersion": "7", nested: [[1, 2], { "@id": "not a node" }] },
  provenance: {
    sourceUpdatedAt: "2026-09-06T09:00:00Z",
    sourceUri: "https://verkehr.autobahn.de/o/autobahn/A46",
    attribution: { provider: "Autobahn GmbH", license: "DL-DE-BY-2.0" },
  },
  freshness: { fetchedAt: "2026-09-06T09:30:00Z", expiresAt: "2026-09-07T08:00:00Z" },
  evidence: {
    state: "corroborated",
    confidenceScore: 0.75,
    routingEligible: true,
    corroborations: 2,
  },
  contentHash: "a".repeat(64),
  revision: 3,
  recordedAt: "2026-09-06T09:31:00.123Z",
};

const fullSite: Rec = {
  ...site,
  lifecycle: "active",
  description: [{ lang: "nl", text: "Meetlocatie" }],
  operator: { role: "operator", name: [{ lang: "nl", text: "Rijkswaterstaat" }] },
  address: { street: "Rijksweg 2", locality: "Amsterdam", country: "NL" },
  openingHours: "24/7",
  externalIds: [{ scheme: "ndw_site", id: "RWS01_MONIBAS_0021hrl0403ra" }],
  components: [
    {
      id: "oc:component:nl-ndw-sites:RWS01_MONIBAS_0021hrl0403ra:1",
      kind: "sensor_channel",
      type: "flow",
      extras: { "ndw:lane": 1 },
    },
  ],
  provenance: { sourceUpdatedAt: "2026-09-06T09:00:00Z" },
  recordedAt: "2026-09-06T09:31:00Z",
};

const AT = new Date("2026-09-06T10:00:00Z");
const INFO = {
  attribution: "OpenConditions",
  license: "ODbL-1.0",
  url: "https://openconditions.org",
  timestamp: "2026-09-06T10:00:00Z",
};

const documents: [string, () => unknown][] = [
  ["situations", () => situationsToJsonLd([situation, fullSituation], INFO, { at: AT, next: "c" })],
  ["features", () => featuresToJsonLd([site, fullSite], INFO, { next: null })],
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Every key path and leaf value of a document, arrays read through: the
 * shape a JSON-LD round trip must preserve. JSON-LD has no null value and
 * merges `@type` into the `type` alias, so nulls are skipped and `@type` reads
 * as `type`.
 */
function shape(value: Json, path = "", out = new Set<string>()): Set<string> {
  if (value === null) return out;
  if (Array.isArray(value)) {
    for (const item of value) shape(item, path, out);
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "@context" || item === null) continue;
      const step = `${path}/${key === "@type" ? "type" : key}`;
      out.add(step);
      shape(item, step, out);
    }
  } else {
    out.add(`${path}=${JSON.stringify(value)}`);
  }
  return out;
}

/** Every non-keyword key and every `@type` value of an expanded document. */
function expandedTerms(value: Json, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) expandedTerms(item, out);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "@type" && !(typeof value["@value"] !== "undefined")) {
        for (const t of Array.isArray(item) ? item : [item]) out.push(String(t));
      } else if (!key.startsWith("@")) out.push(key);
      // A JSON literal's value is data, not JSON-LD.
      if (key !== "@value") expandedTerms(item, out);
    }
  }
  return out;
}

describe("GeoJSON-LD through a JSON-LD 1.1 processor (jsonld.js)", () => {
  it.each(documents)("expands %s in safe mode, mapping every key to an IRI", async (_, make) => {
    const doc = make();
    const events: unknown[] = [];
    const loaded: string[] = [];
    const expanded = (await jsonld.expand(
      doc as never,
      {
        safe: true,
        documentLoader: async (url: string) => {
          loaded.push(url);
          return documentLoader(url);
        },
        eventHandler: ({ event }: { event: unknown }) => {
          events.push(event);
        },
      } as never,
    )) as unknown as Json;
    expect(events).toEqual([]);
    expect(loaded).toEqual([GEOJSON_LD_CONTEXT]);
    const terms = expandedTerms(expanded);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.filter((t) => !/^https?:\/\/[^\s]+$/.test(t))).toEqual([]);
  });

  it.each(documents)(
    "compacts %s back to every key and value it was written with",
    async (_, make) => {
      const doc = make() as Rec;
      const options = { safe: true, documentLoader } as unknown as jsonld.Options.Compact;
      const expanded = await jsonld.expand(doc as never, options);
      const compacted = await jsonld.compact(expanded, doc["@context"] as never, options);
      expect(shape(compacted as unknown as Json)).toEqual(shape(doc as Json));
      // And the compacted form expands to the same graph again.
      expect(await jsonld.expand(compacted, options)).toEqual(expanded);
    },
  );

  it.each(documents)(
    "converts %s to RDF and back to the same canonical dataset",
    async (_, make) => {
      const doc = make();
      const events: unknown[] = [];
      const options = {
        safe: true,
        documentLoader,
        eventHandler: ({ event }: { event: unknown }) => {
          events.push(event);
        },
      };
      const nquads = (await jsonld.toRDF(
        doc as never,
        {
          ...options,
          format: "application/n-quads",
        } as never,
      )) as unknown as string;
      expect(events).toEqual([]);
      expect(nquads.length).toBeGreaterThan(0);
      const fromRdf = await jsonld.fromRDF(nquads as never, { format: "application/n-quads" });
      const canonical = (input: unknown) =>
        jsonld.canonize(
          input as never,
          {
            ...options,
            algorithm: "RDFC-1.0",
            format: "application/n-quads",
          } as never,
        );
      expect(await canonical(fromRdf)).toBe(await canonical(doc));
    },
  );

  it("keeps source token maps as JSON literals instead of inventing terms from their keys", async () => {
    const doc = situationsToJsonLd([fullSituation], {}, { at: AT });
    const { triples, events } = await toTriples(doc);
    expect(events).toEqual([]);
    const json = "<http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON>";
    expect(triples.filter((t) => t.includes(`<${OC}extras>`))).toEqual([
      expect.stringMatching(new RegExp(`${json} \\.$`)),
    ]);
    expect(triples.some((t) => t.includes(`<${OC}datex:situationVersion>`))).toBe(false);
  });

  it("indexes effect states by the effect they describe", async () => {
    const doc = situationsToJsonLd([fullSituation], {}, { at: AT });
    const { triples } = await toTriples(doc);
    const [state] = subjectsOf(triples, `${OC}effect`, literal("a46/speed"));
    expect(state).toBeDefined();
    expect(triples.some((t) => t.endsWith(` <${OC}effectStates> ${state} .`))).toBe(true);
    expect(triples).toContain(`${state} <${OC}state> ${literal("scheduled")} .`);
    expect(triples.some((t) => t.includes(`<${OC}a46/speed>`))).toBe(false);
  });
});
