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
