import { describe, expect, it } from "vitest";
import { FeedStatusStore } from "../feed-status.js";

describe("FeedStatusStore", () => {
  it("records a success and returns it", () => {
    const s = new FeedStatusStore();
    s.recordSuccess("ndw", "2026-07-01T00:00:00.000Z", 42, 1234);
    expect(s.get("ndw")).toEqual({
      lastRunAt: "2026-07-01T00:00:00.000Z",
      lastSuccessAt: "2026-07-01T00:00:00.000Z",
      lastRowCount: 42,
      lastDurationMs: 1234,
    });
  });

  it("records an error without clobbering the last success", () => {
    const s = new FeedStatusStore();
    s.recordSuccess("ndw", "2026-07-01T00:00:00.000Z", 42, 1000);
    s.recordError("ndw", "2026-07-01T00:05:00.000Z", "HTTP 503");
    const st = s.get("ndw");
    expect(st?.lastSuccessAt).toBe("2026-07-01T00:00:00.000Z");
    expect(st?.lastError).toBe("HTTP 503");
    expect(st?.lastErrorAt).toBe("2026-07-01T00:05:00.000Z");
    expect(st?.lastRunAt).toBe("2026-07-01T00:05:00.000Z");
  });

  it("clears a stale error once the feed recovers with a success", () => {
    const s = new FeedStatusStore();
    s.recordError("ndw", "2026-07-01T00:05:00.000Z", "HTTP 503");
    s.recordSuccess("ndw", "2026-07-01T00:10:00.000Z", 42, 1000);
    const st = s.get("ndw");
    expect(st?.lastError).toBeUndefined();
    expect(st?.lastErrorAt).toBeUndefined();
    expect(st?.lastSuccessAt).toBe("2026-07-01T00:10:00.000Z");
    expect(st?.lastRowCount).toBe(42);
  });

  it("returns undefined for an unknown feed and a snapshot from all()", () => {
    const s = new FeedStatusStore();
    expect(s.get("nope")).toBeUndefined();
    s.recordSuccess("a", "2026-07-01T00:00:00.000Z", 1, 1);
    expect(Object.keys(s.all())).toEqual(["a"]);
  });

  it("redacts URL query values in recorded error messages", () => {
    const s = new FeedStatusStore();
    s.recordError(
      "k",
      "2026-07-01T00:00:00.000Z",
      "fetch failed for https://api.example.com/v2/get?key=SECRET123&x=1"
    );
    expect(s.get("k")?.lastError).not.toContain("SECRET123");
    expect(s.get("k")?.lastError).toContain("***");
  });
});
