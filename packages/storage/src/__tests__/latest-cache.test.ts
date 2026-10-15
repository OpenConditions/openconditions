import { describe, expect, it } from "vitest";
import {
  LatestCache,
  type LatestEntry,
  latestCacheBudget,
  latestCacheBudgetFromEnv,
} from "../latest-cache.js";

const entry = (seriesId: number): LatestEntry => ({
  seriesId,
  contentHash: "a".repeat(64),
  effectiveFrom: 0,
  expiresAt: null,
  ended: false,
});

/** A cache of `budget` entries whose refusals are collected, at a clock the test moves. */
function cacheOf(budget: number) {
  const logged: string[] = [];
  const clock = { now: 0 };
  const cache = new LatestCache(budget, { log: (m) => logged.push(m), now: () => clock.now });
  return { cache, logged, clock };
}

/** Commits one poll of `source` stating `series`, each written anew. */
function poll(cache: LatestCache, source: string, series: readonly string[]) {
  const write = cache.begin(source);
  for (const [i, key] of series.entries()) write.set(key, entry(i));
  write.commit();
}

const keys = (source: string, n: number) => Array.from({ length: n }, (_, i) => `${source}/${i}`);

describe("the latest cache", () => {
  it("takes a write's entries only when its transaction commits", () => {
    const { cache } = cacheOf(10);
    const write = cache.begin("a");
    write.set("s1", entry(1));
    expect(write.get("s1")).toBeUndefined();
    expect(cache.size).toBe(0);
    write.commit();
    expect(cache.begin("a").get("s1")).toEqual(entry(1));
  });

  it("forgets what a rolled-back write wrote, and keeps what it only saw", () => {
    const { cache } = cacheOf(10);
    poll(cache, "a", ["s1", "s2"]);
    const failed = cache.begin("a");
    failed.set("s1", entry(10));
    failed.seen("s2");
    failed.delete("s3");
    failed.discard();
    const read = cache.begin("a");
    expect(read.get("s1")).toBeUndefined();
    expect(read.get("s2")).toEqual(entry(1));
  });

  it("keeps of a source what its last poll saw or wrote, releasing the series it no longer states", () => {
    const { cache } = cacheOf(10);
    poll(cache, "a", ["s1", "s2", "s3"]);
    const next = cache.begin("a");
    next.seen("s1");
    next.set("s2", entry(20));
    next.delete("s3");
    next.commit();
    const read = cache.begin("a");
    expect(cache.sizeOf("a")).toBe(2);
    expect(read.get("s1")).toEqual(entry(0));
    expect(read.get("s2")).toEqual(entry(20));
    expect(read.get("s3")).toBeUndefined();
  });

  it("caches a source whole or not at all, first come within the budget, and says so once", () => {
    const { cache, logged } = cacheOf(5);
    poll(cache, "a", keys("a", 3));
    poll(cache, "b", keys("b", 3));
    poll(cache, "b", keys("b", 3));
    poll(cache, "a", keys("a", 3));
    expect(cache.sizeOf("a")).toBe(3);
    expect(cache.sizeOf("b")).toBe(0);
    expect(cache.begin("b").get("b/0")).toBeUndefined();
    expect(cache.begin("a").get("a/0")).toEqual(entry(0));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/b: 3 series .* 2 of 5/);
  });

  it("takes a refused source once the budget it lacked frees up", () => {
    const { cache } = cacheOf(5);
    poll(cache, "a", keys("a", 3));
    poll(cache, "b", keys("b", 3));
    poll(cache, "a", keys("a", 1));
    poll(cache, "b", keys("b", 3));
    expect(cache.sizeOf("a")).toBe(1);
    expect(cache.sizeOf("b")).toBe(3);
  });

  it("releases a source no longer polled", () => {
    const { cache, clock } = cacheOf(5);
    poll(cache, "a", keys("a", 3));
    clock.now += 3 * 3_600_000;
    poll(cache, "b", keys("b", 3));
    expect(cache.sizeOf("a")).toBe(0);
    expect(cache.sizeOf("b")).toBe(3);
  });

  it("budgets a share of the heap the process may grow to, unless set in MB", () => {
    expect(latestCacheBudget(4.4e9)).toBe(704_000);
    expect(latestCacheBudgetFromEnv({}, 4.4e9)).toBe(704_000);
    expect(latestCacheBudgetFromEnv({ OPENCONDITIONS_LATEST_CACHE_MB: "" }, 4.4e9)).toBe(704_000);
    expect(latestCacheBudgetFromEnv({ OPENCONDITIONS_LATEST_CACHE_MB: "50" }, 4.4e9)).toBe(100_000);
    expect(latestCacheBudgetFromEnv({ OPENCONDITIONS_LATEST_CACHE_MB: "0" }, 4.4e9)).toBe(0);
    expect(latestCacheBudgetFromEnv({ OPENCONDITIONS_LATEST_CACHE_MB: "x" }, 4.4e9)).toBe(704_000);
  });
});
