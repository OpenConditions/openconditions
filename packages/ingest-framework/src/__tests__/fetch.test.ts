import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedSourceBase } from "../feed-source.js";
import { fetchAll } from "../fetch.js";
import { __resetCatalogResolvers, createFetchState, registerCatalogResolver } from "../index.js";
import { resolveFeedUrls } from "../template.js";

type TestFeedSource = FeedSourceBase;

function makeFeed(overrides: Partial<TestFeedSource> & Pick<TestFeedSource, "id">): TestFeedSource {
  return {
    name: overrides.id,
    operator: "test",
    format: "autobahn",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "test",
    attribution: "test",
    country: "XX",
    privacyUrl: "https://example.test/privacy",
    ...overrides,
  };
}

/**
 * Builds a feed backed by a one-off catalog resolver that resolves the given
 * URLs into concrete feed descriptors, so the catalog fan-out (bounded
 * concurrency + per-URL tolerance) can be exercised through `fetchAll`.
 */
function catalogFeed(
  id: string,
  urls: string[],
  extra: Partial<TestFeedSource> = {}
): TestFeedSource {
  const resolverId = `res-${id}`;
  registerCatalogResolver("test", {
    id: resolverId,
    snapshotPath: "/nonexistent.json",
    resolve: async () => urls.map((url, i) => makeFeed({ id: `${id}-${i}`, format: "wzdx", url })),
  });
  return makeFeed({ id, catalog: { resolver: resolverId }, ...extra });
}

const okFor = (
  body: (url: string) => string,
  fail: (url: string) => boolean = () => false
): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (fail(url)) return new Response("err", { status: 500 });
    return new Response(body(url), { status: 200 });
  }) as unknown as typeof fetch;

/** Fetch and unwrap the buffers, treating an "unchanged" result as no buffers. */
async function fetchBuffers(
  src: Parameters<typeof fetchAll>[0],
  fetchFn: typeof fetch
): Promise<Buffer[]> {
  const res = await fetchAll(src, fetchFn);
  return res.status === "fetched" ? res.buffers : [];
}

/**
 * A DataMall-style OData source: `{ value: [...] }` pages of at most `pageSize`
 * rows, addressed by `$skip`. `pageRows[n]` is how many rows page n returns;
 * a page beyond the array returns zero rows.
 */
function pagedODataFetch(
  pageRows: number[],
  pageSize = 500
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
    0
  );
}

