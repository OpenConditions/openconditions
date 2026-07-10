import { describe, expect, it, vi } from "vitest";
import { autoOsmSource, pbfExtractSource } from "../pipeline/osm-import.js";

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

describe("autoOsmSource", () => {
  const overpass = { fetchRegion: vi.fn(async () => [way(1)]) };
  const pbf = { fetchRegion: vi.fn(async () => [way(2)]) };

  it("auto: region with pbfUrls uses pbf, without uses overpass", async () => {
    const src = autoOsmSource(overpass, pbf, {});
    expect(await src.fetchRegion(region(["u"]))).toEqual([way(2)]);
    expect(await src.fetchRegion(region(undefined))).toEqual([way(1)]);
  });

  it("OSM_SOURCE=overpass forces overpass even when pbfUrls exist", async () => {
    const src = autoOsmSource(overpass, pbf, { OSM_SOURCE: "overpass" });
    expect(await src.fetchRegion(region(["u"]))).toEqual([way(1)]);
  });

  it("OSM_SOURCE=pbf forces pbf even when pbfUrls are absent", async () => {
    const src = autoOsmSource(overpass, pbf, { OSM_SOURCE: "pbf" });
    expect(await src.fetchRegion(region(undefined))).toEqual([way(2)]);
  });
});
