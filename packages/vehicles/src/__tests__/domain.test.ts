import {
  feedBaseShape,
  lintCatalog,
  readCatalogDir,
  regionFileJsonSchema,
  regionFileSchema,
} from "@openconditions/ingest-framework";
import { expect, test } from "vitest";
import { VEHICLES_PRODUCTS, vehiclesDomain } from "../domain.js";
import { vehiclesFeedShape } from "../feed-schema.js";
import { vehiclesRegistry } from "./helpers/seal.js";
import { FEEDS_DIR, vehiclesCatalogue } from "./helpers/vehicles-feed.js";

const NOW = new Date("2026-10-15T00:00:00Z");

test("vehiclesDomain registers the Digitraffic maintenance tracking, which may answer with no vehicle", () => {
  expect(vehiclesDomain.id).toBe("vehicles");
  expect(vehiclesDomain.products).toEqual(["maintenance"]);
  expect(VEHICLES_PRODUCTS).toEqual(["maintenance"]);
  expect(vehiclesDomain.feedShape).toBe(vehiclesFeedShape);
  expect(vehiclesDomain.resolvers).toEqual([]);
  expect(Object.keys(vehiclesDomain.formats)).toEqual(["digitraffic"]);
  expect(vehiclesDomain.formats["digitraffic"]).toMatchObject({
    id: "digitraffic",
    kind: "measurements",
    products: ["maintenance"],
    mayBeEmpty: true,
    endpoints: { main: { required: true } },
  });
});

test("every format is a source format the model knows", () => {
  const formats = vehiclesRegistry().vocabulary("source_format")?.values ?? [];
  for (const id of Object.keys(vehiclesDomain.formats)) expect(formats).toContain(id);
});

test("the feed shape is the base shape alone, and strict", () => {
  expect(Object.keys(vehiclesFeedShape).sort()).toEqual(Object.keys(feedBaseShape).sort());
  const { file } = vehiclesCatalogue().get("fi-digitraffic-maintenance")!;
  const [definition] = readCatalogDir(FEEDS_DIR, [vehiclesDomain], {
    otherDomains: "ignore",
  }).files.find((f) => f.path === file)!.feeds;
  const accepts = (feed: unknown) =>
    regionFileSchema(vehiclesFeedShape).safeParse({ feeds: [feed] }).success;
  expect(accepts(definition)).toBe(true);
  expect(accepts({ ...definition, layout: { lon: "x", lat: "y" } })).toBe(false);
});

test("the catalogue's vehicles feeds lint clean", () => {
  const catalog = readCatalogDir(FEEDS_DIR, [vehiclesDomain], { otherDomains: "ignore" });
  expect(catalog.files.map((f) => f.region)).toEqual(["fi"]);
  expect([...vehiclesCatalogue().keys()]).toEqual(["fi-digitraffic-maintenance"]);
  expect(lintCatalog(catalog.files, { groups: {} }, [vehiclesDomain], NOW)).toEqual([]);
});

test("the domain renders its catalogue JSON Schema", () => {
  const schema = JSON.stringify(regionFileJsonSchema(vehiclesDomain));
  expect(schema).toContain("extrasAllow");
});

test("a format without a payload parses to nothing", () => {
  const ctx = { fetchedAt: "2026-10-14T23:24:56Z", cadenceSec: 60, reference: {} };
  for (const format of Object.values(vehiclesDomain.formats)) {
    const out = format.parse({} as never, {}, ctx);
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
  }
});
