import { afterEach, describe, expect, it } from "vitest";
import { PRE_FETCH_HOOKS, applyPreFetch } from "../index.js";
import type { FeedSourceBase } from "../index.js";

const base: FeedSourceBase = {
  id: "h",
  name: "H",
  format: "geojson",
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "t",
  country: "XX",
  privacyUrl: "https://x",
  enabledByDefault: true,
};
const noFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

// Snapshot the built-in hooks (e.g. webtrisDailyWindow) registered at module
// load, so tests can add/remove their own without clobbering them.
const builtInHooks = Object.keys(PRE_FETCH_HOOKS);

afterEach(() => {
  for (const k of Object.keys(PRE_FETCH_HOOKS)) {
    if (!builtInHooks.includes(k)) delete PRE_FETCH_HOOKS[k];
  }
});

describe("applyPreFetch", () => {
  it("is a no-op when preFetch is unset", async () => {
    const out = await applyPreFetch(base, {}, noFetch);
    expect(out).toBe(base);
  });

  it("runs a registered hook that rewrites the src (e.g. a resolved url)", async () => {
    PRE_FETCH_HOOKS["stamp"] = async (src) => ({ ...src, url: "https://h.test/2026-07-01.json" });
    const out = await applyPreFetch({ ...base, preFetch: "stamp" }, {}, noFetch);
    expect(out.url).toBe("https://h.test/2026-07-01.json");
  });

  it("throws on an unknown hook name", async () => {
    await expect(applyPreFetch({ ...base, preFetch: "missing" }, {}, noFetch)).rejects.toThrow(
      /missing/
    );
  });

  it("ships with only the built-in feed hooks registered", () => {
    expect(Object.keys(PRE_FETCH_HOOKS).sort()).toEqual(["webtrisDailyWindow"]);
  });
});
