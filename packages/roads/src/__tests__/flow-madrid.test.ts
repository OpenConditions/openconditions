import { describe, expect, it } from "vitest";
import { parseMadridFlow } from "../flow-madrid.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "madrid-informo-es",
  attribution: "Ayuntamiento de Madrid",
  country: "ES",
  license: "CC-BY-4.0",
} as SourceDescriptor;

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

describe("parseMadridFlow", () => {
  it("reprojects UTM→WGS84 points and maps nivelServicio→los", () => {
    const { flows, events } = parseMadridFlow(payload, src);
    // The errored (error=S) point is dropped; two remain.
    expect(flows).toHaveLength(2);

    const congested = flows.find((f) => f.id === "madrid-informo-es:9841")!;
    expect(congested.sourceFormat).toBe("madrid-informo-xml");
    expect(congested.los).toBe("stationary");
    expect(congested.geometry.type).toBe("Point");
    const [lon, lat] = (congested.geometry as { coordinates: number[] }).coordinates;
    expect(lon).toBeGreaterThan(-4);
    expect(lon).toBeLessThan(-3);
    expect(lat).toBeGreaterThan(40);
    expect(lat).toBeLessThan(41);

    const free = flows.find((f) => f.id === "madrid-informo-es:9842")!;
    expect(free.los).toBe("free_flow");

    // Only the stationary point emits a derived congestion event.
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("madrid-informo-es:9841:congestion");
    expect(events[0]!.severity).toBe("critical");
  });

  it("flags a hard parse failure but not a legitimately empty document", () => {
    expect(parseMadridFlow("<html>nope", src).failed).toBe(true);
    expect(parseMadridFlow("<pms></pms>", src)).toEqual({ flows: [], events: [] });
  });
});
