import type { FeedSourceBase } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { validateFeed } from "../validate-feed.js";

const feed: FeedSourceBase = {
  id: "demo",
  name: "Demo",
  operator: "test",
  format: "geojson",
  url: "https://feed.test/data.json",
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "t",
  country: "NL",
  privacyUrl: "https://feed.test/privacy",
  tier: "authoritative",
};

const okFetch = (body: string): typeof fetch =>
  (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

const statusFetch = (status: number): typeof fetch =>
  (async () => new Response("err", { status })) as unknown as typeof fetch;

describe("validateFeed", () => {
  it("is ok when the feed fetches and parses ≥1 record", async () => {
    const res = await validateFeed(feed, { fetch: okFetch("[fixture]"), count: () => 2 });
    expect(res).toEqual({ ok: true, rowCount: 2 });
  });

  it("is not ok (no throw) when the parser yields zero records", async () => {
    const res = await validateFeed(feed, { fetch: okFetch("[]"), count: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.rowCount).toBe(0);
    expect(res.message).toMatch(/0 records/i);
  });

  it("counts the situations a roads event feed parses into", async () => {
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "w1",
          geometry: { type: "Point", coordinates: [4.9, 52.37] },
          properties: { title: "Werkzaamheden" },
        },
      ],
    });
    const res = await validateFeed(
      { ...feed, geojson: { headlineField: "title", defaultType: "roadworks" } } as FeedSourceBase,
      { fetch: okFetch(geojson) },
    );
    expect(res).toEqual({ ok: true, rowCount: 1 });
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
