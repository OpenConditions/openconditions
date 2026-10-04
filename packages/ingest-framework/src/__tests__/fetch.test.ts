import { describe, expect, it, vi } from "vitest";
import type { CatalogResolver, ChildFeed } from "../catalog/resolvers.js";
import type { CatalogFeed, FeedEndpoint } from "../catalog/types.js";
import { createFetchState, type FetchOptions, fetchEndpoint } from "../fetch.js";
import { digestPayload } from "../payload.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

/** A feed `id` whose `main` endpoint is `endpoint` (cadence 300 s unless given). */
function makeFeed(
  id: string,
  endpoint: Omit<FeedEndpoint, "cadenceSec"> & { cadenceSec?: number },
  extra: Partial<CatalogFeed> = {},
): CatalogFeed {
  return catalogFeed({
    id,
    format: "autobahn",
    endpoints: { main: { cadenceSec: 300, ...endpoint } },
    ...extra,
  });
}

/**
 * Builds a feed backed by a one-off catalog resolver that resolves the given
 * URLs into children, so the catalog fan-out (bounded concurrency + per-URL
 * tolerance) can be exercised through `fetchEndpoint`.
 */
function cataloguedFeed(
  id: string,
  urls: string[],
  extra: Partial<CatalogFeed> = {},
): { feed: CatalogFeed; opts: FetchOptions } {
  const resolver: CatalogResolver = {
    id: `res-${id}`,
    snapshotPath: "/nonexistent.json",
    snapshot: [],
    resolve: async () =>
      urls.map(
        (url, i): ChildFeed => ({
          qualifier: `c${i}`,
          name: `${id}-${i}`,
          endpoints: { main: { url, cadenceSec: 300 } },
          selectionState: "discovered",
        }),
      ),
  };
  const feed = makeFeed(
    id,
    { url: "https://registry.test/index" },
    {
      catalog: { resolver: resolver.id },
      ...extra,
    },
  );
  return { feed, opts: { resolvers: [resolver] } };
}

const okFor = (
  body: (url: string) => string,
  fail: (url: string) => boolean = () => false,
): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (fail(url)) return new Response("err", { status: 500 });
    return new Response(body(url), { status: 200 });
  }) as unknown as typeof fetch;

/** Fetch and unwrap the buffers, treating an "unchanged" result as no buffers. */
async function fetchBuffers(
  feed: CatalogFeed,
  fetchFn: typeof fetch,
  opts: FetchOptions = {},
): Promise<Buffer[]> {
  const res = await fetchEndpoint(feed, "main", fetchFn, opts);
  return res.status === "fetched" || res.status === "partial" ? res.buffers : [];
}

/**
 * A DataMall-style OData source: `{ value: [...] }` pages of at most `pageSize`
 * rows, addressed by `$skip`. `pageRows[n]` is how many rows page n returns;
 * a page beyond the array returns zero rows.
 */
function pagedODataFetch(
  pageRows: number[],
  pageSize = 500,
): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const skip = Number(new URL(url).searchParams.get("$skip") ?? "0");
    const page = skip / pageSize;
    const n = pageRows[page] ?? 0;
    const value = Array.from({ length: n }, (_, i) => ({ LinkID: skip + i }));
    return new Response(JSON.stringify({ value }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function rowsIn(buffers: Buffer[]): number {
  return buffers.reduce(
    (sum, b) => sum + (JSON.parse(b.toString("utf8")).value as unknown[]).length,
    0,
  );
}

describe("fetchEndpoint — cell reads", () => {
  const cell = { id: "0.25/53/209", west: 13.25, south: 52.25, east: 13.5, north: 52.5 };

  it("fills the cell into url and body and keeps no conditional-GET state", async () => {
    const feed = makeFeed("cell-feed", {
      url: "https://h.test/q?w={west}&s={south}",
      method: "POST",
      body: "({south},{west},{north},{east})",
    });
    const state = createFetchState();
    const seen: { url: string; body: unknown; headers: Headers }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), body: init?.body, headers: new Headers(init?.headers) });
      return new Response("{}", { status: 200, headers: { etag: '"v1"' } });
    }) as unknown as typeof fetch;

    for (let i = 0; i < 2; i++) {
      const res = await fetchEndpoint(feed, "main", fetchFn, { state, cell });
      expect(res.status).toBe("fetched");
    }
    expect(seen.map((s) => s.url)).toEqual([
      "https://h.test/q?w=13.25&s=52.25",
      "https://h.test/q?w=13.25&s=52.25",
    ]);
    expect(seen[0]!.body).toBe("(52.25,13.25,52.5,13.5)");
    expect(seen[1]!.headers.get("if-none-match")).toBeNull();
    expect(state.conditional.size).toBe(0);
    expect(state.sourceConfig.size).toBe(0);
  });
});

