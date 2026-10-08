import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

/** An upstream that records when each request started, in fake time. */
function clockedApi(body: (url: string) => unknown = () => ({ ok: true })) {
  const starts: number[] = [];
  const fn = (async (input: string | URL | Request) => {
    starts.push(Date.now());
    return new Response(JSON.stringify(body(String(input))), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, starts };
}

/** The most requests that started within any 60 s window. */
function busiestMinute(starts: number[]): number {
  return Math.max(...starts.map((t) => starts.filter((s) => s >= t && s < t + 60_000).length));
}

const SIX = Array.from({ length: 6 }, (_, i) => `https://api.test/city/${i}`);

describe("fetchEndpoint pacing by requestLimits.perMinute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paces a fan-out so no 60 s window holds more than perMinute requests", async () => {
    const { fn, starts } = clockedApi();
    const feed = catalogFeed({
      requestLimits: { perMinute: 3 },
      endpoints: { main: { urls: SIX, cadenceSec: 86400 } },
    });
    const begun = Date.now();
    const pending = fetchEndpoint(feed, "main", fn, { state: createFetchState() });
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(res.status === "fetched" && res.buffers).toHaveLength(6);
    expect(starts).toHaveLength(6);
    expect(busiestMinute(starts)).toBeLessThanOrEqual(3);
    expect(Math.max(...starts) - begun).toBeGreaterThanOrEqual(60_000);
  });

  it("paces the pages of a paginated endpoint", async () => {
    const { fn, starts } = clockedApi((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return { items: offset < 8 ? [1, 2] : [1] };
    });
    const feed = catalogFeed({
      requestLimits: { perMinute: 2 },
      endpoints: {
        main: {
          url: "https://api.test/items",
          cadenceSec: 86400,
          pagination: { skipParam: "offset", pageSize: 2, recordsPath: "items" },
        },
      },
    });
    const pending = fetchEndpoint(feed, "main", fn, { state: createFetchState() });
    await vi.runAllTimersAsync();
    await pending;

    expect(starts).toHaveLength(5);
    expect(busiestMinute(starts)).toBeLessThanOrEqual(2);
  });

  it("shares one feed's budget across its roles and polls", async () => {
    const { fn, starts } = clockedApi();
    const feed = catalogFeed({
      requestLimits: { perMinute: 3 },
      endpoints: {
        main: { urls: SIX.slice(0, 2), cadenceSec: 86400 },
        status: { urls: SIX.slice(2, 4), cadenceSec: 3600 },
      },
    });
    const state = createFetchState();
    const main = fetchEndpoint(feed, "main", fn, { state });
    const status = fetchEndpoint(feed, "status", fn, { state });
    await vi.runAllTimersAsync();
    await Promise.all([main, status]);

    expect(starts).toHaveLength(4);
    expect(busiestMinute(starts)).toBeLessThanOrEqual(3);
  });

  it("waits on timers that never keep a stopping process alive", async () => {
    const { fn } = clockedApi();
    const feed = catalogFeed({
      requestLimits: { perMinute: 2 },
      endpoints: { main: { urls: SIX.slice(0, 3), cadenceSec: 86400 } },
    });
    const timers: { hasRef(): boolean }[] = [];
    const fake = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = fake(...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    try {
      const pending = fetchEndpoint(feed, "main", fn, { state: createFetchState() });
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      spy.mockRestore();
    }
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.every((t) => !t.hasRef())).toBe(true);
  });

  it("leaves a feed without perMinute unpaced", async () => {
    const { fn, starts } = clockedApi();
    const feed = catalogFeed({ endpoints: { main: { urls: SIX, cadenceSec: 86400 } } });
    const pending = fetchEndpoint(feed, "main", fn, { state: createFetchState() });
    await vi.runAllTimersAsync();
    await pending;

    expect(starts).toHaveLength(6);
    expect(new Set(starts).size).toBe(1);
  });
});
