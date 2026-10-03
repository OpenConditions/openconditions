import { describe, expect, it } from "vitest";
import { flowFeed, flows, site, siteIds, value } from "./flow-fixtures.js";

const FEED = "es-madrid";
const feed = flowFeed(FEED);

// Coordinates are ETRS89 / UTM 30N (EPSG:25830) with comma decimals, as the
// live pm.xml publishes them; they reproject to central Madrid (~-3.7°, 40.4°).
const payload = `<?xml version="1.0" encoding="UTF-8"?>
<pms>
  <pm>
    <idelem>9841</idelem>
    <nivelServicio>3</nivelServicio>
    <intensidad>840</intensidad>
    <error>N</error>
    <st_x>440000,5</st_x>
    <st_y>4474000,25</st_y>
  </pm>
  <pm>
    <idelem>9842</idelem>
    <nivelServicio>0</nivelServicio>
    <error>N</error>
    <st_x>441000</st_x>
    <st_y>4475000</st_y>
  </pm>
  <pm>
    <idelem>9843</idelem>
    <nivelServicio>2</nivelServicio>
    <error>S</error>
    <st_x>441000</st_x>
    <st_y>4475000</st_y>
  </pm>
</pms>`;

describe("Madrid INFORMO", () => {
  it("reprojects UTM→WGS84 points and states nivelServicio as the level of service", () => {
    const out = flows(feed, payload);
    // The errored (error=S) point is dropped; two remain.
    expect(siteIds(out, FEED)).toEqual(["9841", "9842"]);
    expect(value(out, FEED, "9841", "traffic.los")).toBe("stationary");
    const geometry = (
      site(out, FEED, "9841")!["location"] as { geometry: { type: string; coordinates: number[] } }
    ).geometry;
    expect(geometry.type).toBe("Point");
    const [lon, lat] = geometry.coordinates;
    expect(lon).toBeGreaterThan(-4);
    expect(lon).toBeLessThan(-3);
    expect(lat).toBeGreaterThan(40);
    expect(lat).toBeLessThan(41);
    expect(value(out, FEED, "9842", "traffic.los")).toBe("free_flow");
    // Only the stationary point derives a congestion situation.
    expect(out.situations.map((s) => s["id"])).toEqual([`oc:situation:${FEED}:9841:congestion`]);
  });

  it("refuses an unreadable body but reads an empty document as an empty cycle", () => {
    expect(() => flows(feed, "<html>nope")).toThrow("hard parse failure");
    expect(flows(feed, "<pms></pms>")).toEqual({ features: [], observations: [], situations: [] });
  });
});
