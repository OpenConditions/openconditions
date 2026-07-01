import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogResolver, FeedSourceBase } from "../index.js";
import { resolveWithSnapshot } from "../catalog.js";

const feed = (id: string): FeedSourceBase => ({
  id,
  name: id,
  format: "wzdx",
  url: `https://x.example/${id}`,
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "t",
  country: "US",
  privacyUrl: "https://x",
  enabledByDefault: true,
});

const fakeFetch = (() => new Response("")) as unknown as typeof fetch;
let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

async function snapshotPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "catalog-"));
  dirs.push(dir);
  return path.join(dir, "snap.json");
}

describe("resolveWithSnapshot", () => {
  it("returns live feeds and writes the snapshot on success", async () => {
    const snap = await snapshotPath();
    const resolver: CatalogResolver = {
      id: "r",
      snapshotPath: snap,
      resolve: async () => [feed("live")],
    };
    const out = await resolveWithSnapshot(resolver, fakeFetch);
    expect(out.map((f) => f.id)).toEqual(["live"]);
    const written = JSON.parse(await readFile(snap, "utf8")) as FeedSourceBase[];
    expect(written[0]?.id).toBe("live");
  });

  it("falls back to the vendored snapshot when the live resolve throws", async () => {
    const snap = await snapshotPath();
    await writeFile(snap, JSON.stringify([feed("snap")]));
    const resolver: CatalogResolver = {
      id: "r",
      snapshotPath: snap,
      resolve: async () => {
        throw new Error("registry down");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await resolveWithSnapshot(resolver, fakeFetch);
    expect(out.map((f) => f.id)).toEqual(["snap"]);
    expect(warn).toHaveBeenCalled();
  });

  it("returns [] and logs when both live and snapshot fail", async () => {
    const snap = await snapshotPath(); // path exists, file does not
    const resolver: CatalogResolver = {
      id: "r",
      snapshotPath: snap,
      resolve: async () => {
        throw new Error("registry down");
      },
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await resolveWithSnapshot(resolver, fakeFetch);
    expect(out).toEqual([]);
    expect(err).toHaveBeenCalled();
  });
});
