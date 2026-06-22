import { describe, expect, it } from "vitest";
import type { FeedSource } from "@openconditions/roads";
import { fetchAll } from "../pipeline/fetch.js";

function makeFeed(overrides: Partial<FeedSource> & Pick<FeedSource, "id">): FeedSource {
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

const okFor = (
  body: (url: string) => string,
  fail: (url: string) => boolean = () => false
): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (fail(url)) return new Response("err", { status: 500 });
    return new Response(body(url), { status: 200 });
  }) as unknown as typeof fetch;

describe("fetchAll — discover fan-out", () => {
  it("fetches every URL the discover function returns", async () => {
    const urls = ["https://x.test/1", "https://x.test/2", "https://x.test/3"];
    const feed = makeFeed({ id: "disc", discover: async () => urls });
    const bufs = await fetchAll(
      feed,
      okFor((u) => `body:${u}`)
    );
    expect(bufs.map((b) => b.toString("utf8")).sort()).toEqual(urls.map((u) => `body:${u}`).sort());
  });

  it("prefers discover over a static url when both are present", async () => {
    const feed = makeFeed({
      id: "both",
      url: "https://static.test/should-not-be-used",
      discover: async () => ["https://x.test/a"],
    });
    const bufs = await fetchAll(
      feed,
      okFor((u) => u)
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toBe("https://x.test/a");
  });

  it("tolerates a failing sub-feed and returns the rest", async () => {
    const urls = ["https://x.test/ok1", "https://x.test/bad", "https://x.test/ok2"];
    const feed = makeFeed({ id: "tol", discover: async () => urls });
    const bufs = await fetchAll(
      feed,
      okFor(
        (u) => `body:${u}`,
        (u) => u.endsWith("/bad")
      )
    );
    expect(bufs).toHaveLength(2);
    expect(bufs.map((b) => b.toString("utf8"))).not.toContain("body:https://x.test/bad");
  });

  it("throws when every discovered sub-feed fails (preserves last-good upstream)", async () => {
    const feed = makeFeed({
      id: "allbad",
      discover: async () => ["https://x.test/1", "https://x.test/2"],
    });
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

  it("returns nothing (no throw) when discover yields zero URLs", async () => {
    const feed = makeFeed({ id: "empty", discover: async () => [] });
    const bufs = await fetchAll(
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
    const feed = makeFeed({ id: "conc", discover: async () => urls });
    const bufs = await fetchAll(feed, fetchFn);
    expect(bufs).toHaveLength(20);
    expect(maxInFlight).toBe(8);
  });
});

describe("fetchAll — static url forms (regression)", () => {
  it("fetches a single string url", async () => {
    const feed = makeFeed({ id: "s", url: "https://x.test/one" });
    const bufs = await fetchAll(
      feed,
      okFor((u) => `body:${u}`)
    );
    expect(bufs).toHaveLength(1);
    expect(bufs[0]!.toString("utf8")).toBe("body:https://x.test/one");
  });

  it("fetches every url of a string array", async () => {
    const feed = makeFeed({ id: "arr", url: ["https://x.test/a", "https://x.test/b"] });
    const bufs = await fetchAll(
      feed,
      okFor((u) => u)
    );
    expect(bufs.map((b) => b.toString("utf8")).sort()).toEqual([
      "https://x.test/a",
      "https://x.test/b",
    ]);
  });

  it("resolves a function url against env", async () => {
    const feed = makeFeed({ id: "fn", url: () => "https://x.test/fn" });
    const bufs = await fetchAll(
      feed,
      okFor((u) => u)
    );
    expect(bufs[0]!.toString("utf8")).toBe("https://x.test/fn");
  });

  it("throws when a feed has neither url nor discover", async () => {
    const feed = makeFeed({ id: "none" });
    await expect(
      fetchAll(
        feed,
        okFor((u) => u)
      )
    ).rejects.toThrow(/neither url nor discover/);
  });
});