describe("fetchAll — offset pagination", () => {
  const pagedFeed = (extra: Partial<TestFeedSource> = {}): TestFeedSource =>
    makeFeed({
      id: "paged",
      format: "lta-speedbands",
      url: "https://datamall.test/TrafficSpeedBands",
      pagination: { skipParam: "$skip", pageSize: 500 },
      ...extra,
    });

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

  it("caps at maxPages when the source never returns a short page", async () => {
    const { fetchFn, calls } = pagedODataFetch([500, 500, 500, 500, 500]);
    const bufs = await fetchBuffers(
      pagedFeed({ pagination: { skipParam: "$skip", pageSize: 500, maxPages: 2 } }),
      fetchFn
    );
    expect(bufs).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

describe("fetchAll — catalog fan-out", () => {
  afterEach(() => __resetCatalogResolvers());

  it("fetches every URL the catalog resolver returns", async () => {
    const urls = ["https://x.test/1", "https://x.test/2", "https://x.test/3"];
    const feed = catalogFeed("disc", urls);
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => `body:${u}`)
    );
    expect(bufs.map((b) => b.toString("utf8")).sort()).toEqual(urls.map((u) => `body:${u}`).sort());
  });

  it("prefers the catalog over a static url when both are present", async () => {
    const feed = catalogFeed("both", ["https://x.test/a"], {
      url: "https://static.test/should-not-be-used",
    });
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => u)
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toBe("https://x.test/a");
  });

  it("tolerates a failing sub-feed and returns the rest", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const feed = catalogFeed("tol", urls);
    const bufs = await fetchBuffers(
      feed,
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad")
      )
    );
    expect(bufs).toHaveLength(2);
    expect(bufs.map((b) => b.toString("utf8"))).not.toContain("body:https://x.test/bad");
  });

  it("reports the partial-failure signal (failures/total) alongside the surviving buffers", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const feed = catalogFeed("tol-signal", urls);
    const res = await fetchAll(
      feed,
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad")
      )
    );
    expect(res.status).toBe("fetched");
    if (res.status !== "fetched") throw new Error("unreachable");
    expect(res.buffers).toHaveLength(2);
    expect(res.partial).toEqual({ failures: 1, total: 3 });
  });

  it("drops a sub-feed that returns an HTML block/error page (200) and keeps the JSON ones", async () => {
    const urls = ["https://x.test/json", "https://x.test/html"];
    const feed = catalogFeed("html", urls);
    const bufs = await fetchBuffers(
      feed,
      okFor((u) =>
        u.endsWith("/html")
          ? "  <!DOCTYPE html><html>blocked</html>"
          : `{"feed":${JSON.stringify(u)}}`
      )
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toContain('"feed"');
  });

  it("throws when every resolved sub-feed fails (preserves last-good upstream)", async () => {
    const feed = catalogFeed("allbad", ["https://x.test/1", "https://x.test/2"]);
    await expect(
      fetchAll(
        feed,
        okFor(
          (u) => u,
          () => true
        )
      )
    ).rejects.toThrow(/all .*sub-feed/);
  });

  it("returns nothing (no throw) when the catalog yields zero URLs", async () => {
    const feed = catalogFeed("empty", []);
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => u)
    );
    expect(bufs).toEqual([]);
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
    const feed = catalogFeed("conc", urls);
    const bufs = await fetchBuffers(feed, fetchFn);
    expect(bufs).toHaveLength(20);
    expect(maxInFlight).toBe(8);
  });
});

describe("fetchAll — static url forms (regression)", () => {
  it("fetches a single string url", async () => {
    const feed = makeFeed({ id: "s", url: "https://x.test/one" });
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => `body:${u}`)
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toBe("body:https://x.test/one");
  });

  it("leaves the partial-failure signal undefined on the non-fanout static path", async () => {
    const feed = makeFeed({ id: "s-no-partial", url: "https://x.test/one" });
    const res = await fetchAll(
      feed,
      okFor((u) => `body:${u}`)
    );
    expect(res.status).toBe("fetched");
    if (res.status !== "fetched") throw new Error("unreachable");
    expect(res.partial).toBeUndefined();
  });

  it("fetches every url of a string array", async () => {
    const feed = makeFeed({ id: "arr", url: ["https://x.test/a", "https://x.test/b"] });
    const bufs = await fetchBuffers(
      feed,
      okFor((u) => u)
    );
    expect(bufs.map((b) => b.toString("utf8")).sort()).toEqual([
      "https://x.test/a",
      "https://x.test/b",
    ]);
  });

  it("does not HTML-filter the single-url path (XML feeds like NDW pass through)", async () => {
    const feed = makeFeed({ id: "xml", url: "https://x.test/ndw.xml" });
    const bufs = await fetchBuffers(
      feed,
      okFor(() => '<?xml version="1.0"?><d2:payload/>')
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toContain("<?xml");
  });

  it("throws when a feed has neither url nor catalog", async () => {
    const feed = makeFeed({ id: "none" });
    await expect(
      fetchAll(
        feed,
        okFor((u) => u)
      )
    ).rejects.toThrow(/neither url nor catalog/);
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
    const feed = makeFeed({ id: "conc-static", url: urls });
    const bufs = await fetchBuffers(feed, fetchFn);
    expect(bufs).toHaveLength(20);
    expect(maxInFlight).toBe(8);
  });
});