describe("fetchEndpoint — offset pagination", () => {
  const pagedFeed = (
    pagination: FeedEndpoint["pagination"] = { skipParam: "$skip", pageSize: 500 },
  ) =>
    makeFeed(
      "paged",
      { url: "https://datamall.test/TrafficSpeedBands", pagination },
      { format: "lta-speedbands" },
    );

  it("follows $skip until a short page, one buffer per page, all rows preserved", async () => {
    const { fetchFn, calls } = pagedODataFetch([500, 500, 200]);
    const bufs = await fetchBuffers(pagedFeed(), fetchFn);
    expect(bufs).toHaveLength(3);
    expect(rowsIn(bufs)).toBe(1200);
    // Stops after the short page — never requests a 4th.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("$skip=0");
    expect(calls[2]).toContain("$skip=1000");
  });

  it("terminates on an empty page and does not emit an empty buffer", async () => {
    const { fetchFn, calls } = pagedODataFetch([500, 0]);
    const bufs = await fetchBuffers(pagedFeed(), fetchFn);
    expect(bufs).toHaveLength(1);
    expect(rowsIn(bufs)).toBe(500);
    expect(calls).toHaveLength(2);
  });

  it("stops a first short page immediately (single request)", async () => {
    const { fetchFn, calls } = pagedODataFetch([100]);
    const bufs = await fetchBuffers(pagedFeed(), fetchFn);
    expect(bufs).toHaveLength(1);
    expect(rowsIn(bufs)).toBe(100);
    expect(calls).toHaveLength(1);
  });

  it("rejects an incomplete snapshot at maxPages", async () => {
    const { fetchFn, calls } = pagedODataFetch([500, 500, 500, 500, 500]);
    await expect(
      fetchBuffers(pagedFeed({ skipParam: "$skip", pageSize: 500, maxPages: 2 }), fetchFn),
    ).rejects.toThrow(/maxPages/);
    expect(calls).toHaveLength(2);
  });
});

