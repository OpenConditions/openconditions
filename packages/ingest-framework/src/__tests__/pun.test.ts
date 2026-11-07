import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

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
const feed = catalogFeed({
  id: "it-agid-pun-charging",
  format: "pun",
  endpoints: {
    main: { url: "https://cruscotto-italia.dati.gov.it/data/manifest.json", cadenceSec: 86400 },
  },
});
async function run(fn: typeof fetch) {
  return fetchEndpoint(feed, "main", fn, { state: createFetchState() });
}
async function clock<T>(work: () => Promise<T>) {
  vi.useFakeTimers();
  try {
    const p = work();
    const observed = p.catch(() => {});
    await vi.runAllTimersAsync();
    await observed;
    return await p;
  } finally {
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
        fetchEndpoint({ ...feed, id: "other-pun" }, "main", fn, { state: createFetchState() }),
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
      const first = await fetchEndpoint(feed, "main", fn, { state });
      if (first.status !== "fetched") throw Error();
      first.accept();
      cached = true;
      await fetchEndpoint(feed, "main", fn, { state });
      corrupt = true;
      await expect(fetchEndpoint(feed, "main", fn, { state })).rejects.toThrow();
    });
  });
});
it("honors a Retry-After longer than a day across failed polls", async () => {
  const starts: number[] = [];
  let calls = 0;
  await clock(async () => {
    const fn: typeof fetch = async (input) => {
      starts.push(Date.now());
      calls++;
      if (calls <= 3)
        return new Response(null, { status: 429, headers: { "Retry-After": "90000" } });
      return new Response(String(input).endsWith("manifest.json") ? manifest() : shard);
    };
    await expect(run(fn)).rejects.toThrow();
    await run(fn);
  });
  expect(starts[3]! - starts[2]!).toBeGreaterThanOrEqual(90000000);
});
