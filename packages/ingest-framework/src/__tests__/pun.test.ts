import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { PUN_BUDGET, punHostFetch } from "../pun.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

vi.mock("../pun-coordination.js", () => ({
  punCoordinationDirectory: () => "test-memory-coordination",
  withPunCoordination: async (
    _directory: string,
    work: (budget: {
      next: number;
      reserveUntil: (n: number) => Promise<void>;
    }) => Promise<unknown>,
  ) => work({ next: 0, reserveUntil: async () => {} }),
}));
const shard = Buffer.from(
  JSON.stringify({
    _generated_at: "2026-11-06T07:04:56Z",
    _snapshot_date: "2026-11-06",
    punti: [],
  }),
);
const entry = {
  key: "pun/092090.json",
  size: shard.length,
  md5: createHash("md5").update(shard).digest("hex"),
};
const manifest = (files = [entry]) =>
  JSON.stringify({ sources: { pun: { status: "ok", last_run: "2026-11-06T07:08:53Z", files } } });
const env = {};
const feed = catalogFeed({
  id: "it-agid-pun-charging",
  format: "pun",
  endpoints: {
    main: { url: "https://cruscotto-italia.dati.gov.it/data/manifest.json", cadenceSec: 86400 },
  },
});
async function run(fn: typeof fetch) {
  return fetchEndpoint(feed, "main", fn, { state: createFetchState(), env });
}
let clockAt = Date.now();
async function clock<T>(work: () => Promise<T>) {
  vi.useFakeTimers();
  vi.setSystemTime(clockAt);
  try {
    const p = work();
    const observed = p.catch(() => {});
    await vi.runAllTimersAsync();
    await observed;
    return await p;
  } finally {
    clockAt = Date.now();
    vi.useRealTimers();
  }
}
describe("PUN acquisition", () => {
  it("freezes and rechecks manifest, then returns complete digest-checked bundle", async () => {
    const urls: string[] = [];
    const result = await clock(() =>
      run(async (input) => {
        urls.push(String(input));
        return new Response(String(input).endsWith("manifest.json") ? manifest() : shard);
      }),
    );
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      "/data/manifest.json",
      "/data/pun/092090.json",
      "/data/manifest.json",
    ]);
    expect(result.status).toBe("fetched");
    if (result.status === "fetched") expect(result.buffers).toHaveLength(3);
  });
  it.each(["digest", "missing", "generation", "empty", "path"])(
    "refuses %s without accepting a partial bundle",
    async (mode) => {
      let manifests = 0;
      await expect(
        clock(() =>
          run(async (input) => {
            if (String(input).endsWith("manifest.json")) {
              manifests++;
              return new Response(
                mode === "empty"
                  ? manifest([])
                  : mode === "path"
                    ? manifest([{ ...entry, key: "pun/../secret.json" }])
                    : mode === "generation" && manifests === 2
                      ? manifest([{ ...entry, md5: "0".repeat(32) }])
                      : manifest(),
              );
            }
            return mode === "missing"
              ? new Response("missing", { status: 404 })
              : new Response(mode === "digest" ? Buffer.from("bad") : shard);
          }),
        ),
      ).rejects.toThrow();
    },
  );
  it("backs off 429 and coordinates different feed identities on the host", async () => {
    const starts: number[] = [];
    let calls = 0;
    await clock(async () => {
      const fn: typeof fetch = async (input) => {
        starts.push(Date.now());
        calls++;
        return calls === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "5" } })
          : new Response(String(input).endsWith("manifest.json") ? manifest() : shard);
      };
      await Promise.all([
        run(fn),
        fetchEndpoint({ ...feed, id: "other-pun" }, "main", fn, { state: createFetchState(), env }),
      ]);
    });
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(5000);
    for (let i = 1; i < starts.length; i++)
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1000);
  });
  it("revalidates a 304 cached body against the current manifest", async () => {
    const state = createFetchState();
    let cached = false;
    let corrupt = false;
    const fn: typeof fetch = async (input) =>
      String(input).endsWith("manifest.json")
        ? new Response(manifest([{ ...entry, ...(corrupt ? { md5: "0".repeat(32) } : {}) }]))
        : cached
          ? new Response(null, { status: 304 })
          : new Response(shard, { headers: { etag: '"v1"' } });
    await clock(async () => {
      const first = await fetchEndpoint(feed, "main", fn, { state, env });
      if (first.status !== "fetched") throw Error();
      first.accept();
      cached = true;
      await fetchEndpoint(feed, "main", fn, { state, env });
      corrupt = true;
      await expect(fetchEndpoint(feed, "main", fn, { state, env })).rejects.toThrow();
    });
  });
});
it("promptly defers long backoff and later polls make zero calls until the retained deadline", async () => {
  await clock(async () => {
    const fn = vi.fn(
      async () => new Response(null, { status: 429, headers: { "Retry-After": "90000" } }),
    );
    const start = Date.now();
    await expect(run(fn)).rejects.toThrow(/later poll/);
    expect(Date.now() - start).toBeLessThan(PUN_BUDGET.elapsedMs);
    const calls = fn.mock.calls.length;
    await expect(run(fn)).rejects.toThrow(/later poll/);
    expect(fn).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(90000000);
  });
});

