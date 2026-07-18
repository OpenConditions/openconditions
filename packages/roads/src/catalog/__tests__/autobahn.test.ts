import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autobahnIndexResolver } from "../autobahn.js";

const INDEX = path.resolve(
  import.meta.dirname,
  "../../__tests__/fixtures/autobahn/road-index.json"
);

function jsonResponder(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
    })) as unknown as typeof fetch;
}

describe("autobahnIndexResolver", () => {
  const index = JSON.parse(readFileSync(INDEX, "utf8"));

  it("emits warning + closure descriptors per unique road (A60/'A60 ' collapse)", async () => {
    const feeds = await autobahnIndexResolver.resolve(jsonResponder(index));
    expect(feeds).toHaveLength(10); // 5 roads x 2 services
    const urls = feeds.map((f) => f.url);
    expect(urls).toContain("https://verkehr.autobahn.de/o/autobahn/A1/services/warning");
    expect(urls).toContain("https://verkehr.autobahn.de/o/autobahn/A1/services/closure");
    expect(
      urls.some((u) => u?.toString().includes("A60%20") || u?.toString().includes("A60 "))
    ).toBe(false);
    expect(urls.some((u) => u?.toString().endsWith("/services/roadworks"))).toBe(false);
    for (const f of feeds) {
      expect(f.format).toBe("autobahn");
      expect(f.country).toBe("DE");
      expect(f.license).toBe("dl-de/by-2-0");
    }
    expect(new Set(feeds.map((f) => f.id)).size).toBe(feeds.length);
  });

  it("throws when the index responds non-ok", async () => {
    await expect(autobahnIndexResolver.resolve(jsonResponder("", 503))).rejects.toThrow(/503/);
  });

  it("returns no feeds when the index has no roads array", async () => {
    const feeds = await autobahnIndexResolver.resolve(jsonResponder({}));
    expect(feeds).toEqual([]);
  });

  it("returns no feeds when roads is present but not an array", async () => {
    const feeds = await autobahnIndexResolver.resolve(jsonResponder({ roads: "x" }));
    expect(feeds).toEqual([]);
  });
});
