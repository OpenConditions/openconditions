import { describe, expect, it, vi } from "vitest";
import { pbfExtractSource } from "../pipeline/osm-import.js";

const way = (wayId: number) => ({
  wayId,
  coords: [
    [0, 0],
    [1, 1],
  ] as [number, number][],
  highway: "motorway",
  oneway: false,
});
const region = (pbfUrls?: string[]) => ({
  id: "nl",
  bbox: [0, 0, 1, 1] as [number, number, number, number],
  tz: "T",
  pbfUrls,
});

describe("pbfExtractSource", () => {
  it("downloads + extracts each UNIQUE url and concatenates the ways", async () => {
    const download = vi.fn(async (url: string) => ({
      path: `/tmp/oc-pbfsrc-test-${url}/artifact`,
      dir: `/tmp/oc-pbfsrc-test-${url}`,
    }));
    const extract = vi.fn(async (path: string) =>
      path.includes("test-A") ? [way(1), way(2)] : [way(3)]
    );

    const ways = await pbfExtractSource({ download, extract }).fetchRegion(region(["A", "B", "A"]));

    expect(download).toHaveBeenCalledTimes(2); // "A" deduped
    expect(ways.map((w) => w.wayId).sort()).toEqual([1, 2, 3]);
  });

  it("throws for a region that has no pbfUrls", async () => {
    await expect(pbfExtractSource({}).fetchRegion(region(undefined))).rejects.toThrow(
      /requires pbfUrls/
    );
  });

  it("fails the whole region (throws) if any url's extract fails", async () => {
    const download = vi.fn(async (url: string) => ({
      path: `/tmp/oc-pbfsrc-test-${url}/artifact`,
      dir: `/tmp/oc-pbfsrc-test-${url}`,
    }));
    const extract = vi.fn(async (path: string) => {
      if (path.includes("test-B")) throw new Error("boom on B");
      return [way(1)];
    });

    await expect(
      pbfExtractSource({ download, extract }).fetchRegion(region(["A", "B"]))
    ).rejects.toThrow(/boom on B/);
  });
});