describe("fetchEndpoint — Open511 offset pagination", () => {
  /**
   * DriveBC's shape: `{ events: [...] }` addressed by `offset`, capped at the
   * requested `limit`. Without pagination the endpoint's own default page is 50
   * of the ~250 events it holds.
   */
  function pagedOpen511Fetch(
    pageRows: number[],
    pageSize = 500,
  ): { fetchFn: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
      const n = pageRows[offset / pageSize] ?? 0;
      const events = Array.from({ length: n }, (_, i) => ({ id: `drivebc/${offset + i}` }));
      return new Response(JSON.stringify({ events, pagination: { offset } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  it("follows `offset` across pages and preserves every event", async () => {
    const { fetchFn, calls } = pagedOpen511Fetch([500, 261]);
    const bufs = await fetchBuffers(
      makeFeed(
        "ca-bc-drivebc-events",
        {
          url: "https://api.open511.gov.bc.ca/events?format=json&limit=500",
          pagination: { skipParam: "offset", pageSize: 500, recordsPath: "events" },
        },
        { format: "open511" },
      ),
      fetchFn,
    );

    expect(bufs).toHaveLength(2);
    const total = bufs.reduce(
      (sum, b) => sum + (JSON.parse(b.toString("utf8")).events as unknown[]).length,
      0,
    );
    expect(total).toBe(761);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("offset=0");
    expect(calls[1]).toContain("offset=500");
    // The upstream `limit` survives the offset rewrite.
    for (const c of calls) expect(c).toContain("limit=500");
  });
});

describe("fetchEndpoint — catalog fan-out", () => {
  it("fetches every URL the catalog resolver returns", async () => {
    const urls = ["https://x.test/1", "https://x.test/2", "https://x.test/3"];
    const { feed, opts } = cataloguedFeed("disc", urls);
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => `body:${u}`),
      opts,
    );
    expect(bufs.map((b) => b.toString("utf8")).sort()).toEqual(urls.map((u) => `body:${u}`).sort());
  });

  it("hands the resolver the parent, whose main endpoint names the registry", async () => {
    const resolve = vi.fn(async (): Promise<ChildFeed[]> => []);
    const resolver: CatalogResolver = { id: "parented", snapshotPath: "/x", snapshot: [], resolve };
    const feed = makeFeed(
      "parented",
      { url: "https://registry.test/index" },
      { catalog: { resolver: "parented" } },
    );
    const fetchFn = okFor(() => "{}");
    await fetchEndpoint(feed, "main", fetchFn, { resolvers: [resolver] });
    expect(resolve).toHaveBeenCalledWith(feed, fetchFn);
  });

  it("prefers the catalog over the parent's own url", async () => {
    const { feed, opts } = cataloguedFeed("both", ["https://x.test/a"], {
      endpoints: { main: { url: "https://static.test/should-not-be-used", cadenceSec: 300 } },
    });
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => u),
      opts,
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toBe("https://x.test/a");
  });

  it("fans out the children's urls of the requested role", async () => {
    const resolver: CatalogResolver = {
      id: "roles",
      snapshotPath: "/nonexistent.json",
      snapshot: [],
      resolve: async (): Promise<ChildFeed[]> => [
        {
          qualifier: "a",
          name: "a",
          endpoints: {
            main: { urls: ["https://a.test/1", "https://a.test/2"], cadenceSec: 60 },
            detail: { url: "https://a.test/detail", cadenceSec: 60 },
          },
          selectionState: "discovered",
        },
        {
          qualifier: "b",
          name: "b",
          endpoints: { detail: { url: "https://b.test/detail", cadenceSec: 60 } },
          selectionState: "discovered",
        },
      ],
    };
    const feed = makeFeed(
      "roles",
      { url: "https://registry.test" },
      {
        catalog: { resolver: "roles" },
      },
    );
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(String(u));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchEndpoint(feed, "main", fetchFn, { resolvers: [resolver] });
    expect(seen.sort()).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("applies catalog.filter to the resolved children, fetching only the matches", async () => {
    const resolver: CatalogResolver = {
      id: "filtered-registry",
      snapshotPath: "/nonexistent.json",
      snapshot: [],
      resolve: async () => [
        {
          qualifier: "us",
          name: "us",
          endpoints: { main: { url: "https://us.example/f", cadenceSec: 300 } },
          selectionState: "discovered",
          attribution: "US",
        },
        {
          qualifier: "ca",
          name: "ca",
          endpoints: { main: { url: "https://ca.example/f", cadenceSec: 300 } },
          selectionState: "discovered",
          attribution: "CA",
        },
      ],
    };
    const seen: string[] = [];
    const fetchFn = vi.fn(async (u: string) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const feed = makeFeed(
      "wzdx",
      { url: "https://registry.test" },
      {
        catalog: { resolver: "filtered-registry", filter: { attribution: "US" } },
      },
    );
    const result = await fetchEndpoint(feed, "main", fetchFn, { resolvers: [resolver] });
    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") throw new Error("expected fetched");
    expect(result.buffers).toHaveLength(1);
    expect(seen).toEqual(["https://us.example/f"]);
  });

  it("throws for a feed referencing a resolver it was not given", async () => {
    const feed = makeFeed(
      "x",
      { url: "https://registry.test" },
      { catalog: { resolver: "ghost" } },
    );
    await expect(
      fetchEndpoint(feed, "main", vi.fn() as unknown as typeof fetch, { resolvers: [] }),
    ).rejects.toThrow(/ghost/);
  });

  it("tolerates a failing sub-feed and returns the rest", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const { feed, opts } = cataloguedFeed("tol", urls);
    const bufs = await fetchBuffers(
      feed,
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad"),
      ),
      opts,
    );
    expect(bufs).toHaveLength(2);
    expect(bufs.map((b) => b.toString("utf8"))).not.toContain("body:https://x.test/bad");
  });

  it("reports the partial-failure signal (failures/total) alongside the surviving buffers", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const { feed, opts } = cataloguedFeed("tol-signal", urls);
    const res = await fetchEndpoint(
      feed,
      "main",
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad"),
      ),
      opts,
    );
    expect(res.status).toBe("partial");
    if (res.status !== "partial") throw new Error("unreachable");
    expect(res.buffers).toHaveLength(2);
    expect(res.partitions).toEqual({ succeeded: 2, failed: 1, total: 3 });
  });

  it("drops a sub-feed that returns an HTML block/error page (200) and keeps the JSON ones", async () => {
    const urls = ["https://x.test/json", "https://x.test/html"];
    const { feed, opts } = cataloguedFeed("html", urls);
    const bufs = await fetchBuffers(
      feed,
      okFor((u) =>
        u.endsWith("/html")
          ? "  <!DOCTYPE html><html>blocked</html>"
          : `{"feed":${JSON.stringify(u)}}`,
      ),
      opts,
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toContain('"feed"');
  });

  it("throws when every resolved sub-feed fails (preserves last-good upstream)", async () => {
    const { feed, opts } = cataloguedFeed("allbad", ["https://x.test/1", "https://x.test/2"]);
    await expect(
      fetchEndpoint(
        feed,
        "main",
        okFor(
          (u) => u,
          () => true,
        ),
        opts,
      ),
    ).rejects.toThrow(/all .*sub-feed/);
  });

  it("returns nothing (no throw) when the catalog yields zero URLs", async () => {
    const { feed, opts } = cataloguedFeed("empty", []);
    const res = await fetchEndpoint(
      feed,
      "main",
      okFor((u) => u),
      opts,
    );
    expect(res).toEqual({
      status: "no-endpoint",
      reason: "missing-configuration",
      validatedAtNetwork: false,
    });
  });

  it("bounds concurrency to 8 in-flight fetches", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(String(input), { status: 200 });
    }) as unknown as typeof fetch;

    const urls = Array.from({ length: 20 }, (_, i) => `https://x.test/${i}`);
    const { feed, opts } = cataloguedFeed("conc", urls);
    const bufs = await fetchBuffers(feed, fetchFn, opts);
    expect(bufs).toHaveLength(20);
    expect(maxInFlight).toBe(8);
  });
});

