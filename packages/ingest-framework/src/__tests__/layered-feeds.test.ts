import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadFeeds, mergeFeedsById } from "../layered-feeds.js";
import { registerFeedSchema } from "../feed-schema-registry.js";
import type { FeedSourceBase } from "../feed-source.js";

// A permissive schema for the test domain (a real domain narrows this).
const testSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    format: z.string(),
    cadenceSec: z.number(),
    freshnessWindowSec: z.number(),
    license: z.string(),
    attribution: z.string(),
    country: z.string(),
    privacyUrl: z.string(),
    enabledByDefault: z.boolean(),
    url: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

function feed(id: string, name: string, extra: Record<string, unknown> = {}): FeedSourceBase {
  return {
    id,
    name,
    format: "geojson",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "t",
    country: "NL",
    privacyUrl: "https://x",
    enabledByDefault: true,
    ...extra,
  } as FeedSourceBase;
}

function writeFeed(dir: string, f: FeedSourceBase): void {
  writeFileSync(join(dir, `${f.id}.json5`), JSON.stringify([f]), "utf8");
}

let baked: string;
let mount: string;

beforeEach(() => {
  registerFeedSchema("test", testSchema);
  baked = mkdtempSync(join(tmpdir(), "oc-baked-"));
  mount = mkdtempSync(join(tmpdir(), "oc-mount-"));
});

describe("mergeFeedsById", () => {
  it("lets later layers override earlier by id and appends new ids", () => {
    const merged = mergeFeedsById([
      [feed("a", "baked-a"), feed("b", "baked-b")],
      [feed("a", "mount-a"), feed("c", "mount-c")],
    ]);
    const byId = Object.fromEntries(merged.map((f) => [f.id, f.name]));
    expect(byId).toEqual({ a: "mount-a", b: "baked-b", c: "mount-c" });
  });
});

describe("loadFeeds", () => {
  it("merges baked-in + mounted with mounted winning; a mounted-only feed is added", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    writeFeed(baked, feed("b", "baked-b"));
    writeFeed(mount, feed("a", "mount-a")); // override
    writeFeed(mount, feed("c", "mount-c")); // added

    const feeds = await loadFeeds({ domain: "test", bakedInDir: baked, mountDir: mount });

    const byId = Object.fromEntries(feeds.map((f) => [f.id, f.name]));
    expect(byId).toEqual({ a: "mount-a", b: "baked-b", c: "mount-c" });
  });

  it("treats a missing mount dir as a silent no-op (baked-in only)", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const feeds = await loadFeeds({
      domain: "test",
      bakedInDir: baked,
      mountDir: join(tmpdir(), "oc-does-not-exist-xyz"),
    });
    expect(feeds.map((f) => f.id)).toEqual(["a"]);
  });

  it("fails loudly when a mounted file is malformed", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    writeFileSync(join(mount, "broken.json5"), "{ this is : not, valid", "utf8");
    await expect(
      loadFeeds({ domain: "test", bakedInDir: baked, mountDir: mount })
    ).rejects.toThrow();
  });

  it("fails loudly when a mounted file violates the schema", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    writeFileSync(join(mount, "bad.json5"), JSON.stringify([{ id: "z" }]), "utf8");
    await expect(
      loadFeeds({ domain: "test", bakedInDir: baked, mountDir: mount })
    ).rejects.toThrow();
  });

  it("ignores remote entirely when remote.enabled is false", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    let fetched = false;
    const feeds = await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: {
          url: "https://atlas.example.org/roads.json5",
          enabled: false,
          snapshotPath: join(mount, "snap.json"),
        },
      },
      {
        remoteFetch: async () => {
          fetched = true;
          return new Response("[]");
        },
      }
    );
    expect(fetched).toBe(false);
    expect(feeds.map((f) => f.id)).toEqual(["a"]);
  });
});
