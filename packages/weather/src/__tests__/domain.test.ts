import {
  type FeedDefinition,
  feedBaseShape,
  regionFileJsonSchema,
  regionFileSchema,
} from "@openconditions/ingest-framework";
import { WEATHER_SOURCE_FORMATS } from "@openconditions/model-weather";
import { expect, test } from "vitest";
import { WEATHER_PRODUCTS, weatherDomain } from "../domain.js";
import { weatherFeedShape } from "../feed-schema.js";
import { weatherRegistry } from "./helpers/seal.js";
import { catalogFeed, parseContext, weatherCatalogue } from "./helpers/weather-feed.js";

test("weatherDomain registers the digitraffic-weather format over its sites, details and status roles", () => {
  expect(weatherDomain.id).toBe("weather");
  expect(weatherDomain.products).toEqual(["weather"]);
  expect(WEATHER_PRODUCTS).toEqual(weatherDomain.products);
  expect(weatherDomain.feedShape).toBe(weatherFeedShape);
  expect(weatherDomain.resolvers).toEqual([]);
  const format = weatherDomain.formats["digitraffic-weather"]!;
  expect(format).toMatchObject({
    id: "digitraffic-weather",
    kind: "features",
    products: ["weather"],
  });
  expect(format.endpoints).toEqual({
    sites: { required: true },
    details: { required: false },
    status: { required: false, status: true },
  });
  // The latest values poll on their own between the daily station lists.
  expect(format.parseStatus).toBeTypeOf("function");
  for (const [code, f] of Object.entries(weatherDomain.formats)) expect(f.id).toBe(code);
});

test("every format is a source format the weather model contributes, producing the model's kinds and properties", () => {
  const registry = weatherRegistry();
  const formats = registry.vocabulary("source_format")?.values ?? [];
  for (const [id, format] of Object.entries(weatherDomain.formats)) {
    expect(formats).toContain(id);
    expect(WEATHER_SOURCE_FORMATS).toContain(id);
    expect(format.produces?.kinds).toEqual(["weather_station", "sensor_channel"]);
    for (const property of format.produces?.properties ?? []) {
      expect(registry.property(property)?.domain, property).toBe("weather");
    }
  }
});

test("the feed shape is the base shape alone", () => {
  expect(Object.keys(weatherFeedShape).sort()).toEqual(Object.keys(feedBaseShape).sort());
  const feed = {
    operator: "digitraffic",
    product: "weather",
    name: "Digitraffic road weather stations",
    tier: "authoritative",
    format: "digitraffic-weather",
    endpoints: {
      sites: { url: "https://tie.digitraffic.fi/api/weather/v2/stations", cadenceSec: 86400 },
    },
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    attribution: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
    privacyUrl: "https://www.digitraffic.fi/en/privacy-policy/",
  } as FeedDefinition;
  const accepts = (f: object) =>
    regionFileSchema(weatherFeedShape).safeParse({ feeds: [f] }).success;
  expect(accepts(feed)).toBe(true);
  expect(accepts({ ...feed, layout: { lon: "x", lat: "y" } })).toBe(false);
});

test("the Digitraffic feed polls the v2 API with the user and compression headers", () => {
  expect([...weatherCatalogue().keys()]).toEqual(["fi-digitraffic-weather"]);
  const feed = catalogFeed("fi-digitraffic-weather");
  expect(feed).toMatchObject({
    domain: "weather",
    format: "digitraffic-weather",
    license: "CC-BY-4.0",
    attribution: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
  });
  const endpoints = feed.endpoints as Record<
    string,
    { url: string; cadenceSec: number; headers: Record<string, string> }
  >;
  expect(Object.keys(endpoints)).toEqual(["sites", "details", "status"]);
  for (const endpoint of Object.values(endpoints)) {
    expect(endpoint.url).toMatch(/^https:\/\/tie\.digitraffic\.fi\/api\/weather\/v2\//);
    expect(endpoint.headers).toEqual({
      "Digitraffic-User": "OpenConditions/1.0",
      "Accept-Encoding": "gzip",
    });
  }
  expect(endpoints["status"]!.cadenceSec).toBe(300);
});

test("the domain renders its catalogue JSON Schema", () => {
  expect(JSON.stringify(regionFileJsonSchema(weatherDomain))).toContain("freshnessWindowSec");
});

test("a format without a payload parses to nothing", () => {
  const ctx = parseContext("2026-10-14T23:25:19Z");
  for (const format of Object.values(weatherDomain.formats)) {
    const out = format.parse(catalogFeed("fi-digitraffic-weather"), {}, ctx);
    expect(out.situations).toEqual([]);
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
  }
});