describe("fetchEndpoint — static url forms (regression)", () => {
  it("fetches a single url", async () => {
    const feed = makeFeed("s", { url: "https://x.test/one" });
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => `body:${u}`),
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toBe("body:https://x.test/one");
  });

  it("reports complete partition coverage on the non-fanout static path", async () => {
    const feed = makeFeed("s-no-partial", { url: "https://x.test/one" });
    const res = await fetchEndpoint(
      feed,
      "main",
      okFor((u) => `body:${u}`),
    );
    expect(res.status).toBe("fetched");
    if (res.status !== "fetched") throw new Error("unreachable");
    expect(res.partitions).toEqual({ succeeded: 1, failed: 0, total: 1 });
  });

  it("fetches every url of a urls list", async () => {
    const feed = makeFeed("arr", { urls: ["https://x.test/a", "https://x.test/b"] });
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => u),
    );
    expect(bufs.map((b) => b.toString("utf8")).sort()).toEqual([
      "https://x.test/a",
      "https://x.test/b",
    ]);
  });

  it("does not HTML-filter the single-url path (XML feeds like NDW pass through)", async () => {
    const feed = makeFeed("xml", { url: "https://x.test/ndw.xml" });
    const bufs = await fetchBuffers(
      feed,
      okFor(() => '<?xml version="1.0"?><d2:payload/>'),
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toContain("<?xml");
  });

  it("fetches the requested role", async () => {
    const feed = catalogFeed({
      endpoints: {
        main: { url: "https://x.test/main", cadenceSec: 60 },
        detail: { url: "https://x.test/detail", cadenceSec: 300 },
      },
    });
    const res = await fetchEndpoint(
      feed,
      "detail",
      okFor((u) => u),
    );
    expect(res.status === "fetched" && res.buffers.map(String)).toEqual(["https://x.test/detail"]);
  });

  it("throws for an unknown role or a reference endpoint", async () => {
    const feed = catalogFeed({
      endpoints: {
        main: { url: "https://x.test/main", cadenceSec: 60 },
        sites: {
          reference: { kind: "mobilithek", offerId: "1", fileNamePrefix: "x" },
          decoder: "datex2-sites",
          cadenceSec: 3600,
        },
      },
    });
    await expect(
      fetchEndpoint(
        feed,
        "nope",
        okFor((u) => u),
      ),
    ).rejects.toThrow(/no endpoint nope/);
    await expect(
      fetchEndpoint(
        feed,
        "sites",
        okFor((u) => u),
      ),
    ).rejects.toThrow(/reference/);
  });

  it("bounds concurrency to 8 on the static url-array path", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(String(input), { status: 200 });
    }) as unknown as typeof fetch;

    const urls = Array.from({ length: 20 }, (_, i) => `https://x.test/${i}`);
    const feed = makeFeed("conc-static", { urls });
    const bufs = await fetchBuffers(feed, fetchFn);
    expect(bufs).toHaveLength(20);
    expect(maxInFlight).toBe(8);
  });
});

