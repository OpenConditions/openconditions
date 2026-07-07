import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { FEED_SOURCES } from "@openconditions/roads";
import type { FeedSource } from "@openconditions/roads";
import { clearSiteTableCache, loadSiteTable } from "../pipeline/site-table.js";
import { streamMeasuredData } from "../pipeline/measured-data.js";
import type { DomainFeedSource } from "../pipeline/run.js";
import { isTransientSocketError, withStreamRetry } from "../pipeline/stream-retry.js";

/** undici's real shape for a mid-stream drop: `terminated` wrapping UND_ERR_SOCKET. */
function terminatedError(): Error {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  return new TypeError("terminated", { cause });
}

/**
 * A Readable that errors on first read, mimicking undici's `SocketError: other
 * side closed` when an upstream drops a large gzipped download mid-stream.
 *
 * Pre-fix the streaming consumers wired the body via `source.pipe(gunzip)`, which
 * does NOT forward the source's 'error' — so this would surface as an unhandled
 * 'error' event and crash the whole process (these tests would abort, not fail).
 * The fix forwards it so the error is caught and handled gracefully.
 */
function erroringStream(): Readable {
  return new Readable({
    read() {
      this.destroy(new Error("other side closed"));
    },
  });
}

describe("streaming feed error handling", () => {
  it("loadSiteTable catches a mid-stream source error and falls back (no crash)", async () => {
    clearSiteTableCache();
    const feed = {
      id: "test-flow",
      siteTable: { url: "http://example.test/site.xml.gz", gzip: true },
    } as unknown as FeedSource;

    const map = await loadSiteTable(
      feed,
      async () => erroringStream(),
      () => 0
    );
    // The error is caught; with no prior cache there is nothing to fall back to.
    expect(map).toBeUndefined();
  });

  it("streamMeasuredData rejects (does not crash) on a mid-stream source error", async () => {
    const feed = FEED_SOURCES.find((f) => f.id === "ndw-flow")!;
    const src = { ...feed, domain: "roads" } as DomainFeedSource;

    await expect(
      streamMeasuredData(
        src,
        async () => erroringStream(),
        undefined,
        () => new Date(0).toISOString()
      )
    ).rejects.toThrow();
  });
});

describe("withStreamRetry", () => {
  it("retries a transient socket drop with a fresh attempt and succeeds", async () => {
    let calls = 0;
    const result = await withStreamRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw terminatedError();
        return "ok";
      },
      "test-feed",
      { baseDelayMs: 0 }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("gives up after the retry budget and rethrows the transient error", async () => {
    let calls = 0;
    await expect(
      withStreamRetry(
        async () => {
          calls += 1;
          throw terminatedError();
        },
        "test-feed",
        { retries: 2, baseDelayMs: 0 }
      )
    ).rejects.toThrow(/terminated/);
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  it("does not retry a non-transient error (throws on the first attempt)", async () => {
    let calls = 0;
    await expect(
      withStreamRetry(
        async () => {
          calls += 1;
          throw new Error("HTTP 500 fetching x");
        },
        "test-feed",
        { baseDelayMs: 0 }
      )
    ).rejects.toThrow("HTTP 500");
    expect(calls).toBe(1);
  });
});

describe("isTransientSocketError", () => {
  it("recognizes undici terminated / UND_ERR_SOCKET through the cause chain", () => {
    expect(isTransientSocketError(terminatedError())).toBe(true);
    expect(isTransientSocketError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(
      true
    );
    expect(isTransientSocketError(new Error("socket hang up"))).toBe(true);
  });

  it("does not treat HTTP status, decompression-cap, or parse errors as transient", () => {
    expect(isTransientSocketError(new Error("HTTP 503 fetching x"))).toBe(false);
    expect(isTransientSocketError(new Error("decompressed stream exceeded 512 bytes"))).toBe(false);
    expect(isTransientSocketError(new Error("invalid XML"))).toBe(false);
  });
});
