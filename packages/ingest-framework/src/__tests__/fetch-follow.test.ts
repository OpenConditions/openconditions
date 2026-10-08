import { describe, expect, it } from "vitest";
import { endpointSchema } from "../catalog/schema.js";
import type { CatalogFeed, FeedEndpoint } from "../catalog/types.js";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

interface Call {
  url: string;
  headers: Headers;
}

/** A fake upstream serving `routes` by exact URL; every request is recorded. */
function upstream(routes: Record<string, string>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const body = routes[url];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const feedWith = (endpoint: Partial<FeedEndpoint>, extra: Partial<CatalogFeed> = {}) =>
  catalogFeed({
    id: "xx-test-events",
    endpoints: { main: { url: "https://portal.test/page", cadenceSec: 300, ...endpoint } },
    ...extra,
  });

const SECRET_ENV = { XX_TEST_EVENTS_KEY: "secret" };

async function bodies(feed: CatalogFeed, baseFetch: typeof fetch) {
  const res = await fetchEndpoint(feed, "main", baseFetch, {
    state: createFetchState(),
    env: SECRET_ENV,
  });
  if (res.status !== "fetched") throw new Error(`unexpected ${res.status}`);
  return res.buffers.map((b) => b.toString("utf8"));
}

describe("fetchEndpoint follow", () => {
  it("takes the CSV link from an HTML page and fetches it without the auth header", async () => {
    const routes = {
      "https://portal.test/page": `<html><a href="/files/Ladesaeulenregister_2026.csv">csv</a></html>`,
      "https://portal.test/files/Ladesaeulenregister_2026.csv": "a;b\n1;2\n",
    };
    const up = upstream(routes);
    const feed = feedWith(
      {
        follow: { pattern: 'href="([^"]*Ladesaeulenregister_[^"]*\\.csv)"' },
        headers: { "User-Agent": "oc-test" },
      },
      {
        auth: { kind: "header-key", header: "X-Api-Key", credential: "key" },
        credentials: { key: { title: "Key" } },
      },
    );
    expect(await bodies(feed, up.fn)).toEqual(["a;b\n1;2\n"]);
    expect(up.calls.map((c) => c.url)).toEqual([
      "https://portal.test/page",
      "https://portal.test/files/Ladesaeulenregister_2026.csv",
    ]);
    expect(up.calls[0]!.headers.get("x-api-key")).toBe("secret");
    expect(up.calls[1]!.headers.get("x-api-key")).toBeNull();
    expect(up.calls[1]!.headers.get("user-agent")).toBe("oc-test");
  });

  it("drops a templated credential header from the followed request, with or without auth", async () => {
    const up = upstream({
      "https://portal.test/page": `{"u":"https://files.test/x"}`,
      "https://files.test/x": "payload",
    });
    const feed = feedWith(
      {
        follow: { path: "u" },
        headers: { "X-Key": "${key}", "X-Plain": "yes" },
      },
      { credentials: { key: { title: "Key" } } },
    );
    expect(await bodies(feed, up.fn)).toEqual(["payload"]);
    expect(up.calls[0]!.headers.get("x-key")).toBe("secret");
    expect(up.calls[1]!.headers.get("x-key")).toBeNull();
    expect(up.calls[1]!.headers.get("x-plain")).toBe("yes");
  });

  it("never sends query-key, bearer or basic credentials to the followed URL", async () => {
    const auths: CatalogFeed["auth"][] = [
      { kind: "query-key", param: "k", credential: "key" },
      { kind: "bearer", credential: "key" },
      { kind: "basic", user: "key", password: "key" },
    ];
    for (const auth of auths) {
      const routes = {
        "https://portal.test/page?k=secret": `{"u":"https://files.test/x.json"}`,
        "https://portal.test/page": `{"u":"https://files.test/x.json"}`,
        "https://files.test/x.json": "payload",
      };
      const up = upstream(routes);
      const feed = feedWith(
        { follow: { path: "u" } },
        { auth, credentials: { key: { title: "Key" } } },
      );
      expect(await bodies(feed, up.fn)).toEqual(["payload"]);
      expect(up.calls[1]!.url).toBe("https://files.test/x.json");
      expect(up.calls[1]!.headers.get("authorization")).toBeNull();
      expect(up.calls[0]!.headers.get("authorization") ?? up.calls[0]!.url).toMatch(
        /secret|c2Vj|k=/,
      );
    }
  });

  it("takes a JSON path to a presigned URL", async () => {
    const { fn, calls } = upstream({
      "https://api.test/batch": JSON.stringify({
        value: [{ Link: "https://s3.test/x.json?sig=1" }],
      }),
      "https://s3.test/x.json?sig=1": `{"stations":[]}`,
    });
    const feed = feedWith({ url: "https://api.test/batch", follow: { path: "value.0.Link" } });
    expect(await bodies(feed, fn)).toEqual([`{"stations":[]}`]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/batch",
      "https://s3.test/x.json?sig=1",
    ]);
  });

  it("fails the fetch when nothing matches", async () => {
    const { fn } = upstream({ "https://portal.test/page": "<html>no link</html>" });
    await expect(
      bodies(feedWith({ follow: { pattern: 'href="([^"]*\\.csv)"' } }), fn),
    ).rejects.toThrow("follow: no URL found");
    const json = upstream({ "https://portal.test/page": `{"value":[]}` });
    await expect(bodies(feedWith({ follow: { path: "value.0.Link" } }), json.fn)).rejects.toThrow(
      "follow: no URL found",
    );
  });

  it("hands the followed URL to the guarded fetch, which refuses private addresses", async () => {
    const { fn } = upstream({ "https://portal.test/page": `{"u":"http://169.254.169.254/x"}` });
    const { guardedFetch } = await import("../egress.js");
    const guarded = guardedFetch(
      fn,
      { maxBytes: 1e6, timeoutMs: 5000, maxRedirects: 2 },
      {},
      (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    );
    await expect(bodies(feedWith({ follow: { path: "u" } }), guarded)).rejects.toThrow(
      "URLs targeting internal/private addresses are not allowed",
    );
  });
});

describe("endpoint schema", () => {
  const base = { url: "https://example.test/x", cadenceSec: 60 };

  it("rejects follow with both path and pattern, or with neither", () => {
    expect(
      endpointSchema.safeParse({ ...base, follow: { path: "a", pattern: "(b)" } }).success,
    ).toBe(false);
    expect(endpointSchema.safeParse({ ...base, follow: {} }).success).toBe(false);
    expect(endpointSchema.safeParse({ ...base, follow: { path: "a" } }).success).toBe(true);
    expect(endpointSchema.safeParse({ ...base, follow: { pattern: "(b)" } }).success).toBe(true);
  });

  it("rejects impersonate on http", () => {
    expect(
      endpointSchema.safeParse({ ...base, url: "http://example.test/x", impersonate: true })
        .success,
    ).toBe(false);
    expect(endpointSchema.safeParse({ ...base, impersonate: true }).success).toBe(true);
  });

  it("rejects firstPage outside page mode and unknown modes", () => {
    const pg = { skipParam: "pageNo", pageSize: 10 };
    expect(endpointSchema.safeParse({ ...base, pagination: { ...pg, firstPage: 1 } }).success).toBe(
      false,
    );
    expect(
      endpointSchema.safeParse({ ...base, pagination: { ...pg, mode: "page", firstPage: 1 } })
        .success,
    ).toBe(true);
    expect(
      endpointSchema.safeParse({ ...base, pagination: { ...pg, mode: "cursor" } }).success,
    ).toBe(false);
  });
});
