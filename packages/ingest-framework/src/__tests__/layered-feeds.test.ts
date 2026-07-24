import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const REMOTE_URL = "https://atlas.example.org/roads.json5";

function bundle(...feeds: FeedSourceBase[]): string {
  return JSON.stringify(feeds);
}

describe("loadFeeds remote-pull", () => {
  it("pulls live, writes the snapshot, and uses the remote feeds", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const snapshotPath = join(mount, "snap.json");
    const remoteFeed = feed("r", "remote-r", { url: "https://feeds.example.org/r.json" });

    const feeds = await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: { url: REMOTE_URL, enabled: true, snapshotPath },
      },
      { remoteFetch: async () => new Response(bundle(remoteFeed)) }
    );

    expect(feeds.map((f) => f.id).sort()).toEqual(["a", "r"]);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))[0].id).toBe("r");
  });

  it("falls back to the vendored snapshot when the live pull fails", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const snapshotPath = join(mount, "snap.json");
    writeFileSync(snapshotPath, JSON.stringify([feed("r", "snapshot-r")]), "utf8");

    const feeds = await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: { url: REMOTE_URL, enabled: true, snapshotPath },
      },
      {
        remoteFetch: async () => {
          throw new Error("network down");
        },
      }
    );

    const r = feeds.find((f) => f.id === "r");
    expect(r?.name).toBe("snapshot-r");
  });

  it("degrades to baked-in only when live fails and no snapshot exists", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const feeds = await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: { url: REMOTE_URL, enabled: true, snapshotPath: join(mount, "missing.json") },
      },
      {
        remoteFetch: async () => {
          throw new Error("network down");
        },
      }
    );
    expect(feeds.map((f) => f.id)).toEqual(["a"]);
  });

  it("guards the bundle URL and every descriptor URL via assertUrl", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const seen: string[] = [];
    const remoteFeed = feed("r", "remote-r", { url: "https://feeds.example.org/r.json" });

    await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: { url: REMOTE_URL, enabled: true, snapshotPath: join(mount, "snap.json") },
      },
      {
        remoteFetch: async () => new Response(bundle(remoteFeed)),
        assertUrl: (u) => {
          seen.push(u);
        },
      }
    );

    expect(seen).toContain(REMOTE_URL);
    expect(seen).toContain("https://feeds.example.org/r.json");
  });

  it("rejects a bundle URL that fails the guard", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const feeds = await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: {
          url: "http://169.254.169.254/latest",
          enabled: true,
          snapshotPath: join(mount, "snap.json"),
        },
      },
      {
        assertUrl: (u) => {
          if (u.includes("169.254")) throw new Error("blocked private/metadata host");
        },
        remoteFetch: async () => new Response(bundle(feed("r", "remote-r"))),
      }
    );
    // guard threw before fetch → remote contributes nothing → baked-in only
    expect(feeds.map((f) => f.id)).toEqual(["a"]);
  });

  it("rejects a bundle descriptor whose siteTable.url fails the guard, at parse-time", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const remoteFeed = feed("r", "remote-r", {
      siteTable: { url: "http://169.254.169.254/site-table" },
    });

    const feeds = await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: { url: REMOTE_URL, enabled: true, snapshotPath: join(mount, "snap.json") },
      },
      {
        assertUrl: (u) => {
          if (u.includes("169.254")) throw new Error("blocked private/metadata host");
        },
        remoteFetch: async () => new Response(bundle(remoteFeed)),
      }
    );
    // the siteTable.url guard rejects the descriptor at parse-time → remote
    // contributes nothing → baked-in only
    expect(feeds.map((f) => f.id)).toEqual(["a"]);
  });

  it("rejects a bundle descriptor whose stationRegistry.url fails the guard, at parse-time", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const remoteFeed = feed("r", "remote-r", {
      stationRegistry: { url: "http://169.254.169.254/station-registry", format: "webtris-sites" },
    });

    const feeds = await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: { url: REMOTE_URL, enabled: true, snapshotPath: join(mount, "snap.json") },
      },
      {
        assertUrl: (u) => {
          if (u.includes("169.254")) throw new Error("blocked private/metadata host");
        },
        remoteFetch: async () => new Response(bundle(remoteFeed)),
      }
    );
    // the stationRegistry.url guard rejects the descriptor at parse-time →
    // remote contributes nothing → baked-in only
    expect(feeds.map((f) => f.id)).toEqual(["a"]);
  });

  it("gives a clean 'neither array nor { feeds }' error, not a raw TypeError, for a literal null bundle body", async () => {
    writeFeed(baked, feed("a", "baked-a"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const feeds = await loadFeeds(
      {
        domain: "test",
        bakedInDir: baked,
        remote: { url: REMOTE_URL, enabled: true, snapshotPath: join(mount, "missing.json") },
      },
      { remoteFetch: async () => new Response("null") }
    );

    expect(feeds.map((f) => f.id)).toEqual(["a"]); // no snapshot → baked-in only
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("neither an array nor"))).toBe(true);
    expect(messages.some((m) => m.includes("Cannot read propert"))).toBe(false);
    warnSpy.mockRestore();
  });
});