describe("fetchAll — fanoutTolerant static url arrays", () => {
  it("tolerates a failing url and returns the buffers from the rest", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const feed = makeFeed({ id: "fanout-tol", url: urls, fanoutTolerant: true });
    const bufs = await fetchBuffers(
      feed,
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad")
      )
    );
    expect(bufs).toHaveLength(2);
    expect(bufs.map((b) => b.toString("utf8"))).not.toContain("body:https://x.test/bad");
  });

  it("reports the partial-failure signal for a fanoutTolerant static url array", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const feed = makeFeed({ id: "fanout-tol-signal", url: urls, fanoutTolerant: true });
    const res = await fetchAll(
      feed,
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad")
      )
    );
    expect(res.status).toBe("fetched");
    if (res.status !== "fetched") throw new Error("unreachable");
    expect(res.buffers).toHaveLength(2);
    expect(res.partial).toEqual({ failures: 1, total: 3 });
  });

  it("does not affect a static url array without the flag (one failure still throws)", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const feed = makeFeed({ id: "no-fanout-tol", url: urls });
    await expect(
      fetchAll(
        feed,
        okFor(
          (u) => `body:${u}`,
          (u) => u.endsWith("/bad")
        )
      )
    ).rejects.toThrow();
  });

  it("leaves a single-url fanoutTolerant feed on the normal static path (conditional GET still applies)", async () => {
    const feed = makeFeed({
      id: "fanout-tol-single",
      url: "https://h.test/f.xml",
      fanoutTolerant: true,
    });
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

    const first = await fetchAll(feed, fetchFn, { state });
    expect(first.status).toBe("fetched");
    const second = await fetchAll(feed, fetchFn, { state });
    expect(second.status).toBe("unchanged");
  });
});

describe("fetchAll — url templates", () => {
  it("interpolates a ${VAR} url from resolvedEnv", async () => {
    const feed = makeFeed({ id: "tpl", url: "https://h.test/f?k=${K}", requiredEnv: ["K"] });
    const seen: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    process.env.K = "secret";
    try {
      await fetchAll({ ...feed }, fetchFn);
    } finally {
      delete process.env.K;
    }
    expect(seen).toEqual(["https://h.test/f?k=secret"]);
    expect(resolveFeedUrls(feed, { K: "secret", id: feed.id })).toEqual([
      "https://h.test/f?k=secret",
    ]);
  });

  it("expands a Mobilithek-style expandEnv feed to one url per subscription id", async () => {
    const feed = makeFeed({
      id: "mob",
      url: "https://m.test/subscription/${SUB}/pull?subscriptionID=${SUB}",
      expandEnv: "SUB",
      requiredEnv: ["SUB"],
    });
    const urls = resolveFeedUrls(feed, { SUB: "a, b", id: feed.id });
    expect(urls).toEqual([
      "https://m.test/subscription/a/pull?subscriptionID=a",
      "https://m.test/subscription/b/pull?subscriptionID=b",
    ]);
  });
});

