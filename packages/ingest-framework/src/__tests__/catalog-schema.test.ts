import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  credentialsFileSchema,
  endpointSchema,
  feedAuthSchema,
  feedBaseShape,
  feedTermsSchema,
  regionFileSchema,
} from "../catalog/schema.js";

const feed = {
  operator: "ndw",
  product: "events",
  name: "n",
  format: "datex2",
  tier: "authoritative",
  endpoints: { main: { url: "https://a", cadenceSec: 60 } },
  freshnessWindowSec: 300,
  license: "CC0-1.0",
  attribution: "a",
  privacyUrl: "https://p.example",
};

describe("catalogue schema", () => {
  test("onDemand bounds the cell, ttl, cell count and probe", () => {
    const base = z.object(feedBaseShape).strict();
    const onDemand = { cellDeg: 0.25, ttlSec: 600, maxCellsPerRead: 8, probe: [13.4, 52.5] };
    const parse = (over: object) => base.safeParse({ ...feed, onDemand: { ...onDemand, ...over } });
    expect(parse({}).success).toBe(true);
    expect(parse({ cellDeg: 1 }).success).toBe(true);
    expect(parse({ cellDeg: 0 }).success).toBe(false);
    expect(parse({ cellDeg: 1.5 }).success).toBe(false);
    expect(parse({ ttlSec: 0 }).success).toBe(false);
    expect(parse({ ttlSec: 1.5 }).success).toBe(false);
    expect(parse({ maxCellsPerRead: 0 }).success).toBe(false);
    expect(parse({ maxCellsPerRead: 65 }).success).toBe(false);
    expect(parse({ maxCellsPerRead: 64 }).success).toBe(true);
    expect(parse({ probe: [13.4] }).success).toBe(false);
    expect(parse({ extra: 1 }).success).toBe(false);
  });

  test("an endpoint has exactly one source", () => {
    expect(endpointSchema.safeParse({ cadenceSec: 60 }).success).toBe(false);
    expect(
      endpointSchema.safeParse({ url: "https://a", urls: ["https://b"], cadenceSec: 60 }).success,
    ).toBe(false);
    expect(
      endpointSchema.safeParse({
        reference: { kind: "mobilithek", offerId: "1", fileNamePrefix: "x" },
        cadenceSec: 60,
      }).success,
    ).toBe(false);
    expect(
      endpointSchema.safeParse({
        reference: { kind: "mobilithek", offerId: "1", fileNamePrefix: "x" },
        decoder: "d",
        cadenceSec: 60,
      }).success,
    ).toBe(true);
    expect(endpointSchema.safeParse({ urls: [], cadenceSec: 60 }).success).toBe(false);
  });

  test("fanout needs urls or expand", () => {
    expect(
      endpointSchema.safeParse({ url: "https://a", fanout: "all", cadenceSec: 60 }).success,
    ).toBe(false);
    expect(
      endpointSchema.safeParse({ urls: ["https://a"], fanout: "all", cadenceSec: 60 }).success,
    ).toBe(true);
    expect(
      endpointSchema.safeParse({
        url: "https://a/${x}",
        expand: "x",
        fanout: "tolerant",
        cadenceSec: 60,
      }).success,
    ).toBe(true);
  });

  test("utcDate placeholders name today or one of the seven days before", () => {
    const ok = (url: string) => endpointSchema.safeParse({ url, cadenceSec: 60 }).success;
    expect(ok("https://a/{utcDate}/x/{utcDate}/")).toBe(true);
    expect(ok("https://a/{utcDate-1}/")).toBe(true);
    expect(ok("https://a/{utcDate-7}/")).toBe(true);
    for (const bad of ["{utcDate-8}", "{utcDate-0}", "{utcDate+1}", "{utcDate-}", "{utcDate1}"]) {
      expect(ok(`https://a/${bad}/`)).toBe(false);
    }
    expect(
      endpointSchema.safeParse({
        urls: ["https://a/{utcDate-1}/", "https://a/{utcDate-8}/"],
        cadenceSec: 60,
      }).success,
    ).toBe(false);
  });

  test("unzip takes an entry pattern and an entry bound, and goes with a plain url", () => {
    const parse = (over: object) =>
      endpointSchema.safeParse({ url: "https://a/x.zip", cadenceSec: 60, ...over }).success;
    expect(parse({ unzip: {} })).toBe(true);
    expect(parse({ unzip: { entries: "\\.xml$", maxEntries: 500 } })).toBe(true);
    expect(parse({ unzip: { entries: "(" } })).toBe(false);
    expect(parse({ unzip: { maxEntries: 0 } })).toBe(false);
    expect(parse({ unzip: { other: 1 } })).toBe(false);
    expect(parse({ unzip: {}, pagination: { skipParam: "o", pageSize: 5 } })).toBe(false);
    expect(
      parse({
        url: "https://a/{item}",
        unzip: {},
        each: { role: "s", records: "r", field: "f" },
      }),
    ).toBe(false);
  });

  test("each reads records and a field, or walks links, never both", () => {
    const parse = (each: object, url = "https://a/{item}") =>
      endpointSchema.safeParse({ url, cadenceSec: 60, each: { role: "s", ...each } }).success;
    expect(parse({ records: "features", field: "id" })).toBe(true);
    expect(
      parse({
        records: "features",
        field: "properties.affectedZones",
        pattern: "^https://x/zones/(\\w+/\\w+)$",
        keepSec: 2_592_000,
      }),
    ).toBe(true);
    expect(parse({ links: ['href="([A-Z]{4}/)"', 'href="([^"]+\\.cap)"'] }, "{item}")).toBe(true);
    expect(
      parse(
        { links: ['href="(\\d{2}/)"[^>]*>[^<]*</a>\\s+(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})'] },
        "{item}",
      ),
    ).toBe(true);

    expect(parse({})).toBe(false);
    expect(parse({ records: "features" })).toBe(false);
    expect(parse({ field: "id" })).toBe(false);
    expect(parse({ records: "features", field: "id", links: ["(x)"] }, "{item}")).toBe(false);
    // A walk's URL is the item itself.
    expect(parse({ links: ["(x)"] }, "https://a/{item}")).toBe(false);
    expect(parse({ links: [] }, "{item}")).toBe(false);
    // Every pattern needs its group.
    expect(parse({ links: ["x"] }, "{item}")).toBe(false);
    expect(parse({ links: ["(x"] }, "{item}")).toBe(false);
    expect(parse({ records: "r", field: "f", pattern: "x" })).toBe(false);
    expect(parse({ records: "r", field: "f", pattern: "(x" })).toBe(false);
    // A pattern and a keep belong to listed records, not to a walk.
    expect(parse({ links: ["(x)"], pattern: "(x)" }, "{item}")).toBe(false);
    expect(parse({ links: ["(x)"], keepSec: 60 }, "{item}")).toBe(false);
    expect(parse({ records: "r", field: "f", keepSec: 0 })).toBe(false);
    expect(parse({ records: "r", field: "f", keepSec: 1.5 })).toBe(false);
  });

  test("maxPayloadAgeSec is an endpoint's, a whole number of seconds, at least one", () => {
    const endpoint = (maxPayloadAgeSec: number) =>
      endpointSchema.safeParse({ url: "https://a", cadenceSec: 180, maxPayloadAgeSec }).success;
    expect(endpoint(300)).toBe(true);
    expect(endpoint(1)).toBe(true);
    expect(endpoint(0)).toBe(false);
    expect(endpoint(1.5)).toBe(false);
    // A feed no longer carries it: each role says how old its held answer may be.
    const schema = z.object(feedBaseShape).strict();
    expect(schema.safeParse({ ...feed, maxPayloadAgeSec: 300 }).success).toBe(false);
  });

  test("the old feed fields are rejected", () => {
    const schema = z.object(feedBaseShape).strict();
    expect(schema.safeParse(feed).success).toBe(true);
    for (const old of ["url", "produces", "country", "stream", "requiredEnv", "rights", "setup"]) {
      expect(schema.safeParse({ ...feed, [old]: "x" }).success).toBe(false);
    }
  });

  test("every id token is lower-case alphanumeric, the product too", () => {
    const schema = z.object(feedBaseShape).strict();
    for (const product of ["Flow", "road-events", ""]) {
      expect(schema.safeParse({ ...feed, product }).success).toBe(false);
    }
  });

  test("auth refs are named credentials", () => {
    expect(
      feedAuthSchema.safeParse({ kind: "query-key", param: "k", credential: "api_key" }).success,
    ).toBe(true);
    expect(feedAuthSchema.safeParse({ kind: "query-key", param: "k", envVar: "X" }).success).toBe(
      false,
    );
    expect(feedAuthSchema.safeParse({ kind: "mtls", cert: "@m.cert", key: "@m.key" }).success).toBe(
      true,
    );
  });

  test("terms need a url or a note", () => {
    expect(feedTermsSchema.safeParse({ redistribution: true }).success).toBe(false);
    expect(
      feedTermsSchema.safeParse({ note: "agreed by mail", redistribution: null }).success,
    ).toBe(true);
  });

  test("coverage countries are ISO 3166-1 or ISO 3166-2 codes", () => {
    const schema = z.object(feedBaseShape).strict();
    for (const code of ["DE", "DE-BY", "GB-ENG", "FR-75C", "US-NY"]) {
      expect(schema.safeParse({ ...feed, coverage: { countries: [code] } }).success).toBe(true);
    }
    for (const code of ["de", "DEU", "DE-", "DE-by", "DE-ABCD", "D"]) {
      expect(schema.safeParse({ ...feed, coverage: { countries: [code] } }).success).toBe(false);
    }
  });

  test("snapshot rules carry over", () => {
    const schema = z.object(feedBaseShape).strict();
    expect(
      schema.safeParse({ ...feed, snapshot: { completeness: "complete", totalCountPath: "n" } })
        .success,
    ).toBe(false);
  });

  test("region and credentials files", () => {
    const file = regionFileSchema(feedBaseShape);
    expect(file.safeParse({ feeds: [feed] }).success).toBe(true);
    expect(file.safeParse({ feeds: [{ ...feed, url: "x" }] }).success).toBe(false);
    expect(
      credentialsFileSchema.safeParse({ credentials: { mobilithek: { cert: { title: "Cert" } } } })
        .success,
    ).toBe(true);
    expect(credentialsFileSchema.safeParse({ credentials: { Bad_Group: {} } }).success).toBe(false);
  });
});
