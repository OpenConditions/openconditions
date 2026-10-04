import { feedBaseShape } from "@openconditions/ingest-framework";
import { expect, test } from "vitest";
import { FUEL_PRODUCTS, fuelDomain } from "../domain.js";

test("fuelDomain registers every format with produces", () => {
  expect(fuelDomain.id).toBe("fuel");
  expect(fuelDomain.products).toEqual(["fuel"]);
  expect(FUEL_PRODUCTS).toEqual(["fuel"]);
  expect(fuelDomain.feedShape).toBe(feedBaseShape);
  expect(fuelDomain.resolvers).toEqual([]);
  expect(Object.keys(fuelDomain.formats).sort()).toEqual([
    "econtrol",
    "minetur",
    "overpass",
    "prix-carburants",
    "tankerkoenig",
  ]);
  for (const [code, format] of Object.entries(fuelDomain.formats)) {
    expect(format.id).toBe(code);
    expect(format.kind).toBe("features");
    expect(format.products).toEqual(["fuel"]);
    expect(format.endpoints).toEqual({ main: { required: true } });
    expect(format.produces).toEqual({
      kinds: ["fuel_station"],
      properties: ["fuel.price", "fuel.product_available"],
    });
  }
});

test("a format without a payload parses to nothing", () => {
  const ctx = { fetchedAt: "2026-10-03T22:00:00Z", cadenceSec: 900, reference: {} };
  for (const format of Object.values(fuelDomain.formats)) {
    const out = format.parse({} as never, {}, ctx);
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
  }
});
