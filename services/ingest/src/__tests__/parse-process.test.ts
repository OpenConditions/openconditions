import { readFileSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import {
  type CatalogFeed,
  drainSkipped,
  type ParseContext,
} from "@openconditions/ingest-framework";
import { afterAll, describe, expect, it } from "vitest";
import { formatOf } from "../domains.js";
import { createParseProcess, ParseProcessError } from "../pipeline/parse-process.js";
import { inspectSnapshotCompleteness } from "../pipeline/snapshot-inspection.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";

const fixture = (path: string) => readFileSync(new URL(path, import.meta.url));
const BNETZA = fixture("../../../../packages/charging/src/__tests__/fixtures/bnetza.csv");
const NDW_EVENTS = fixture(
  "../../../../packages/roads/src/__tests__/fixtures/ndw/actueel_beeld.xml",
);

const ctx: ParseContext = { fetchedAt: "2026-10-13T20:00:00.000Z", cadenceSec: 300, reference: {} };
const child = createParseProcess();
afterAll(() => child.close());

/** The parse of the inline path, for comparison. */
function inline(feed: CatalogFeed, main: Buffer) {
  const output = formatOf(feed).parse(feed, { main: [main] }, ctx);
  return {
    output,
    inspection: inspectSnapshotCompleteness(feed, [main]),
    skipped: drainSkipped(feed.id),
  };
}

// Each case starts a child through tsx, and one lets it outgrow its heap:
// seconds on a shared CI runner.
describe("the parse process", { timeout: 60_000 }, () => {
  it("is handed every catalogue feed as it is", () => {
    for (const feed of [...REPO_CATALOG.feeds, ...REPO_CATALOG.disabled]) {
      expect(structuredClone(feed)).toEqual(feed);
    }
  });

  it("parses a register as the inline path does, held gzipped or as fetched", async () => {
    const feed = repoFeed("de-bnetza-charging");
    const expected = inline(feed, BNETZA);
    expect(expected.output.features.length).toBeGreaterThan(0);
    const fetched = await child.parse({
      feed,
      payloads: { main: [{ data: BNETZA, gzipped: false }] },
      ctx,
    });
    expect(fetched).toEqual(expected);
    const held = await child.parse({
      feed,
      payloads: { main: [{ data: gzipSync(BNETZA), gzipped: true }] },
      ctx,
    });
    expect(held).toEqual(expected);
  });

  it("inspects a complete snapshot and counts the records it drops, as the inline path does", async () => {
    const feed = repoFeed("nl-ndw-events");
    const expected = inline(feed, NDW_EVENTS);
    expect(expected.inspection.complete).toBe(true);
    const parsed = await child.parse({
      feed,
      payloads: { main: [{ data: NDW_EVENTS, gzipped: false }] },
      ctx,
    });
    expect(parsed).toEqual(expected);
  });

  it("tells a payload it cannot read from a parse that fails, and goes on parsing", async () => {
    const feed = repoFeed("nl-ndw-events");
    const unreadable = child.parse({
      feed,
      payloads: { main: [{ data: Buffer.from("not gzip"), gzipped: true }] },
      ctx,
    });
    await expect(unreadable).rejects.toBeInstanceOf(ParseProcessError);
    await expect(unreadable).rejects.toMatchObject({ stage: "payloads" });

    const charging = repoFeed("de-bnetza-charging");
    const broken = { ...charging, format: "no-such-format" };
    await expect(
      child.parse({ feed: broken, payloads: { main: [{ data: BNETZA, gzipped: false }] }, ctx }),
    ).rejects.toMatchObject({ stage: "parse", message: expect.stringMatching(/no-such-format/) });

    const again = await child.parse({
      feed: charging,
      payloads: { main: [{ data: BNETZA, gzipped: false }] },
      ctx,
    });
    expect(again.output.features.length).toBeGreaterThan(0);
  });

  it("keeps nothing of a parse its caller is done with", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const parse = async () => {
      const parsed = await child.parse({
        feed: repoFeed("de-bnetza-charging"),
        payloads: { main: [{ data: BNETZA, gzipped: false }] },
        ctx,
      });
      return new WeakRef(parsed.output);
    };
    const output = await parse();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    expect(output.deref()).toBeUndefined();
  });

  it("stops an idle child, and the next parse starts a new one", async () => {
    const brief = createParseProcess({ idleMs: 100 });
    try {
      const task = {
        feed: repoFeed("de-bnetza-charging"),
        payloads: { main: [{ data: BNETZA, gzipped: false }] },
        ctx,
      };
      await brief.parse(task);
      expect(brief.running).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(brief.running).toBe(false);
      expect((await brief.parse(task)).output.features.length).toBeGreaterThan(0);
    } finally {
      await brief.close();
    }
  });

  it("ends alone when a parse outgrows its heap, and the next parse starts a new one", async () => {
    const small = createParseProcess({ heapMb: 128 });
    try {
      // A JSON list whose parsed objects alone outgrow the child's heap.
      const huge = Buffer.from(
        JSON.stringify(Array.from({ length: 2_000_000 }, (_, i) => ({ id: `location-${i}` }))),
      );
      await expect(
        small.parse({
          feed: repoFeed("nl-ndw-charging"),
          payloads: { main: [{ data: huge, gzipped: false }] },
          ctx,
        }),
      ).rejects.toMatchObject({
        stage: "parse",
        message: expect.stringMatching(/^the parse process/),
      });
      const parsed = await small.parse({
        feed: repoFeed("de-bnetza-charging"),
        payloads: { main: [{ data: BNETZA, gzipped: false }] },
        ctx,
      });
      expect(parsed.output.features.length).toBeGreaterThan(0);
    } finally {
      await small.close();
    }
  });
});
