import { expect, test } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

for (const none of [false, true]) {
  test(`multi-URL raw caches respect none=${none}, including inherited state`, async () => {
    const feed = catalogFeed({
      endpoints: {
        main: {
          urls: ["https://example.test/a", "https://example.test/b"],
          cadenceSec: 300,
        },
      },
    });
    const state = createFetchState();
    const upstream = async () => new Response("excluded assessment", { headers: { etag: "v1" } });
    const first = await fetchEndpoint(feed, "main", upstream, { state });
    if (first.status === "fetched") first.accept();
    expect([...state.conditional.values()].every((v) => v.body !== undefined)).toBe(true);
    if (none) feed.rawRetention = "none";
    const second = await fetchEndpoint(feed, "main", upstream, { state });
    if (second.status === "fetched") second.accept();
    expect([...state.conditional.values()].filter((v) => v.body || v.payload)).toHaveLength(
      none ? 0 : 2,
    );
  });
}

test("none ignores inherited per-item bodies and does not return kept caches", async () => {
  const feed = catalogFeed({
    endpoints: {
      main: {
        url: "https://example.test/{item}",
        cadenceSec: 300,
        each: { role: "list", records: "ids", field: "id", keepSec: 86400 },
      },
    },
  });
  const opts = {
    eachSource: [Buffer.from('{"ids":[{"id":"a"}]}')],
    state: createFetchState(),
    at: 1000,
  };
  const first = await fetchEndpoint(feed, "main", async () => new Response("old"), opts);
  expect(first.status).toBe("fetched");
  if (first.status !== "fetched") throw new Error("expected items");
  expect(first.kept?.size).toBe(1);
  feed.rawRetention = "none";
  const result = await fetchEndpoint(feed, "main", async () => new Response("fresh"), {
    ...opts,
    kept: first.kept,
  });
  expect(result.status).toBe("fetched");
  if (result.status === "fetched") {
    expect(result.kept).toBeUndefined();
    expect(result.buffers.map((b) => b.toString())).toEqual(["fresh"]);
  }
});

test("none retries unexpected 304 without retaining validators or bodies", async () => {
  const feed = catalogFeed({ rawRetention: "none" });
  const state = createFetchState();
  let attempts = 0;
  const result = await fetchEndpoint(
    feed,
    "main",
    async () =>
      ++attempts === 1
        ? new Response(null, { status: 304 })
        : new Response("complete", { headers: { etag: "v1" } }),
    { state },
  );
  expect(result.status).toBe("fetched");
  if (result.status === "fetched") {
    result.accept();
    expect(result.buffers[0]?.toString()).toBe("complete");
  }
  expect(state.conditional.size).toBe(0);
});
