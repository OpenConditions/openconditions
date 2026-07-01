import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogResolver, FeedSourceBase } from "../index.js";
import { __resetCatalogResolvers, registerCatalogResolver } from "../catalog.js";
import { fetchAll } from "../fetch.js";

afterEach(() => __resetCatalogResolvers());

const desc = (id: string, url: string): FeedSourceBase => ({
  id,
  name: id,
  format: "wzdx",
  url,
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "t",
  country: "US",
  privacyUrl: "https://x",
  enabledByDefault: true,
});

describe("fetchAll — catalog branch", () => {
  it("resolves the named resolver and fans out its feed URLs", async () => {
    const resolver: CatalogResolver = {
      id: "test-registry",
      snapshotPath: "/nonexistent.json", // live path succeeds; write failure is tolerated
      resolve: async () => [desc("a", "https://a.example/f"), desc("b", "https://b.example/f")],
    };
    registerCatalogResolver("roads", resolver);

    const seen: string[] = [];
    const fetchFn = vi.fn(async (u: string) => {
      seen.push(u);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const feed: FeedSourceBase = {
      ...desc("wzdx", ""),
      url: undefined,
      catalog: { resolver: "test-registry" },
    };
    const result = await fetchAll(feed, fetchFn);
    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") throw new Error("expected fetched");
    expect(result.buffers).toHaveLength(2);
    expect(seen.sort()).toEqual(["https://a.example/f", "https://b.example/f"]);
  });

  it("throws for a feed referencing an unregistered resolver", async () => {
    const feed: FeedSourceBase = {
      ...desc("x", ""),
      url: undefined,
      catalog: { resolver: "ghost" },
    };
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(fetchAll(feed, fetchFn)).rejects.toThrow(/ghost/);
  });
});
