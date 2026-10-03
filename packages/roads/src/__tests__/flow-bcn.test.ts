import { describe, expect, it } from "vitest";
import { parseBcnTramsStations } from "../stations-bcn.js";
import { flowFeed, flows, readings, siteIds, value } from "./flow-fixtures.js";

const FEED = "es-bcn-ajuntament";
const feed = flowFeed(FEED);

const CSV = `Tram,Tram_Components,Descripció,Longitud,Latitud
1,1,"Diagonal (Ronda de Dalt a Doctor Marañón)",2.11203535639414,41.3841912394771
1,2,"Diagonal (Ronda de Dalt a Doctor Marañón)",2.101502862881051,41.3816307921222
2,1,"Meridiana",2.18,41.42
2,2,"Meridiana",2.19,41.43
9,1,"Single vertex only",2.0,41.0`;

describe("parseBcnTramsStations", () => {
  it("groups vertices per tram (ordered) into lines with their description, dropping single-vertex trams", () => {
    const sites = parseBcnTramsStations(CSV);
    expect(sites.size).toBe(2);
    expect(sites.get("1")).toEqual({
      geometry: {
        type: "LineString",
        coordinates: [
          [2.11203535639414, 41.3841912394771],
          [2.101502862881051, 41.3816307921222],
        ],
      },
      name: "Diagonal (Ronda de Dalt a Doctor Marañón)",
    });
  });
});

describe("Barcelona TRAMS flow", () => {
  const sites = parseBcnTramsStations(CSV);

  it("joins status rows to their segment and maps the 0-6 scale to a level of service", () => {
    const out = flows(feed, ["1#20260729131557#2#2", "2#20260729131557#5#5"].join("\n"), sites);
    expect(siteIds(out, FEED)).toEqual(["1", "2"]);
    expect(value(out, FEED, "1", "traffic.los")).toBe("free_flow");
    expect(readings(out, FEED, "1", "traffic.speed")).toEqual([]);
    // Barcelona wall-clock time (CEST) read as an instant.
    expect(readings(out, FEED, "1", "traffic.los")[0]!["phenomenonTime"]).toEqual({
      instant: "2026-07-29T11:15:57.000Z",
    });
    expect(value(out, FEED, "2", "traffic.los")).toBe("stationary");
    // Only the congested (stationary) segment yields a derived congestion situation.
    expect(out.situations.map((s) => s["id"])).toEqual([`oc:situation:${FEED}:2:congestion`]);
  });

  it("skips status 0 (sensor down) and segments with no known geometry", () => {
    const out = flows(feed, ["1#20260729131557#0#0", "999#20260729131557#3#3"].join("\n"), sites);
    expect(out.features).toEqual([]);
  });

  it("refuses an empty or garbage body as a hard parse failure", () => {
    expect(() => flows(feed, "", sites)).toThrow("hard parse failure");
    expect(() => flows(feed, "<html>error</html>", sites)).toThrow("hard parse failure");
  });
});
