import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { FEED_SOURCES } from "@openconditions/roads";
import type { FeedSource } from "@openconditions/roads";
import { clearSiteTableCache, loadSiteTable } from "../pipeline/site-table.js";
import { streamMeasuredData } from "../pipeline/measured-data.js";
import type { DomainFeedSource } from "../pipeline/run.js";

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
