import { describe, expect, it } from "vitest";
import type { FeedSourceBase } from "@openconditions/ingest-framework";
import { validateFeed } from "../validate-feed.js";

const feed: FeedSourceBase = {
  id: "demo",
  name: "Demo",
  format: "geojson",
  url: "https://feed.test/data.json",
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "t",
  country: "NL",
  privacyUrl: "https://feed.test/privacy",
};

const okFetch = (body: string): typeof fetch =>
  (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

const statusFetch = (status: number): typeof fetch =>
  (async () => new Response("err", { status })) as unknown as typeof fetch;

describe("validateFeed", () => {
  it("is ok when the feed fetches and parses ≥1 observation", async () => {
    const res = await validateFeed(feed, {
      fetch: okFetch("[fixture]"),
      parserFor: () => () => [{ id: "a" }, { id: "b" }],
    });
    expect(res).toEqual({ ok: true, rowCount: 2 });
  });

  it("is not ok (no throw) when the parser yields zero observations", async () => {
    const res = await validateFeed(feed, {
      fetch: okFetch("[]"),
      parserFor: () => () => [],
    });
    expect(res.ok).toBe(false);
    expect(res.rowCount).toBe(0);
    expect(res.message).toMatch(/0 observation/i);
  });

  it("is not ok (no throw) on an HTTP error, and reports the status", async () => {
    const res = await validateFeed(feed, { fetch: statusFetch(500) });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/500/);
  });

  it("redacts URL query secrets embedded in a thrown error", async () => {
    const boom: typeof fetch = async () => {
      throw new Error("connect ECONNREFUSED https://api.test/x?key=SECRET123&z=1");
    };
    const res = await validateFeed(feed, { fetch: boom });
    expect(res.ok).toBe(false);
    expect(res.message).not.toContain("SECRET123");
    expect(res.message).toContain("***");
  });
});
