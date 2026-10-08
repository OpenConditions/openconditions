import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpointSchema } from "../catalog/schema.js";
import type { CatalogFeed } from "../catalog/types.js";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const SITES = Buffer.from(JSON.stringify({ features: [{ id: "C1" }, { id: "C 2" }] }));

const EACH = { role: "sites", records: "features", field: "id" };

function feedWith(over: Partial<CatalogFeed> = {}, each = EACH): CatalogFeed {
  return catalogFeed({
    endpoints: {
      sites: { url: "https://api.test/sites", cadenceSec: 3600 },
      details: { url: "https://api.test/stations/{item}", cadenceSec: 86400, each },
    },
    ...over,
  });
}

/** An upstream recording each request's URL and start time; `failing` URLs answer 500. */
function upstream(failing: string[] = []) {
  const calls: { url: string; at: number; headers: Headers }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, at: Date.now(), headers: new Headers(init?.headers) });
    if (failing.includes(url)) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { etag: `"${url}"` },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("fetchEndpoint each", () => {
  it("fetches once per id of its source role, in order, with the id encoded", async () => {
    const up = upstream();
    const res = await fetchEndpoint(feedWith(), "details", up.fn, {
      state: createFetchState(),
      eachSource: [SITES],
    });

    expect(up.calls.map((c) => c.url)).toEqual([
      "https://api.test/stations/C1",
      "https://api.test/stations/C%202",
    ]);
    if (res.status !== "fetched") throw new Error(`unexpected ${res.status}`);
    expect(res.buffers.map((b) => JSON.parse(b.toString()).url)).toEqual(
      up.calls.map((c) => c.url),
    );
    expect(res.payloads).toHaveLength(2);
  });

  it("reads the ids of every source payload and skips records without one", async () => {
    const up = upstream();
    const second = Buffer.from(JSON.stringify({ features: [{ id: 7 }, {}, { id: "C1" }] }));
    await fetchEndpoint(feedWith(), "details", up.fn, {
      state: createFetchState(),
      eachSource: [SITES, second],
    });
    expect(up.calls.map((c) => c.url)).toEqual([
      "https://api.test/stations/C1",
      "https://api.test/stations/C%202",
      "https://api.test/stations/7",
    ]);
  });

  it("reads a nested id field with getPath", async () => {
    const up = upstream();
    const nested = Buffer.from(JSON.stringify({ data: { list: [{ props: { id: "A" } }] } }));
    await fetchEndpoint(
      feedWith({}, { role: "sites", records: "data.list", field: "props.id" }),
      "details",
      up.fn,
      { state: createFetchState(), eachSource: [nested] },
    );
    expect(up.calls.map((c) => c.url)).toEqual(["https://api.test/stations/A"]);
  });

  it("fails when the source payload is missing, not JSON, or has no records list", async () => {
    const up = upstream();
    const run = (eachSource?: Buffer[]) =>
      fetchEndpoint(feedWith(), "details", up.fn, {
        state: createFetchState(),
        ...(eachSource ? { eachSource } : {}),
      });
    await expect(run()).rejects.toThrow(/sites/);
    await expect(run([Buffer.from("<html>")])).rejects.toThrow(/not valid JSON/);
    await expect(run([Buffer.from("{}")])).rejects.toThrow(/features/);
    expect(up.calls).toHaveLength(0);
  });

  it("sends the feed's authorization and headers with every item request", async () => {
    const up = upstream();
    const feed = feedWith({
      auth: { kind: "header-key", header: "X-Api-Key", credential: "key" },
      credentials: { key: { title: "Key" } },
    });
    await fetchEndpoint(feed, "details", up.fn, {
      state: createFetchState(),
      env: { XX_TEST_EVENTS_KEY: "secret" },
      eachSource: [SITES],
    });
    expect(up.calls).toHaveLength(2);
    for (const call of up.calls) expect(call.headers.get("X-Api-Key")).toBe("secret");
  });

  it("never lets one item's validator apply to another, or to the next poll", async () => {
    const up = upstream();
    const state = createFetchState();
    for (let poll = 0; poll < 2; poll++) {
      await fetchEndpoint(feedWith(), "details", up.fn, { state, eachSource: [SITES] });
    }
    expect(up.calls.every((c) => !c.headers.has("If-None-Match"))).toBe(true);
  });

  it("an item that has no id left makes an empty fetch, not an invented request", async () => {
    const up = upstream();
    const res = await fetchEndpoint(feedWith(), "details", up.fn, {
      state: createFetchState(),
      eachSource: [Buffer.from(JSON.stringify({ features: [] }))],
    });
    expect(up.calls).toHaveLength(0);
    expect(res.status === "fetched" && res.buffers).toEqual([]);
  });

  describe("failures", () => {
    it("a failing item fails the role", async () => {
      const up = upstream(["https://api.test/stations/C1"]);
      await expect(
        fetchEndpoint(feedWith(), "details", up.fn, {
          state: createFetchState(),
          eachSource: [SITES],
        }),
      ).rejects.toThrow(/HTTP 500/);
    });

    it("a failing item stops the requests not yet sent", async () => {
      const ids = Array.from({ length: 30 }, (_, i) => ({ id: `S${i}` }));
      const many = Buffer.from(JSON.stringify({ features: ids }));
      const calls: string[] = [];
      const fn = (async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/S0")) return new Response("boom", { status: 500 });
        // The others answer later, so the failure is known before any worker takes another id.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ url }));
      }) as unknown as typeof fetch;
      await expect(
        fetchEndpoint(feedWith(), "details", fn, {
          state: createFetchState(),
          eachSource: [many],
        }),
      ).rejects.toThrow(/HTTP 500/);
      // Let the requests already sent settle: none is followed by another.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(calls).toHaveLength(8);
      expect(calls[0]).toBe("https://api.test/stations/S0");
    });

    it("with fanout tolerant, a failing item leaves the rest and a partial result", async () => {
      const up = upstream(["https://api.test/stations/C1"]);
      const feed = catalogFeed({
        endpoints: {
          sites: { url: "https://api.test/sites", cadenceSec: 3600 },
          details: {
            url: "https://api.test/stations/{item}",
            cadenceSec: 86400,
            each: EACH,
            fanout: "tolerant",
          },
        },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await fetchEndpoint(feed, "details", up.fn, {
          state: createFetchState(),
          eachSource: [SITES],
        });
        expect(res.status).toBe("partial");
        if (res.status !== "partial") return;
        expect(res.buffers).toHaveLength(1);
        expect(res.partitions).toEqual({ succeeded: 1, failed: 1, total: 2 });
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("pacing", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("paces item requests with the feed's perMinute, shared with its other roles", async () => {
      const up = upstream();
      const feed = feedWith({ requestLimits: { perMinute: 2 } });
      const state = createFetchState();
      const begun = Date.now();
      const pending = Promise.all([
        fetchEndpoint(feed, "sites", up.fn, { state }),
        fetchEndpoint(feed, "details", up.fn, { state, eachSource: [SITES] }),
      ]);
      await vi.runAllTimersAsync();
      await pending;

      expect(up.calls).toHaveLength(3);
      expect(up.calls[2]!.at - begun).toBeGreaterThanOrEqual(60_000);
      expect(up.calls[1]!.at - begun).toBeLessThan(60_000);
    });
  });
});

describe("endpointSchema each", () => {
  const base = { url: "https://api.test/stations/{item}", cadenceSec: 60, each: EACH };

  it("accepts a url with {item}", () => {
    expect(endpointSchema.safeParse(base).success).toBe(true);
    expect(endpointSchema.safeParse({ ...base, fanout: "tolerant" }).success).toBe(true);
  });

  it("rejects a url without {item}, and urls, expand, follow, pagination alongside", () => {
    expect(endpointSchema.safeParse({ ...base, url: "https://api.test/stations" }).success).toBe(
      false,
    );
    expect(
      endpointSchema.safeParse({
        ...base,
        url: undefined,
        urls: ["https://api.test/stations/{item}"],
      }).success,
    ).toBe(false);
    expect(endpointSchema.safeParse({ ...base, expand: "${key}" }).success).toBe(false);
    expect(endpointSchema.safeParse({ ...base, follow: { path: "a" } }).success).toBe(false);
    expect(
      endpointSchema.safeParse({ ...base, pagination: { skipParam: "o", pageSize: 5 } }).success,
    ).toBe(false);
  });

  it("rejects an each with a missing part", () => {
    expect(
      endpointSchema.safeParse({ ...base, each: { role: "sites", records: "x" } }).success,
    ).toBe(false);
  });
});
