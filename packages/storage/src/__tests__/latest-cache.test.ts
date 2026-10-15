import { describe, expect, it } from "vitest";
import { LatestCache, type LatestEntry } from "../latest-cache.js";

const entry = (seriesId: number): LatestEntry => ({
  seriesId,
  contentHash: "a".repeat(64),
  effectiveFrom: 0,
  expiresAt: null,
  ended: false,
});

describe("the latest cache", () => {
  it("takes a write's entries only when its transaction commits", () => {
    const cache = new LatestCache();
    const write = cache.begin();
    write.set("s1", entry(1));
    expect(write.get("s1")).toBeUndefined();
    expect(cache.size).toBe(0);
    write.commit();
    expect(cache.begin().get("s1")).toEqual(entry(1));
  });

  it("forgets what a rolled-back write wrote, and keeps what it only saw", () => {
    const cache = new LatestCache();
    const first = cache.begin();
    first.set("s1", entry(1));
    first.set("s2", entry(2));
    first.commit();
    const failed = cache.begin();
    failed.set("s1", entry(10));
    failed.seen("s2");
    failed.delete("s3");
    failed.discard();
    const read = cache.begin();
    expect(read.get("s1")).toBeUndefined();
    expect(read.get("s2")).toEqual(entry(2));
  });

  it("drops a series a write learns nothing about", () => {
    const cache = new LatestCache();
    const first = cache.begin();
    first.set("s1", entry(1));
    first.commit();
    const second = cache.begin();
    second.delete("s1");
    second.commit();
    expect(cache.size).toBe(0);
  });

  it("holds at most its capacity, dropping the series a committed write saw least recently", () => {
    const cache = new LatestCache(2);
    const first = cache.begin();
    first.set("s1", entry(1));
    first.set("s2", entry(2));
    first.commit();
    const second = cache.begin();
    second.seen("s1");
    second.set("s3", entry(3));
    second.commit();
    const read = cache.begin();
    expect(cache.size).toBe(2);
    expect(read.get("s1")).toEqual(entry(1));
    expect(read.get("s2")).toBeUndefined();
    expect(read.get("s3")).toEqual(entry(3));
  });
});