it("acquires qualified PUN with default runtime settings and no assertion flags", async () => {
  const result = await clock(() =>
    fetchEndpoint(
      feed,
      "main",
      async (input) => new Response(String(input).endsWith("manifest.json") ? manifest() : shard),
      { state: createFetchState(), env: {} },
    ),
  );
  expect(result.status).toBe("fetched");
});
it("aborts an active body and releases the host queue", async () => {
  await clock(async () => {
    await vi.advanceTimersByTimeAsync(100000000);
    const controller = new AbortController();
    const cancel = vi.fn();
    const fn = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    const fetch = punHostFetch(fn);
    const result = fetch(feed.endpoints.main!.url!, { signal: controller.signal });
    const rejection = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalled();
    const next = punHostFetch(async () => new Response("ok"));
    expect((await next(feed.endpoints.main!.url!)).status).toBe(200);
  });
});

it("bounds a stalled response body by total elapsed acquisition time", async () => {
  await clock(async () => {
    const cancel = vi.fn();
    const fn = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    const start = Date.now();
    await expect(run(fn)).rejects.toThrow(/elapsed deadline/);
    expect(Date.now() - start).toBeLessThanOrEqual(PUN_BUDGET.elapsedMs);
    expect(cancel).toHaveBeenCalled();
  });
});
it("cancels queued work without a provider call and releases the queue after active cancellation", async () => {
  await clock(async () => {
    const active = new AbortController();
    const queued = new AbortController();
    const fn = vi.fn(async () => new Response(new ReadableStream()));
    const host = punHostFetch(fn);
    const first = host(feed.endpoints.main!.url!, { signal: active.signal });
    const firstRejected = expect(first).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    const second = host(feed.endpoints.main!.url!, { signal: queued.signal });
    const secondRejected = expect(second).rejects.toThrow();
    queued.abort();
    await secondRejected;
    expect(fn).toHaveBeenCalledTimes(1);
    active.abort();
    await firstRejected;
  });
});
it("cancels an oversized shard stream and never accepts partial cache", async () => {
  await clock(async () => {
    const state = createFetchState();
    const cancel = vi.fn();
    const fn = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("manifest.json")
        ? new Response(manifest())
        : new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
              },
              cancel,
            }),
          ),
    );
    await expect(fetchEndpoint(feed, "main", fn, { state, env })).rejects.toThrow(/byte budget/);
    expect(cancel).toHaveBeenCalled();
    expect(state.conditional.size).toBe(0);
  });
});

it("defers long Retry-After immediately from headers even when its body stalls", async () => {
  await clock(async () => {
    const cancel = vi.fn();
    const start = Date.now();
    const fn = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 429,
          headers: { "Retry-After": "90000" },
        }),
    );
    await expect(run(fn)).rejects.toThrow(/later poll/);
    expect(Date.now() - start).toBeLessThan(10000);
    expect(cancel).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90000000);
  });
});

it("cancels a pacing wait without shortening the next permitted request time", async () => {
  await clock(async () => {
    const starts: number[] = [];
    const fetch = punHostFetch(async () => {
      starts.push(Date.now());
      return new Response("ok");
    });
    await fetch(feed.endpoints.main!.url!);
    const controller = new AbortController();
    const pending = fetch(feed.endpoints.main!.url!, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    setTimeout(() => controller.abort(), 100);
    await rejected;
    expect(starts).toHaveLength(1);
    await fetch(feed.endpoints.main!.url!);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
  });
});
it("preserves Retry-After on 503 failures for a later acquisition", async () => {
  await clock(async () => {
    const fn = vi.fn(
      async () => new Response(null, { status: 503, headers: { "Retry-After": "90000" } }),
    );
    await expect(run(fn)).rejects.toThrow(/later poll/);
    const calls = fn.mock.calls.length;
    await expect(run(fn)).rejects.toThrow(/later poll/);
    expect(fn).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(90000000);
  });
});
it("reuses a digest-matching accepted shard without spending another municipal request", async () => {
  const state = createFetchState();
  let shards = 0;
  const fn: typeof fetch = async (input) => {
    if (String(input).endsWith("manifest.json")) return new Response(manifest());
    shards++;
    return new Response(shard, { headers: { etag: '"stable"' } });
  };
  await clock(async () => {
    const first = await fetchEndpoint(feed, "main", fn, { state, env });
    if (first.status !== "fetched") throw Error();
    first.accept();
    const next = await fetchEndpoint(feed, "main", fn, { state, env });
    expect(next.status).toBe("fetched");
    expect(shards).toBe(1);
  });
});
it("rejects repeated manifest paths before starting any municipal requests", async () => {
  const fn = vi.fn(async () => new Response(manifest([entry, entry])));
  await expect(clock(() => run(fn))).rejects.toThrow(/duplicate manifest paths/);
  expect(fn).toHaveBeenCalledTimes(1);
});
it("also defers out-of-budget cooldown for other mirror callers using the shared host budget", async () => {
  await clock(async () => {
    const fn = vi.fn(
      async () => new Response(null, { status: 429, headers: { "Retry-After": "90000" } }),
    );
    const started = Date.now();
    await expect(
      punHostFetch(fn)("https://cruscotto-italia.dati.gov.it/data/other/092090.json"),
    ).rejects.toThrow(/later poll/);
    expect(Date.now() - started).toBeLessThan(PUN_BUDGET.elapsedMs);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90000000);
  });
});
