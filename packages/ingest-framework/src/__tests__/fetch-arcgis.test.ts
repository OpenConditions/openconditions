import { expect, test, vi } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const feed = catalogFeed({
  endpoints: {
    main: {
      url: "https://arcgis.test/query",
      cadenceSec: 120,
      pagination: {
        skipParam: "resultOffset",
        pageSize: 500,
        recordsPath: "features",
        maxPages: 3,
        arcgis: true,
      },
    },
  },
});
const page = (ids: number[], more?: boolean) => ({
  features: ids.map((OBJECTID) => ({ attributes: { OBJECTID } })),
  ...(more === undefined ? {} : { exceededTransferLimit: more }),
});
const run = (pages: unknown[]) => {
  let i = 0;
  const urls: string[] = [];
  const fetchFn = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify(pages[i++]));
  }) as typeof fetch;
  return { urls, result: fetchEndpoint(feed, "main", fetchFn, { state: createFetchState() }) };
};
test("short nonterminal pages advance by received rows and retain terminal empty evidence", async () => {
  const r = run([page([1], true), page([2], true), page([], false)]);
  const out = await r.result;
  if (out.status !== "fetched") throw new Error("expected fetched");
  expect(out.buffers).toHaveLength(3);
  expect(r.urls[1]).toContain("resultOffset=1");
  expect(r.urls[2]).toContain("resultOffset=2");
});
test.each([
  [page([1], true), page([1], false)],
  [page([], true)],
  [{ error: { code: 400 } }],
  [page([1], true), page([2], true), page([3], true)],
  [{ features: [], exceededTransferLimit: "false" }],
])("rejects incomplete/ambiguous cycles %j", async (...pages) => {
  await expect(run(pages).result).rejects.toThrow();
});

test("shares a 120 second cooldown and honors Retry-After without retrying inside a cycle", async () => {
  const state = createFetchState();
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response("busy", { status: 429, headers: { "Retry-After": "600" } });
  }) as typeof fetch;
  await expect(fetchEndpoint(feed, "main", fetchFn, { state, at: 1000000 })).rejects.toThrow();
  await expect(fetchEndpoint(feed, "main", fetchFn, { state, at: 1120000 })).rejects.toThrow(
    /backoff/,
  );
  expect(calls).toBe(1);
});

test("rejects a later page HTTP failure without returning partial buffers", async () => {
  let calls = 0;
  const state = createFetchState();
  const fetchFn = (async () =>
    ++calls === 1
      ? new Response(JSON.stringify(page([1], true)))
      : new Response("failure", { status: 503 })) as typeof fetch;
  await expect(fetchEndpoint(feed, "main", fetchFn, { state })).rejects.toThrow();
  expect(calls).toBe(2);
});
test("treats omitted exceededTransferLimit on a short page as terminal", async () => {
  const result = await run([page([1])]).result;
  expect(result.status).toBe("fetched");
});

test("rejects a cycle exceeding its byte budget", async () => {
  const state = createFetchState();
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({ ...page([1]), padding: "x".repeat(10 * 1024 * 1024) }),
    )) as typeof fetch;
  await expect(fetchEndpoint(feed, "main", fetchFn, { state })).rejects.toThrow(/byte limit/);
});

test("rejects overlapping cycles sharing a source state", async () => {
  const state = createFetchState();
  let release!: (r: Response) => void;
  const fetchFn = (() =>
    new Promise<Response>((resolve) => {
      release = resolve;
    })) as typeof fetch;
  const first = fetchEndpoint(feed, "main", fetchFn, { state, at: 1000000 });
  await expect(fetchEndpoint(feed, "main", fetchFn, { state, at: 1000000 })).rejects.toThrow(
    /active/,
  );
  release(new Response(JSON.stringify(page([], false))));
  expect((await first).status).toBe("fetched");
});

test("rejects continuation after the cycle deadline", async () => {
  let now = 1000000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const fetchFn = (async () => {
      now += 61000;
      return new Response(JSON.stringify(page([1], true)));
    }) as typeof fetch;
    await expect(
      fetchEndpoint(feed, "main", fetchFn, { state: createFetchState(), at: 1000000 }),
    ).rejects.toThrow(/deadline/);
  } finally {
    clock.mockRestore();
  }
});
