import { afterEach, describe, expect, it } from "vitest";
import type { FeedSourceBase } from "../feed-source.js";
import { fetchAll } from "../fetch.js";
import { __resetCatalogResolvers, createFetchState, registerCatalogResolver } from "../index.js";
import { resolveFeedUrls } from "../template.js";

type TestFeedSource = FeedSourceBase;

function makeFeed(overrides: Partial<TestFeedSource> & Pick<TestFeedSource, "id">): TestFeedSource {
  return {
    name: overrides.id,
    format: "autobahn-json",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "test",
    attribution: "test",
    country: "XX",
    privacyUrl: "https://example.test/privacy",
    enabledByDefault: false,
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

describe("fetchAll — url templates", () => {
  it("interpolates a ${VAR} url from resolvedEnv", async () => {
    const feed = makeFeed({ id: "tpl", url: "https://h.test/f?k=${K}" });
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
