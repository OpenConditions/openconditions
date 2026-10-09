import {
  type FeedDefinition,
  feedBaseShape,
  regionFileJsonSchema,
  regionFileSchema,
} from "@openconditions/ingest-framework";
import { buildRegistry, kernelModule } from "@openconditions/model";
import { HAZARDS_SOURCE_FORMATS, hazardsModule } from "@openconditions/model-hazards";
import { expect, test } from "vitest";
import { HAZARDS_PRODUCTS, hazardsDomain } from "../domain.js";
import { hazardsFeedShape } from "../feed-schema.js";
import { dwdFeed, ecccFeed, hazardsCatalogue } from "./helpers/hazards-feed.js";

test("hazardsDomain registers the cap format over its alerts, index and areas roles", () => {
  expect(hazardsDomain.id).toBe("hazards");
  expect(hazardsDomain.products).toEqual(["alerts", "fires", "smoke", "quakes", "events"]);
  expect(HAZARDS_PRODUCTS).toEqual(hazardsDomain.products);
  expect(hazardsDomain.feedShape).toBe(hazardsFeedShape);
  expect(hazardsDomain.resolvers).toEqual([]);
  const cap = hazardsDomain.formats["cap"]!;
  expect(cap).toMatchObject({ id: "cap", kind: "situations", products: ["alerts"] });
  expect(cap.endpoints).toEqual({
    alerts: { required: true },
    index: { required: false },
    areas: { required: false },
  });
  for (const [code, format] of Object.entries(hazardsDomain.formats)) expect(format.id).toBe(code);
});

test("every format is a source format the hazards model contributes", () => {
  const registry = buildRegistry([kernelModule, hazardsModule]);
  const formats = registry.vocabulary("source_format")?.values ?? [];
  for (const id of Object.keys(hazardsDomain.formats)) {
    expect(formats).toContain(id);
    expect(HAZARDS_SOURCE_FORMATS).toContain(id);
  }
});

test("the feed shape is the base shape alone", () => {
  expect(Object.keys(hazardsFeedShape).sort()).toEqual(Object.keys(feedBaseShape).sort());
  const feed = {
    operator: "dwd",
    product: "alerts",
    name: "DWD weather warnings",
    tier: "authoritative",
    format: "cap",
    endpoints: { alerts: { url: "https://opendata.dwd.de/a.zip", cadenceSec: 300 } },
    freshnessWindowSec: 1800,
    license: "CC-BY-4.0",
    attribution: "Deutscher Wetterdienst",
    privacyUrl: "https://www.dwd.de/privacy",
  } as FeedDefinition;
  const accepts = (f: object) =>
    regionFileSchema(hazardsFeedShape).safeParse({ feeds: [f] }).success;
  expect(accepts(feed)).toBe(true);
  expect(accepts({ ...feed, layout: { lon: "x", lat: "y" } })).toBe(false);
});

test("the DWD and ECCC feeds are valid hazards feeds", () => {
  expect(dwdFeed().id).toBe("de-dwd-alerts");
  expect(ecccFeed().id).toBe("ca-eccc-alerts");
  // The walk's first endpoint is a URL, so the feed has a homepage.
  expect(ecccFeed().homepage).toBe("https://dd.weather.gc.ca");
});

test("every catalogue feed passes the domain's lint", () => {
  for (const f of hazardsCatalogue().values()) {
    expect(hazardsDomain.lintFeed?.(f as unknown as FeedDefinition) ?? [], f.id).toEqual([]);
  }
});

test("the domain renders its catalogue JSON Schema", () => {
  expect(JSON.stringify(regionFileJsonSchema(hazardsDomain))).toContain("freshnessWindowSec");
});

test("a format without a payload parses to nothing, and a situations format says so in its accounting", () => {
  const ctx = { fetchedAt: "2026-10-08T22:00:00Z", cadenceSec: 300, reference: {} };
  for (const format of Object.values(hazardsDomain.formats)) {
    const out = format.parse(dwdFeed(), {}, ctx);
    expect(out.situations).toEqual([]);
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
    if (format.kind === "situations") {
      expect(out.records, format.id).toMatchObject({ inputCount: 0, accepted: 0, terminal: 0 });
    }
  }
});
