import { DigestTee } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearReferenceCaches, loadReference } from "../pipeline/reference.js";
import type { StreamTeeFactory } from "../raw/stream-tee.js";
import { testFeed } from "./helpers/catalog.js";

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

const REGISTRY_URL = "https://tie.digitraffic.fi/api/tms/v1/stations";

/** A Fintraffic-shaped flow feed whose `sites` endpoint is the station registry. */
function feed(sites: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return testFeed({
    id: "f",
    product: "flow",
    format: "fintraffic-tms",
    endpoints: {
      main: { url: "https://example.test/data", cadenceSec: 60 },
      sites: { url: REGISTRY_URL, decoder: "fintraffic-stations", cadenceSec: 21600, ...sites },
    },
    ...over,
  });
}

const okFetch = (async () => new Response(geojson, { status: 200 })) as unknown as typeof fetch;
const badFetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
type Sites = Map<string, { geometry?: unknown }> | undefined;

describe("loadReference — station registries", () => {
  // The module-level cache is shared across `it`s; clear it so each starts
  // cold and one test's warm map cannot bleed into another's assertions.
  beforeEach(() => clearReferenceCaches());

  it("parses a fintraffic-stations registry into its sites", async () => {
    const map = (await loadReference(feed(), "sites", okFetch)) as Sites;
    expect(map?.get("1")?.geometry).toEqual({ type: "Point", coordinates: [24.9, 60.2] });
  });

  it("returns undefined (never throws) on a cold fetch failure", async () => {
    expect(await loadReference(feed(), "sites", badFetch)).toBeUndefined();
  });

  it("serves the stale good map when a later fetch fails (cache survives failure)", async () => {
    const warm = (await loadReference(feed(), "sites", okFetch)) as Sites;
    expect(warm?.get("1")).toBeDefined();
    // Past the endpoint's cadence the registry is due again; that fetch fails.
    const later = () => Date.now() + 21_601_000;
    const out = (await loadReference(feed(), "sites", badFetch, later)) as Sites;
    expect(out?.get("1")?.geometry).toEqual({ type: "Point", coordinates: [24.9, 60.2] });
  });

  it("archives the registry byte for byte as it was fetched", async () => {
    // A byte-order mark and a byte that is not UTF-8: decoding to text and back changes both.
    const sent = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(geojson),
      Buffer.from([0x0a, 0xff]),
    ]);
    const fetchFn = (async () =>
      new Response(new Uint8Array(sent), { status: 200 })) as unknown as typeof fetch;
    const archived: Buffer[] = [];
    let kept: boolean | undefined;
    const teeFor: StreamTeeFactory = async (url) => {
      const tee = new DigestTee(url, {
        write: (chunk) => void archived.push(chunk),
        commit: async () => ({ storageKey: "", bytesStored: 0, created: true }),
        abort: async () => {},
      });
      return {
        tee,
        finish: async (ok) => {
          kept = ok;
        },
      };
    };
    await loadReference(feed(), "sites", fetchFn, Date.now, teeFor);
    expect(kept).toBe(true);
    expect(Buffer.concat(archived).equals(sent)).toBe(true);
  });

  it("sends the endpoint's headers on the registry fetch", async () => {
    const seen = vi.fn();
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      seen(init?.headers);
      return new Response(geojson, { status: 200 });
    }) as unknown as typeof fetch;
    const map = (await loadReference(
      feed({ headers: { "Digitraffic-User": "OpenConditions/1.0" } }),
      "sites",
      capturingFetch,
    )) as Sites;
    expect(map?.get("1")).toBeDefined();
    expect(seen).toHaveBeenCalledWith({ "Digitraffic-User": "OpenConditions/1.0" });
  });

  it("sends no headers for an endpoint that declares none", async () => {
    const seen = vi.fn();
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      seen(init);
      return new Response(geojson, { status: 200 });
    }) as unknown as typeof fetch;
    await loadReference(feed(), "sites", capturingFetch);
    expect(seen).toHaveBeenCalledWith(undefined);
  });

  it("scrubs a path-embedded secret out of the load-failure warn log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const src = feed(
        { url: "https://registry.test/subscription/${reg_secret}/sites" },
        { credentials: { reg_secret: { title: "Registry subscription id" } } },
      );
      const env = { F_REG_SECRET: "999999secretid" };
      expect(await loadReference(src, "sites", badFetch, Date.now, undefined, env)).toBeUndefined();
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain("999999secretid");
      expect(logged).toContain("***");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