describe("fetchAll — POST body template", () => {
  it("sends an interpolated bodyTemplate on a POST feed", async () => {
    const feed = makeFeed({
      id: "post",
      method: "POST",
      url: "https://api.test/query",
      bodyTemplate: '<REQUEST authenticationkey="${MY_KEY}"><QUERY/></REQUEST>',
      requestHeaders: { "Content-Type": "application/xml" },
      requiredEnv: ["MY_KEY"],
    });
    let capturedBody: unknown;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body;
      return new Response("<ok/>", { status: 200 });
    }) as unknown as typeof fetch;
    process.env.MY_KEY = "sekret";
    try {
      await fetchAll(feed, fetchFn);
    } finally {
      delete process.env.MY_KEY;
    }
    expect(capturedBody).toBe('<REQUEST authenticationkey="sekret"><QUERY/></REQUEST>');
  });

  it("rejects a bodyTemplate referencing a var outside requiredEnv/auth (undeclared)", async () => {
    const feed = makeFeed({
      id: "post-leaky",
      method: "POST",
      url: "https://api.test/query",
      // No requiredEnv/auth declares DATABASE_URL — the template-exfiltration guard
      // must reject this even though the var happens to be set in the process env.
      bodyTemplate: '<REQUEST secret="${DATABASE_URL}"/>',
    });
    process.env.DATABASE_URL = "postgres://leak";
    try {
      await expect(
        fetchAll(
          feed,
          (async () => new Response("<ok/>", { status: 200 })) as unknown as typeof fetch
        )
      ).rejects.toThrow(/undeclared variable DATABASE_URL/);
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});

describe("fetchAll — redaction", () => {
  it("scrubs a path-embedded secret out of the fan-out sub-feed warn log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const feed = catalogFeed(
        "path-secret",
        ["https://mobilithek.test/subscription/999999secretid/clientPullService"],
        { requiredEnv: ["SUBSCRIPTION_ID"] }
      );
      process.env.SUBSCRIPTION_ID = "999999secretid";
      try {
        await expect(
          fetchAll(
            feed,
            (async () => new Response("err", { status: 500 })) as unknown as typeof fetch
          )
        ).rejects.toThrow();
      } finally {
        delete process.env.SUBSCRIPTION_ID;
      }
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain("999999secretid");
      expect(logged).toContain("***");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("fetchAll — conditional GET", () => {
  it("returns unchanged and reuses the cached buffer on a 304", async () => {
    const feed = makeFeed({ id: "cond", url: "https://h.test/f.xml" });
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

    const first = await fetchAll(feed, fetchFn, { state });
    expect(first.status).toBe("fetched");
    expect(first.status === "fetched" && first.buffers[0]!.toString()).toBe("payload-v1");

    const second = await fetchAll(feed, fetchFn, { state });
    expect(second.status).toBe("unchanged");
    expect(call).toBe(2);
  });

  it("keeps validators but does NOT retain the body for a single-url feed", async () => {
    // The off-heap-memory fix: a single-url feed skips whole on 304, so its body
    // is never re-read and must not be cached (it was ~1 GB across all feeds).
    const url = "https://h.test/single.xml";
    const feed = makeFeed({ id: "single-nobody", url });
    const state = createFetchState();
    const fetchFn = (async () =>
      new Response("payload", {
        status: 200,
        headers: { ETag: 'W/"v1"' },
      })) as unknown as typeof fetch;

    const res = await fetchAll(feed, fetchFn, { state });
    expect(res.status).toBe("fetched");
    const entry = state.conditional.get(url);
    expect(entry?.etag).toBe('W/"v1"'); // validators kept → conditional GET still works
    expect(entry?.buffer).toBeUndefined(); // body NOT retained
  });

  it("retains bodies for a multi-url feed and re-parses a 304 url beside a changed sibling", async () => {
    const a = "https://h.test/a.xml";
    const b = "https://h.test/b.xml";
    const feed = makeFeed({ id: "multi", url: [a, b] });
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

    const first = await fetchAll(feed, fetchFn, { state });
    expect(first.status).toBe("fetched");
    expect(state.conditional.get(a)?.buffer?.toString()).toBe(`${a}-v1`); // both retained (multi-url)
    expect(state.conditional.get(b)?.buffer?.toString()).toBe(`${b}-v1`);

    round = 1;
    const second = await fetchAll(feed, fetchFn, { state });
    // A comes from cache (304), B is fresh — the full source is re-parsed, in order.
    const bodies = second.status === "fetched" ? second.buffers.map((x) => x.toString()) : [];
    expect(bodies).toEqual([`${a}-v1`, `${b}-v2`]);
  });
});

describe("fetchAll — fetchIntervalSec gating", () => {
  it("skips the fetch entirely within the interval window", async () => {
    const feed = makeFeed({ id: "gated", url: "https://h.test/f.xml", fetchIntervalSec: 300 });
    const state = createFetchState();
    let clock = 1_000_000;
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      return new Response("body", { status: 200 });
    }) as unknown as typeof fetch;

    const first = await fetchAll(feed, fetchFn, { state, now: () => clock });
    expect(first.status).toBe("fetched");
    expect(call).toBe(1);

    clock += 60_000; // +60s, inside the 300s window
    const second = await fetchAll(feed, fetchFn, { state, now: () => clock });
    expect(second.status).toBe("unchanged");
    expect(call).toBe(1); // no second network call

    clock += 300_000; // past the window
    const third = await fetchAll(feed, fetchFn, { state, now: () => clock });
    expect(third.status).toBe("fetched");
    expect(call).toBe(2);
  });
});
