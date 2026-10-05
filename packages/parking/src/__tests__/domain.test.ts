import {
  type CatalogFile,
  type FeedDefinition,
  feedBaseShape,
  lintCatalog,
  regionFileSchema,
} from "@openconditions/ingest-framework";
import { expect, test } from "vitest";
import { PARKING_PRODUCTS, parkingDomain } from "../domain.js";
import { parkingFeedShape } from "../feed-schema.js";

const NOW = new Date("2026-10-05T12:00:00Z");

const feed = (over: Record<string, unknown> = {}): FeedDefinition =>
  ({
    subdivision: "bs",
    operator: "basel",
    product: "parking",
    name: "Basel car parks",
    tier: "authoritative",
    format: "geojson",
    endpoints: { main: { url: "https://data.bs.ch/parking.geojson", cadenceSec: 300 } },
    freshnessWindowSec: 3600,
    license: "CC-BY-4.0",
    attribution: "Parkhäuser Basel-Stadt",
    privacyUrl: "https://data.bs.ch/terms/privacy-policy/",
    layout: {},
    parking: { id: "id" },
    ...over,
  }) as FeedDefinition;

const file = (feeds: FeedDefinition[]): CatalogFile => ({
  path: "feeds/parking/ch.jsonc",
  domain: "parking",
  region: "ch",
  maintainers: [],
  $schema: "../schema/parking.schema.json",
  feeds,
});

const lint = (f: FeedDefinition) =>
  lintCatalog([file([f])], { groups: {} }, [parkingDomain], NOW).map((i) => i.message);

test("parkingDomain registers every format with produces", () => {
  expect(parkingDomain.id).toBe("parking");
  expect(parkingDomain.products).toEqual(["parking"]);
  expect(PARKING_PRODUCTS).toEqual(["parking"]);
  expect(parkingDomain.feedShape).toBe(parkingFeedShape);
  expect(parkingDomain.resolvers).toEqual([]);
  expect(Object.keys(parkingDomain.formats).sort()).toEqual([
    "csv",
    "datex2",
    "datex2-light",
    "db-bahnpark",
    "geojson",
    "hdb",
    "json",
    "opendatahub",
    "overpass",
    "parkapi-v3",
    "rdw",
    "sbb",
    "tfnsw",
    "utmc",
  ]);
  const liveSites = { sites: { required: true }, status: { required: true } };
  const roles: Record<string, unknown> = {
    datex2: liveSites,
    hdb: liveSites,
    opendatahub: liveSites,
    utmc: liveSites,
    "parkapi-v3": { main: { required: true }, sources: { required: true } },
    rdw: { specs: { required: true }, areas: { required: true } },
  };
  for (const [code, format] of Object.entries(parkingDomain.formats)) {
    expect(format.id).toBe(code);
    expect(format.kind).toBe("features");
    expect(format.products).toEqual(["parking"]);
    expect(format.endpoints).toEqual(roles[code] ?? { main: { required: true } });
    expect(format.produces).toEqual({
      kinds: ["parking_site", "parking_rate"],
      properties: [
        "parking.available",
        "parking.occupied",
        "parking.occupancy_pct",
        "parking.status",
        "parking.trend",
      ],
    });
  }
});

test("the feed shape is the base shape plus the layout and parking blocks", () => {
  for (const key of Object.keys(feedBaseShape)) expect(parkingFeedShape).toHaveProperty(key);
  const schema = regionFileSchema(parkingFeedShape);
  expect(schema.safeParse({ feeds: [feed()] }).success).toBe(true);
  // The mapping is strict and its maps hold the closed vocabularies.
  expect(
    schema.safeParse({ feeds: [feed({ parking: { id: "id", colour: "red" } })] }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      feeds: [feed({ parking: { id: "id", status: { field: "s", map: { a: "half_full" } } } })],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ feeds: [feed({ parking: { id: { field: "x", pattern: "(" } } })] }).success,
  ).toBe(false);
});

test("a layout feed with its parking mapping and layout block is clean", () => {
  expect(lint(feed())).toEqual([]);
});

test("a layout feed without a parking mapping is a lint issue", () => {
  expect(lint(feed({ parking: undefined }))).toEqual([
    expect.stringMatching(/format geojson needs a parking mapping/),
  ]);
  expect(lint(feed({ layout: undefined }))).toEqual([
    expect.stringMatching(/format geojson needs a layout block/),
  ]);
});

test("a format without a payload parses to nothing", () => {
  const ctx = { fetchedAt: "2026-10-05T06:00:00Z", cadenceSec: 300, reference: {} };
  for (const format of Object.values(parkingDomain.formats)) {
    const out = format.parse({} as never, {}, ctx);
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
  }
});
