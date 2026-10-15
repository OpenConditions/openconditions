import { feedBaseShape } from "@openconditions/ingest-framework";
import { expect, test } from "vitest";
import { BORDER_PRODUCTS, borderDomain } from "../domain.js";
import { borderCatalogue } from "./helpers/border-feed.js";

test("borderDomain registers both formats with what they produce", () => {
  expect(borderDomain.id).toBe("border");
  expect(BORDER_PRODUCTS).toEqual(["waits"]);
  expect(borderDomain.feedShape).toEqual(feedBaseShape);
  expect(borderDomain.resolvers).toEqual([]);
  expect(Object.keys(borderDomain.formats).sort()).toEqual(["cbp-bwt", "cbsa-bwt"]);
  for (const [code, format] of Object.entries(borderDomain.formats)) {
    expect(format.id).toBe(code);
    expect(format.kind).toBe("features");
    expect(format.products).toEqual(["waits"]);
    expect(format.endpoints).toEqual({ main: { required: true } });
    expect(format.produces).toEqual({
      kinds: ["border_crossing", "lane_group"],
      properties: ["border.wait", "facility.open_status"],
    });
  }
});

test("a format without a payload parses to nothing", () => {
  const ctx = { fetchedAt: "2026-10-14T23:40:00Z", cadenceSec: 900, reference: {} };
  for (const format of Object.values(borderDomain.formats)) {
    const out = format.parse({} as never, {}, ctx);
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
  }
});

test("the catalogue holds one feed per agency, each in its format", () => {
  const feeds = [...borderCatalogue().values()].map((f) => [f.id, f.format, f.license]);
  expect(feeds.sort()).toEqual([
    ["ca-cbsa-waits", "cbsa-bwt", "OGL-Canada-2.0"],
    ["us-cbp-waits", "cbp-bwt", "LicenseRef-US-Gov-Public-Domain"],
  ]);
});
