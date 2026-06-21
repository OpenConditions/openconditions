import { describe, it, expect } from "vitest";
import { isStale, freshnessNow } from "../freshness.js";

describe("isStale", () => {
  const BASE = "2026-01-01T12:00:00Z";

  it("returns false when dataUpdatedAt is within the window", () => {
    const now = new Date("2026-01-01T12:04:59Z");
    expect(isStale(BASE, 300, now)).toBe(false);
  });

  it("returns true when dataUpdatedAt is exactly at the window boundary", () => {
    const now = new Date("2026-01-01T12:05:00Z");
    expect(isStale(BASE, 300, now)).toBe(true);
  });

  it("returns true when dataUpdatedAt is beyond the window", () => {
    const now = new Date("2026-01-01T13:00:00Z");
    expect(isStale(BASE, 300, now)).toBe(true);
  });
});

describe("freshnessNow", () => {
  it("returns isStale:false and age for fresh data", () => {
    const dataUpdatedAt = "2026-01-01T12:00:00Z";
    const now = new Date("2026-01-01T12:01:00Z");
    const result = freshnessNow(dataUpdatedAt, 300, now);
    expect(result.isStale).toBe(false);
    expect(result.ageSeconds).toBe(60);
  });

  it("returns isStale:true for stale data", () => {
    const dataUpdatedAt = "2026-01-01T12:00:00Z";
    const now = new Date("2026-01-01T13:00:00Z");
    const result = freshnessNow(dataUpdatedAt, 300, now);
    expect(result.isStale).toBe(true);
    expect(result.ageSeconds).toBe(3600);
  });
});