describe("fetchEndpoint — tolerant fan-out of a urls list", () => {
  /**
   * The tolerant fetcher was written for JSON registry feeds and rejected any
   * payload starting with "<" as an HTML error page. XML feeds start with an
   * XML declaration, so opting one into the tolerant fan-out silently failed every
   * sub-feed — the whole publisher, on a path meant to survive partial failure.
   */
  it("accepts XML sub-feeds, which are not HTML error pages", async () => {
    const urls = ["https://x.test/a.xml", "https://x.test/b.xml"];
    const feed = makeFeed("fanout-xml", { urls, fanout: "tolerant" });
    const bufs = await fetchBuffers(
      feed,
      okFor(() => '<?xml version="1.0" encoding="UTF-8"?><d2LogicalModel/>'),
    );
    expect(bufs).toHaveLength(2);
  });

  it("still rejects an HTML page served in place of data", async () => {
    const urls = ["https://x.test/a", "https://x.test/b"];
    const feed = makeFeed("fanout-html", { urls, fanout: "tolerant" });
    await expect(
      fetchBuffers(
        feed,
        okFor(() => "<!DOCTYPE html><html><body>Sign in</body></html>"),
      ),
    ).rejects.toThrow(/sub-feeds failed/);
  });

  it("sends the endpoint's headers on every sub-feed", async () => {
    // The tolerant path dropped the RequestInit the static path builds, so a
    // feed's headers (and any POST body) went missing once it fanned out.
    const seen: (HeadersInit | undefined)[] = [];
    const feed = makeFeed("fanout-headers", {
      urls: ["https://x.test/a", "https://x.test/b"],
      fanout: "tolerant",
      headers: { "Accept-Encoding": "gzip" },
    });
    await fetchBuffers(feed, (async (_u: string, init?: RequestInit) => {
      seen.push(init?.headers);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch);

    expect(seen).toHaveLength(2);
    for (const h of seen) expect(new Headers(h).get("Accept-Encoding")).toBe("gzip");
  });

  it("tolerates a failing url and returns the buffers from the rest", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const feed = makeFeed("fanout-tol", { urls, fanout: "tolerant" });
    const bufs = await fetchBuffers(
      feed,
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad"),
      ),
    );
    expect(bufs).toHaveLength(2);
    expect(bufs.map((b) => b.toString("utf8"))).not.toContain("body:https://x.test/bad");
  });

  it("reports the partial-failure signal for a tolerant urls list", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const feed = makeFeed("fanout-tol-signal", { urls, fanout: "tolerant" });
    const res = await fetchEndpoint(
      feed,
      "main",
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad"),
      ),
    );
    expect(res.status).toBe("partial");
    if (res.status !== "partial") throw new Error("unreachable");
    expect(res.buffers).toHaveLength(2);
    expect(res.partitions).toEqual({ succeeded: 2, failed: 1, total: 3 });
  });

  it("tolerates a failing item of an expanded url", async () => {
    const feed = makeFeed(
      "fanout-expand",
      { url: "https://x.test/${sub}", expand: "sub", fanout: "tolerant" },
      { credentials: { sub: { title: "Subscriptions" } } },
    );
    const res = await fetchEndpoint(
      feed,
      "main",
      okFor(
        (u) => u,
        (u) => u.endsWith("/bad"),
      ),
      { env: { FANOUT_EXPAND_SUB: "ok,bad" } },
    );
    expect(res).toMatchObject({ status: "partial", partitions: { succeeded: 1, total: 2 } });
  });

  it("does not affect a urls list fetched all-or-nothing (one failure still throws)", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    for (const feed of [
      makeFeed("no-fanout-tol", { urls }),
      makeFeed("fanout-all", { urls, fanout: "all" }),
    ]) {
      await expect(
        fetchEndpoint(
          feed,
          "main",
          okFor(
            (u) => `body:${u}`,
            (u) => u.endsWith("/bad"),
          ),
        ),
      ).rejects.toThrow();
    }
  });

  it("leaves a single-url tolerant endpoint on the normal static path (conditional GET still applies)", async () => {
    const feed = makeFeed(
      "fanout-tol-single",
      { url: "https://h.test/${sub}", expand: "sub", fanout: "tolerant" },
      { credentials: { sub: { title: "Subscriptions" } } },
    );
    const env = { FANOUT_TOL_SINGLE_SUB: "f.xml" };
    const state = createFetchState();
    let call = 0;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Response("payload-v1", { status: 200, headers: { ETag: 'W/"v1"' } });
      }
      const inm = new Headers(init?.headers).get("If-None-Match");
      expect(inm).toBe('W/"v1"');
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const first = await fetchEndpoint(feed, "main", fetchFn, { state, env });
    if (first.status === "fetched") first.accept();
    expect(first.status).toBe("fetched");
    const second = await fetchEndpoint(feed, "main", fetchFn, { state, env });
    expect(second).toMatchObject({ status: "not-modified", validatedAtNetwork: true });
  });
});

