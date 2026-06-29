import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverAutobahnRoads, discoverWzdxFeeds } from "../discover.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

function jsonResponder(payload: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status })
  ) as unknown as typeof fetch;
}

describe("discoverAutobahnRoads", () => {
  const index = JSON.parse(readFileSync(join(FIXTURES, "autobahn/road-index.json"), "utf8"));

  it("enumerates warning + closure URLs for each unique road", async () => {
    const urls = await discoverAutobahnRoads(jsonResponder(index));
    // 5 unique roads (A60 / "A60 " collapse) x 2 services
    expect(urls).toHaveLength(10);
    expect(urls).toContain("https://verkehr.autobahn.de/o/autobahn/A1/services/warning");
    expect(urls).toContain("https://verkehr.autobahn.de/o/autobahn/A1/services/closure");
    expect(urls).toContain("https://verkehr.autobahn.de/o/autobahn/A64a/services/warning");
  });

  it("trims trailing whitespace and dedupes the collapsed road", async () => {
    const urls = await discoverAutobahnRoads(jsonResponder(index));
    expect(urls.some((u) => u.includes("A60%20") || u.includes("A60 "))).toBe(false);
    const a60 = urls.filter((u) => u.includes("/autobahn/A60/services/warning"));
    expect(a60).toHaveLength(1);
  });

  it("does not enumerate roadworks (high-volume, opt-in)", async () => {
    const urls = await discoverAutobahnRoads(jsonResponder(index));
    expect(urls.some((u) => u.endsWith("/services/roadworks"))).toBe(false);
  });

  it("throws when the index responds non-ok", async () => {
    await expect(discoverAutobahnRoads(jsonResponder("", 503))).rejects.toThrow(/503/);
  });

  it("returns no URLs when the index has no roads array", async () => {
    const urls = await discoverAutobahnRoads(jsonResponder({}));
    expect(urls).toEqual([]);
  });
});

describe("discoverWzdxFeeds", () => {
  const registry = JSON.parse(readFileSync(join(FIXTURES, "wzdx/registry.json"), "utf8"));

  it("returns only active, geojson, v4.x feed URLs (nested + plain), deduped", async () => {
    const urls = await discoverWzdxFeeds(jsonResponder(registry));
    expect(urls.sort()).toEqual(
      [
        "https://alpha.example/api/wzdx",
        "https://bravo.example/api/wzdx?apiKey=",
        "https://charlie.example/api/wzdx",
        "https://hotel.example/api/wzdx-string",
        "https://india.example/api/wzdx",
      ].sort()
    );
  });

  it("excludes inactive, non-geojson, and non-v4 (v3 / CWZ) feeds", async () => {
    const urls = await discoverWzdxFeeds(jsonResponder(registry));
    expect(urls).not.toContain("https://delta.example/api/json");
    expect(urls).not.toContain("https://echo.example/api/wzdx");
    expect(urls).not.toContain("https://foxtrot.example/api/cwz");
    expect(urls).not.toContain("https://golf.example/api/v3");
  });

  it("throws when the registry responds non-ok", async () => {
    await expect(discoverWzdxFeeds(jsonResponder("", 500))).rejects.toThrow(/500/);
  });

  it("returns no URLs when the registry payload is not an array", async () => {
    const urls = await discoverWzdxFeeds(jsonResponder({ error: "nope" }));
    expect(urls).toEqual([]);
  });

  it("skips feeds whose key querystring is still an unfilled placeholder", async () => {
    const reg = [
      {
        active: "true",
        format: "geojson",
        version: "4.2",
        url: "https://a.example/wzdx?api_key=INSERT-API-KEY-HERE",
      },
      {
        active: "true",
        format: "geojson",
        version: "4.2",
        url: { url: "https://b.example/wzdx?apiKey=[Your-API-Key-Here]" },
      },
      {
        active: "true",
        format: "geojson",
        version: "4.2",
        url: "https://c.example/wzdx?key=YOUR_API_KEY",
      },
      { active: "true", format: "geojson", version: "4.2", url: "https://good.example/wzdx" },
    ];
    const urls = await discoverWzdxFeeds(jsonResponder(reg));
    expect(urls).toEqual(["https://good.example/wzdx"]);
  });
});
