import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { wzdxRegistryResolver } from "../wzdx.js";

const REGISTRY = path.resolve(import.meta.dirname, "../../__tests__/fixtures/wzdx/registry.json");

function jsonResponder(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
    })) as unknown as typeof fetch;
}

describe("wzdxRegistryResolver", () => {
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));

  it("has the expected id and a vendored snapshot path", () => {
    expect(wzdxRegistryResolver.id).toBe("wzdx-registry");
    expect(wzdxRegistryResolver.snapshotPath).toMatch(/snapshots[/\\]wzdx-registry\.json$/);
  });

  it("maps active / geojson / v4.x rows to full wzdx feed descriptors", async () => {
    const feeds = await wzdxRegistryResolver.resolve(jsonResponder(registry));
    const urls = feeds.map((f) => f.url).sort();
    expect(urls).toEqual(
      [
        "https://alpha.example/api/wzdx",
        "https://charlie.example/api/wzdx",
        "https://hotel.example/api/wzdx-string",
        "https://india.example/api/wzdx",
      ].sort()
    );
    for (const f of feeds) {
      expect(f.format).toBe("wzdx");
      expect(f.country).toBe("US");
      expect(f.license).toBe("CC0-1.0");
      expect(f.id.startsWith("wzdx-")).toBe(true);
    }
    expect(new Set(feeds.map((f) => f.id)).size).toBe(feeds.length); // unique ids
  });

  it("drops inactive / non-geojson / non-v4 and empty/placeholder-key rows", async () => {
    const feeds = await wzdxRegistryResolver.resolve(jsonResponder(registry));
    const urls = feeds.map((f) => f.url);
    expect(urls).not.toContain("https://delta.example/api/json");
    expect(urls).not.toContain("https://echo.example/api/wzdx");
    expect(urls).not.toContain("https://bravo.example/api/wzdx?apiKey=");
  });

  it("scaffolds a setup guide from needapikey + apikeyurl", async () => {
    const reg = [
      {
        feedname: "keyed-dot",
        state: "TX",
        issuingorganization: "TxDOT",
        active: "true",
        format: "geojson",
        version: "4.2",
        needapikey: "yes",
        apikeyurl: "https://txdot.example/get-a-key",
        url: "https://keyed.example/wzdx?api_key=abc123",
      },
    ];
    const [feed] = await wzdxRegistryResolver.resolve(jsonResponder(reg));
    expect(feed?.setup?.["WZDX_TX_API_KEY"]?.url).toBe("https://txdot.example/get-a-key");
  });

  it("throws when the registry responds non-ok", async () => {
    await expect(wzdxRegistryResolver.resolve(jsonResponder("", 500))).rejects.toThrow(/500/);
  });
});
