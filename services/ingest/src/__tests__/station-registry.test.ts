import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStationRegistryCache, loadStationRegistry } from "../pipeline/station-registry.js";
import type { FeedSource } from "@openconditions/roads";

const geojson = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 1,
      properties: {},
      geometry: { type: "Point", coordinates: [24.9, 60.2] },
    },
  ],
});

function feed(reg: FeedSource["stationRegistry"]): FeedSource {
  return { id: "f", stationRegistry: reg } as unknown as FeedSource;
}
const REG = {
  url: "https://tie.digitraffic.fi/api/tms/v1/stations",
  format: "fintraffic-stations",
} as const;
const okFetch = (async () => new Response(geojson, { status: 200 })) as unknown as typeof fetch;
const badFetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;

describe("loadStationRegistry", () => {
  // The module-level 6h cache is shared across `it`s; clear it so each starts
  // cold and one test's warm map cannot bleed into another's assertions.
  beforeEach(() => clearStationRegistryCache());

  it("returns undefined when no registry is declared", async () => {
    expect(await loadStationRegistry(feed(undefined), okFetch)).toBeUndefined();
  });

  it("parses a fintraffic-stations registry into a site map", async () => {
    const map = await loadStationRegistry(feed(REG), okFetch);
    expect(map?.get("1")).toEqual({ type: "Point", coordinates: [24.9, 60.2] });
  });

  it("returns undefined (never throws) on a cold fetch failure", async () => {
    // Cache cleared in beforeEach → no warm map to fall back on → undefined.
    expect(await loadStationRegistry(feed(REG), badFetch)).toBeUndefined();
  });

  it("serves the stale good map when a later fetch fails (cache survives failure)", async () => {
    // Warm the cache with a good fetch, then fail: the loader returns the last
    // good map rather than undefined, so a transient registry outage never
    // strips geometry from the flow parser mid-run.
    const warm = await loadStationRegistry(feed(REG), okFetch);
    expect(warm?.get("1")).toBeDefined();
    // Force a refetch by advancing the clock past the 6h TTL, then fail.
    const later = () => Date.now() + 7 * 60 * 60 * 1000;
    const out = await loadStationRegistry(feed(REG), badFetch, later);
    expect(out?.get("1")).toEqual({ type: "Point", coordinates: [24.9, 60.2] });
  });

  it("forwards the feed's requestHeaders on the registry fetch when declared", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string> | undefined;
      return new Response(geojson, { status: 200 });
    }) as unknown as typeof fetch;

    const withHeaders = {
      id: "f",
      stationRegistry: REG,
      requestHeaders: { "Digitraffic-User": "OpenConditions/1.0" },
    } as unknown as FeedSource;

    const map = await loadStationRegistry(withHeaders, capturingFetch);
    expect(map?.get("1")).toBeDefined();
    expect(seenHeaders).toEqual({ "Digitraffic-User": "OpenConditions/1.0" });
  });

  it("still works for a feed with no requestHeaders (e.g. WebTRIS)", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string> | undefined;
      return new Response(geojson, { status: 200 });
    }) as unknown as typeof fetch;

    const map = await loadStationRegistry(feed(REG), capturingFetch);
    expect(map?.get("1")).toBeDefined();
    expect(seenHeaders).toBeUndefined();
  });

  it("scrubs a path-embedded secret out of the load-failure warn log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const secretReg = {
        url: "https://registry.test/subscription/999999secretid/sites",
        format: "fintraffic-stations",
      } as const;
      const src = {
        id: "f-secret",
        stationRegistry: secretReg,
        requiredEnv: ["REG_SECRET"],
      } as unknown as FeedSource;
      process.env.REG_SECRET = "999999secretid";
      try {
        expect(await loadStationRegistry(src, badFetch)).toBeUndefined();
      } finally {
        delete process.env.REG_SECRET;
      }
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain("999999secretid");
      expect(logged).toContain("***");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
