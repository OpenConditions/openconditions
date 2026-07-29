import { describe, expect, it } from "vitest";
import { parseBcnTramsFlow } from "../flow-bcn.js";
import { parseBcnTramsStations } from "../stations-bcn.js";
import type { SiteGeometry } from "../siteTable.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "es-bcn-ajuntament",
  attribution: "Ajuntament de Barcelona",
  country: "ES",
  license: "CC-BY-4.0",
} as SourceDescriptor;

const CSV = `Tram,Tram_Components,Descripció,Longitud,Latitud
1,1,"Diagonal (Ronda de Dalt a Doctor Marañón)",2.11203535639414,41.3841912394771
1,2,"Diagonal (Ronda de Dalt a Doctor Marañón)",2.101502862881051,41.3816307921222
2,1,"Meridiana",2.18,41.42
2,2,"Meridiana",2.19,41.43
9,1,"Single vertex only",2.0,41.0`;

describe("parseBcnTramsStations", () => {
  it("groups vertices per tram (ordered) into LineStrings and drops single-vertex trams", () => {
    const map = parseBcnTramsStations(CSV);
    expect(map.size).toBe(2); // tram 9 has one vertex → dropped
    const geom = map.get("1") as Extract<SiteGeometry, { type: "LineString" }>;
    expect(geom.type).toBe("LineString");
    expect(geom.coordinates).toEqual([
      [2.11203535639414, 41.3841912394771],
      [2.101502862881051, 41.3816307921222],
    ]);
  });
});

describe("parseBcnTramsFlow", () => {
  const siteMap = parseBcnTramsStations(CSV);

  it("joins status rows to geometry and maps the 0-6 scale to level-of-service", () => {
    const dat = ["1#20260729131557#2#2", "2#20260729131557#5#5"].join("\n");
    const { flows, events } = parseBcnTramsFlow(dat, src, siteMap);
    expect(flows).toHaveLength(2);
    const t1 = flows.find((f) => f.id === "es-bcn-ajuntament:1")!;
    expect(t1.los).toBe("free_flow");
    expect(t1.speedKph).toBeUndefined();
    expect(t1.geometry.type).toBe("LineString");
    expect(t1.dataUpdatedAt).toBe("2026-07-29T13:15:57");
    const t2 = flows.find((f) => f.id === "es-bcn-ajuntament:2")!;
    expect(t2.los).toBe("stationary");
    expect(t2.sourceFormat).toBe("bcn-trams");
    // Only the congested (stationary) segment yields a derived congestion event.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("congestion");
  });

  it("skips status 0 (sensor down) and segments with no known geometry", () => {
    const dat = ["1#20260729131557#0#0", "999#20260729131557#3#3"].join("\n");
    const { flows } = parseBcnTramsFlow(dat, src, siteMap);
    expect(flows).toHaveLength(0);
  });

  it("flags a hard parse failure on an empty/garbage body", () => {
    expect(parseBcnTramsFlow("", src, siteMap).failed).toBe(true);
    expect(parseBcnTramsFlow("<html>error</html>", src, siteMap).failed).toBe(true);
  });
});
