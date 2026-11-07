import { readFileSync } from "node:fs";
import type { CatalogFeed } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { acquireGeonet } from "../pipeline/geonet.js";

const AT = "2026-11-07T12:00:00Z";
const feed = {
  id: "nz-geonet-quakes",
  format: "geonet",
  attribution: "GeoNet",
  license: "LicenseRef-CC-BY-3.0-NZ",
} as CatalogFeed;
const history = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/hazards/src/__tests__/fixtures/geonet/history.geojson",
      import.meta.url,
    ),
    "utf8",
  ),
);
const empty = () => new Response('{"type":"FeatureCollection","features":[]}');

describe("GeoNet acquisition resource and completeness bounds", () => {
  it("refuses event fanout overflow instead of silently cutting a snapshot", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: Array.from({ length: 513 }, (_, i) => ({
            properties: { publicID: String(10000 + i) },
          })),
        }),
      )) as typeof fetch;
    await expect(acquireGeonet(feed, fetcher, AT, [])).rejects.toThrow("event budget");
  });
  it("refuses an unsplittable 413 in bounded calls", async () => {
    let count = 0;
    const fetcher = (async () =>
      ++count === 1 ? empty() : new Response(null, { status: 413 })) as typeof fetch;
    await expect(acquireGeonet(feed, fetcher, AT, [])).rejects.toThrow("minimum partition");
    expect(count).toBeLessThan(20);
  });
  it("caps bytes while reading the body", async () => {
    const fetcher = (async () => new Response("x".repeat(8_000_001))) as typeof fetch;
    await expect(acquireGeonet(feed, fetcher, AT, [])).rejects.toThrow("byte budget");
  });
  it("a missing history preserves an honest absent source clock", async () => {
    const f = structuredClone(history.features[0]);
    delete f.properties.modificationTime;
    const fetcher = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.hostname === "service.geonet.org.nz") return new Response(null, { status: 204 });
      if (u.pathname.includes("/history/")) return empty();
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [f] }));
    }) as typeof fetch;
    const result = await acquireGeonet(feed, fetcher, AT, []);
    expect(result.drafts).toHaveLength(1);
    expect(result.terminal).toEqual([]);
    expect(result.drafts[0]).not.toHaveProperty("provenance.sourceUpdatedAt");
    expect(result.drafts[0]).not.toHaveProperty("details.magnitude");
  });
});
