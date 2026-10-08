import {
  type CatalogFile,
  type FeedDefinition,
  feedBaseShape,
  lintCatalog,
  regionFileSchema,
} from "@openconditions/ingest-framework";
import { expect, test } from "vitest";
import { CHARGING_PRODUCTS, chargingDomain } from "../domain.js";
import { chargingFeedShape, chargingMappingSchema } from "../feed-schema.js";
import { chargingCatalogue } from "./helpers/charging-feed.js";

const NOW = new Date("2026-10-06T12:00:00Z");

const ROW = { row: { standard: { field: "plug" } } };

const feed = (over: Record<string, unknown> = {}): FeedDefinition =>
  ({
    subdivision: "vlg",
    operator: "mow",
    product: "charging",
    name: "Flemish charge points",
    tier: "authoritative",
    format: "geojson",
    endpoints: { main: { url: "https://example.org/laadpunten.json", cadenceSec: 86400 } },
    freshnessWindowSec: 172800,
    license: "CC-BY-4.0",
    attribution: "Departement MOW",
    privacyUrl: "https://example.org/privacy",
    layout: {},
    charging: { id: "id", connectors: ROW },
    ...over,
  }) as FeedDefinition;

const file = (feeds: FeedDefinition[]): CatalogFile => ({
  path: "feeds/charging/be.jsonc",
  domain: "charging",
  region: "be",
  maintainers: [],
  $schema: "../schema/charging.schema.json",
  feeds,
});

const lint = (f: FeedDefinition) =>
  lintCatalog([file([f])], { groups: {} }, [chargingDomain], NOW).map((i) => i.message);

test("chargingDomain registers its formats with their roles and what they produce", () => {
  expect(chargingDomain.id).toBe("charging");
  expect(chargingDomain.products).toEqual(["charging"]);
  expect(CHARGING_PRODUCTS).toEqual(["charging"]);
  expect(chargingDomain.feedShape).toBe(chargingFeedShape);
  expect(chargingDomain.resolvers).toEqual([]);
  const main = { main: { required: true } };
  const live = { required: false, status: true };
  expect(
    Object.fromEntries(Object.entries(chargingDomain.formats).map(([id, f]) => [id, f.endpoints])),
  ).toEqual({
    geojson: main,
    json: main,
    csv: main,
    ocpi: {
      main: { required: true },
      status: live,
      tariffs: { required: false },
      associations: { required: false },
      sources: { required: false },
    },
    oicp: { main: { required: true }, status: live },
    datex2: { main: { required: true }, status: live },
    digitraffic: {
      main: { required: true },
      status: live,
      tariffs: { required: false },
    },
    overpass: main,
    bnetza: main,
    irve: { main: { required: true }, status: live },
    afdc: main,
    nobil: main,
    eipa: {
      pools: { required: true },
      stations: { required: true },
      points: { required: true },
      operators: { required: false },
      dictionary: { required: false },
      status: live,
    },
    cynap: main,
    chargy: main,
    evroam: main,
    keco: {
      main: { required: true },
      status: { ...live, accumulatesSince: "main", changesWindowSec: 600 },
    },
    lta: main,
    tdx: { sites: { required: true }, tariffs: { required: false }, status: live },
    ocm: main,
  });
  // Every format with a live status role reads it alone too.
  expect(
    Object.entries(chargingDomain.formats)
      .filter(([, f]) => f.parseStatus !== undefined)
      .map(([id]) => id),
  ).toEqual(["ocpi", "oicp", "datex2", "digitraffic", "irve", "eipa", "keco", "tdx"]);
  for (const [code, format] of Object.entries(chargingDomain.formats)) {
    expect(format.id).toBe(code);
    expect(format.kind).toBe("features");
    expect(format.products).toEqual(["charging"]);
    expect(format.produces).toEqual({
      kinds: ["charging_site", "evse", "connector", "energy_tariff"],
      properties: ["charging.evse_status", "charging.connector_status"],
    });
  }
});

test("the feed shape is the base shape plus the layout and charging blocks", () => {
  for (const key of Object.keys(feedBaseShape)) expect(chargingFeedShape).toHaveProperty(key);
  const schema = regionFileSchema(chargingFeedShape);
  expect(schema.safeParse({ feeds: [feed()] }).success).toBe(true);
  const charging = (mapping: Record<string, unknown>) =>
    schema.safeParse({ feeds: [feed({ charging: { id: "id", ...mapping } })] }).success;
  // Strict, with the closed vocabularies in its maps.
  expect(charging({ connectors: ROW, colour: "red" })).toBe(false);
  expect(
    charging({ connectors: { row: { standard: { field: "plug", map: { T2: "TYPE_TWO" } } } } }),
  ).toBe(false);
  expect(charging({ connectors: ROW, audience: { field: "a", map: { x: "everyone" } } })).toBe(
    false,
  );
  // Exactly one way to read connectors.
  expect(charging({})).toBe(false);
  expect(
    charging({
      connectors: { ...ROW, columns: [{ count: "n", standard: "IEC_62196_T2" }] },
    }),
  ).toBe(false);
  expect(
    charging({
      connectors: { list: { field: "plugs", separator: ",", pattern: "(?<type>.+" } },
    }),
  ).toBe(false);
  expect(
    charging({
      connectors: { columns: [{ count: "n", standard: "IEC_62196_T2", powerKw: -1 }] },
    }),
  ).toBe(false);
  // Charger groups only carry a list of connectors, and a plug count is never a charger count.
  const groups = { field: "chargers", separator: ",", pattern: "(?<power>.+)" };
  const plugs = { field: "plugs", separator: ",", pattern: "(?<type>.+)" };
  expect(charging({ connectors: { list: { ...plugs, as: "connectors", groups } } })).toBe(true);
  expect(charging({ connectors: { list: { ...plugs, groups } } })).toBe(false);
  expect(charging({ connectors: { list: { ...plugs, count: "n" } } })).toBe(false);
});

test("every catalogue feed in a layout passes the mapping schema", () => {
  const layouts = [...chargingCatalogue().values()].filter((f) =>
    ["geojson", "json", "csv"].includes(f.format),
  );
  expect(layouts.length).toBeGreaterThanOrEqual(5);
  for (const f of layouts) expect(chargingMappingSchema.safeParse(f.charging).success).toBe(true);
});

test("a layout feed with its charging mapping and layout block is clean", () => {
  expect(lint(feed())).toEqual([]);
});

test("a layout feed without a charging mapping is a lint issue", () => {
  expect(lint(feed({ charging: undefined }))).toEqual([
    expect.stringMatching(/format geojson needs a charging mapping/),
  ]);
  expect(lint(feed({ layout: undefined }))).toEqual([
    expect.stringMatching(/format geojson needs a layout block/),
  ]);
});

test("a format without a payload parses to nothing", () => {
  const ctx = { fetchedAt: "2026-10-06T06:00:00Z", cadenceSec: 300, reference: {} };
  for (const format of Object.values(chargingDomain.formats)) {
    const out = format.parse({} as never, {}, ctx);
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
  }
});