describe("fetchEndpoint — url templates", () => {
  it("interpolates a ${field} url from the feed's credential env var", async () => {
    const feed = makeFeed(
      "tpl",
      { url: "https://h.test/f?k=${key}" },
      { credentials: { key: { title: "Key" } } },
    );
    const seen: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    process.env.TPL_KEY = "secret";
    try {
      await fetchEndpoint(feed, "main", fetchFn);
    } finally {
      delete process.env.TPL_KEY;
    }
    expect(seen).toEqual(["https://h.test/f?k=secret"]);
  });

  it("expands a Mobilithek-style endpoint to one url per subscription id", async () => {
    const feed = makeFeed(
      "mob",
      { url: "https://m.test/subscription/${sub}/pull?subscriptionID=${sub}", expand: "sub" },
      { credentials: { sub: { title: "Subscriptions" } } },
    );
    const seen: string[] = [];
    await fetchEndpoint(
      feed,
      "main",
      (async (input: string) => {
        seen.push(String(input));
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch,
      { env: { MOB_SUB: "a, b" } },
    );
    expect(seen.sort()).toEqual([
      "https://m.test/subscription/a/pull?subscriptionID=a",
      "https://m.test/subscription/b/pull?subscriptionID=b",
    ]);
  });
});

describe("fetchEndpoint — POST body template", () => {
  it("sends an interpolated body on a POST endpoint", async () => {
    const feed = makeFeed(
      "post",
      {
        method: "POST",
        url: "https://api.test/query",
        body: '<REQUEST authenticationkey="${my_key}"><QUERY/></REQUEST>',
        headers: { "Content-Type": "application/xml" },
      },
      { credentials: { my_key: { title: "Key" } } },
    );
    let captured: RequestInit | undefined;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return new Response("<ok/>", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchEndpoint(feed, "main", fetchFn, { env: { POST_MY_KEY: "sekret" } });
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe('<REQUEST authenticationkey="sekret"><QUERY/></REQUEST>');
    expect(new Headers(captured?.headers).get("Content-Type")).toBe("application/xml");
  });

  it("rejects a body naming something that is not a credential of the feed", async () => {
    const feed = makeFeed("post-leaky", {
      method: "POST",
      url: "https://api.test/query",
      // The feed declares no DATABASE_URL credential — the template-exfiltration
      // guard must reject this even though the var happens to be set.
      body: '<REQUEST secret="${DATABASE_URL}"/>',
    });
    await expect(
      fetchEndpoint(
        feed,
        "main",
        (async () => new Response("<ok/>", { status: 200 })) as unknown as typeof fetch,
        { env: { DATABASE_URL: "postgres://leak" } },
      ),
    ).rejects.toThrow(/DATABASE_URL.*not a credential/);
  });
});

describe("fetchEndpoint — redaction", () => {
  it("scrubs a path-embedded secret out of the fan-out sub-feed warn log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { feed, opts } = cataloguedFeed(
        "path-secret",
        ["https://mobilithek.test/subscription/999999secretid/clientPullService"],
        {
          credentials: { subscription_id: { title: "Subscription" } },
          endpoints: {
            main: { url: "https://mobilithek.test/index/${subscription_id}", cadenceSec: 300 },
          },
        },
      );
      await expect(
        fetchEndpoint(
          feed,
          "main",
          (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
          { ...opts, env: { PATH_SECRET_SUBSCRIPTION_ID: "999999secretid" } },
        ),
      ).rejects.toThrow();
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain("999999secretid");
      expect(logged).toContain("***");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("fetchEndpoint — conditional GET", () => {
  it("returns unchanged and reuses the cached buffer on a 304", async () => {
    const feed = makeFeed("cond", { url: "https://h.test/f.xml" });
    const state = createFetchState();
    let call = 0;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Response("payload-v1", { status: 200, headers: { ETag: 'W/"v1"' } });
      }
      const inm = new Headers(init?.headers).get("If-None-Match");
      expect(inm).toBe('W/"v1"');
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const first = await fetchEndpoint(feed, "main", fetchFn, { state });
    if (first.status === "fetched") first.accept();
    expect(first.status).toBe("fetched");
    expect(first.status === "fetched" && first.buffers[0]!.toString()).toBe("payload-v1");

    const second = await fetchEndpoint(feed, "main", fetchFn, { state });
    expect(second).toMatchObject({ status: "not-modified", validatedAtNetwork: true });
    expect(call).toBe(2);
  });

  it("keeps validators but does NOT retain the body for a single-url endpoint", async () => {
    // The off-heap-memory fix: a single-url feed skips whole on 304, so its body
    // is never re-read and must not be cached (it was ~1 GB across all feeds).
    const url = "https://h.test/single.xml";
    const feed = makeFeed("single-nobody", { url });
    const state = createFetchState();
    const fetchFn = (async () =>
      new Response("payload", {
        status: 200,
        headers: { ETag: 'W/"v1"' },
      })) as unknown as typeof fetch;

    const res = await fetchEndpoint(feed, "main", fetchFn, { state });
    if (res.status === "fetched") res.accept();
    expect(res.status).toBe("fetched");
    const entry = state.conditional.get(`${feed.id}#main\0${url}`);
    expect(entry?.etag).toBe('W/"v1"'); // validators kept → conditional GET still works
    expect(entry?.buffer).toBeUndefined(); // body NOT retained
  });

  it("retains bodies for a multi-url endpoint and re-parses a 304 url beside a changed sibling", async () => {
    const a = "https://h.test/a.xml";
    const b = "https://h.test/b.xml";
    const feed = makeFeed("multi", { urls: [a, b] });
    const state = createFetchState();
    let round = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (round === 0) {
        return new Response(`${url}-v1`, { status: 200, headers: { ETag: `"${url}-v1"` } });
      }
      if (url === a) {
        expect(new Headers(init?.headers).get("If-None-Match")).toBe(`"${a}-v1"`);
        return new Response(null, { status: 304 }); // A unchanged
      }
      return new Response(`${url}-v2`, { status: 200, headers: { ETag: `"${url}-v2"` } }); // B changed
    }) as unknown as typeof fetch;

    const first = await fetchEndpoint(feed, "main", fetchFn, { state });
    if (first.status === "fetched") first.accept();
    expect(first.status).toBe("fetched");
    expect(state.conditional.get(`${feed.id}#main\0${a}`)?.buffer?.toString()).toBe(`${a}-v1`); // both retained (multi-url)
    expect(state.conditional.get(`${feed.id}#main\0${b}`)?.buffer?.toString()).toBe(`${b}-v1`);

    round = 1;
    const second = await fetchEndpoint(feed, "main", fetchFn, { state });
    // A comes from cache (304), B is fresh — the full source is re-parsed, in order.
    const bodies = second.status === "fetched" ? second.buffers.map((x) => x.toString()) : [];
    expect(bodies).toEqual([`${a}-v1`, `${b}-v2`]);
  });

  it("keeps each role's validators apart, even for one shared url", async () => {
    const url = "https://h.test/shared";
    const feed = catalogFeed({
      id: "roles",
      endpoints: {
        main: { url, cadenceSec: 60 },
        detail: { url, cadenceSec: 300 },
      },
    });
    const state = createFetchState();
    const seen: (string | null)[] = [];
    const fetchFn = (async (_input: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("If-None-Match"));
      return new Response("body", { status: 200, headers: { ETag: '"v1"' } });
    }) as unknown as typeof fetch;

    const main = await fetchEndpoint(feed, "main", fetchFn, { state });
    if (main.status === "fetched") main.accept();
    await fetchEndpoint(feed, "detail", fetchFn, { state });
    expect(seen).toEqual([null, null]);
    expect([...state.conditional.keys()]).toEqual([`roles#main\0${url}`]);
  });

  it("drops a feed's validators when its definition changes", async () => {
    const url = "https://h.test/f.xml";
    const state = createFetchState();
    const seen: (string | null)[] = [];
    const fetchFn = (async (_input: string, init?: RequestInit) => {
      const inm = new Headers(init?.headers).get("If-None-Match");
      seen.push(inm);
      return inm
        ? new Response(null, { status: 304 })
        : new Response("body", { status: 200, headers: { ETag: '"v1"' } });
    }) as unknown as typeof fetch;

    const first = await fetchEndpoint(makeFeed("cfg", { url }), "main", fetchFn, { state });
    if (first.status === "fetched") first.accept();
    const changed = makeFeed("cfg", { url }, { format: "datex2" });
    const second = await fetchEndpoint(changed, "main", fetchFn, { state });
    expect(second.status).toBe("fetched");
    expect(seen).toEqual([null, null]);
  });
});

describe("fetchEndpoint — operational outcomes", () => {
  it("reports an endpoint whose expand value is empty as missing configuration", async () => {
    const result = await fetchEndpoint(
      makeFeed(
        "dormant",
        { url: "https://h.test/${endpoint}", expand: "endpoint" },
        { credentials: { endpoint: { title: "Endpoint" } } },
      ),
      "main",
      vi.fn() as unknown as typeof fetch,
      { state: createFetchState(), env: {} },
    );

    expect(result).toEqual({
      status: "no-endpoint",
      reason: "missing-configuration",
      validatedAtNetwork: false,
    });
  });

  it("reports a tolerant fan-out with a failed partition as partial", async () => {
    const result = await fetchEndpoint(
      makeFeed("partial-static", {
        urls: ["https://h.test/ok", "https://h.test/fail"],
        fanout: "tolerant",
      }),
      "main",
      (async (input: string | URL | Request) =>
        String(input).endsWith("/fail")
          ? new Response("bad", { status: 503 })
          : new Response("ok", { status: 200 })) as typeof fetch,
      { state: createFetchState() },
    );

    expect(result).toMatchObject({
      status: "partial",
      validatedAtNetwork: false,
      partitions: { succeeded: 1, failed: 1, total: 2 },
    });
  });
});

describe("snapshot acceptance", () => {
  it.each([{}, { value: null }, { value: {} }])(
    "rejects a malformed terminal collection: %j",
    async (terminal) => {
      let page = 0;
      const fetch = (async () =>
        new Response(
          JSON.stringify(++page === 1 ? { value: [{}] } : terminal),
        )) as typeof globalThis.fetch;
      await expect(
        fetchEndpoint(
          makeFeed("malformed-page", {
            url: "https://pages.test/data",
            pagination: { skipParam: "offset", pageSize: 1 },
          }),
          "main",
          fetch,
        ),
      ).rejects.toThrow(/pagination/);
    },
  );

  it("does not publish validators for an unaccepted mixed 200/304 snapshot", async () => {
    const state = createFetchState();
    const feed = makeFeed("accept-mixed", {
      urls: ["https://accept.test/a", "https://accept.test/b"],
    });
    let revision = 1;
    const seen: Array<[string, string | null]> = [];
    const fetch = (async (url, init) => {
      const tag = new Headers(init?.headers).get("if-none-match");
      seen.push([String(url), tag]);
      const current = String(url).endsWith("/a") ? "1" : String(revision);
      return tag === current
        ? new Response(null, { status: 304 })
        : new Response(current, { headers: { etag: current } });
    }) as typeof globalThis.fetch;
    const first = await fetchEndpoint(feed, "main", fetch, { state });
    if (first.status !== "fetched") throw new Error("expected first snapshot");
    expect(state.conditional.size).toBe(0);
    first.accept();
    revision = 2;
    const failed = await fetchEndpoint(feed, "main", fetch, { state });
    expect(failed.status).toBe("fetched");
    // Publication fails: the caller intentionally does not accept this result.
    const retry = await fetchEndpoint(feed, "main", fetch, { state });
    expect(seen.slice(-2)).toEqual([
      ["https://accept.test/a", "1"],
      ["https://accept.test/b", "1"],
    ]);
    if (retry.status !== "fetched") throw new Error("expected retry snapshot");
    expect(retry.buffers.map(String)).toEqual(["1", "2"]);
    retry.accept();
    expect((await fetchEndpoint(feed, "main", fetch, { state })).status).toBe("not-modified");
  });
});

describe("payload digests", () => {
  it("returns one credential-free digest per buffer, in buffer order", async () => {
    const src = makeFeed("digests", {
      urls: ["https://a.test/x?apikey=SECRET", "https://b.test/y"],
    });
    const res = await fetchEndpoint(
      src,
      "main",
      okFor((url) => `body:${new URL(url).host}`),
      { state: createFetchState() },
    );
    expect(res.status).toBe("fetched");
    if (res.status !== "fetched") return;
    expect(res.payloads.map((p) => p.sha256)).toEqual(
      res.buffers.map((b) => digestPayload("", b).sha256),
    );
    expect(res.payloads.map((p) => p.bytes)).toEqual(res.buffers.map((b) => b.length));
    expect(res.payloads[0]!.url).not.toContain("SECRET");
    expect(res.payloads[1]!.url).toBe("https://b.test/y");
  });
});
