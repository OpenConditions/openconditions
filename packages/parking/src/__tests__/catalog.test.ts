import { describe, expect, it } from "vitest";
import { parkingCatalogue } from "./helpers/parking-feed.js";

describe("feeds/parking", () => {
  const feeds = [...parkingCatalogue().values()];

  it("keeps a slow feed fresh for two of its cadences, as the daily feeds are", () => {
    for (const feed of feeds) {
      const cadences = Object.values(feed.endpoints).map((e) => e.cadenceSec ?? 0);
      // A feed polled daily or slower in every endpoint; a live role sets its own window.
      const fastest = Math.min(...cadences);
      if (fastest < 86400) continue;
      expect(feed.freshnessWindowSec, feed.id).toBeGreaterThanOrEqual(2 * fastest);
    }
  });

  it("names the provider the licence requires in the credit", () => {
    const credit = (id: string) => feeds.find((f) => f.id === id)?.attribution;
    // DL-DE-BY-2.0 requires the provider's name; the licence is credited beside it.
    expect(credit("de-bw-mobidata-parking")).toBe("MobiData BW (NVBW)");
    expect(credit("de-nw-mobidrom-parking")).toBe("NRW.Mobidrom GmbH");
    expect(credit("de-nw-mobidrom-parkride-parking")).toBe("NRW.Mobidrom GmbH");
  });

  it("holds one feed per source taken, and keeps the sources without lawful terms disabled", () => {
    expect(feeds.map((f) => f.id).sort()).toEqual([
      "at-5-salzburg-parking",
      "at-9-vienna-parking",
      "au-nsw-tfnsw-parking",
      "be-bru-brussels-parking",
      "be-vlg-gent-parking",
      "ch-bs-basel-parking",
      "ch-sbb-parking",
      "de-bb-potsdam-parking",
      "de-bw-mobidata-parking",
      "de-db-bahnpark-parking",
      "de-hb-bremen-parking",
      "de-ni-braunschweig-parking",
      "de-nw-apag-parking",
      "de-nw-mobidrom-parking",
      "de-nw-mobidrom-parkride-parking",
      "dk-84-copenhagen-parking",
      "es-ct-barcelona-parking",
      "es-md-madrid-parking",
      "fr-bnls-parking",
      "gb-eng-netraveldata-parking",
      "it-32-opendatahub-parking",
      "it-52-florence-parking",
      "lu-cita-parking",
      "nl-ndw-truck-parking",
      "nl-rdw-parking",
      "osm-parking",
      "sg-hdb-parking",
    ]);
    expect(
      feeds
        .filter((f) => f.disabled !== undefined)
        .map((f) => f.id)
        .sort(),
    ).toEqual([
      "de-bb-potsdam-parking",
      "de-hb-bremen-parking",
      "de-ni-braunschweig-parking",
      "de-nw-apag-parking",
    ]);
  });

  it("covers Germany with MobiData BW, whose Toll Collect lorry parks span every motorway", () => {
    const mobidata = parkingCatalogue().get("de-bw-mobidata-parking")!;
    expect(mobidata.coverage?.bbox).toEqual([5.87, 47.27, 15.04, 55.06]);
  });

  it("reads OpenStreetMap through the instance's Overpass", () => {
    const osm = parkingCatalogue().get("osm-parking")!;
    expect(osm.endpoints["main"]?.url).toBe("${@overpass.url}/api/interpreter");
    expect(osm.accessMode).toBe("on_demand");
  });
});
