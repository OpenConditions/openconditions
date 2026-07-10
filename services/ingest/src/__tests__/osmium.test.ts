import { describe, expect, it } from "vitest";
import { pbfToWays } from "../pipeline/osmium.js";

const RS = "\x1e";

describe("pbfToWays", () => {
  it("runs filter → complete-ways bbox extract → geojsonseq export, then parses", async () => {
    const calls: string[][] = [];
    const geojson =
      RS +
      JSON.stringify({
        type: "Feature",
        id: "w5",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        properties: { highway: "motorway" },
      });

    const ways = await pbfToWays("/tmp/in.pbf", [4, 50, 7, 53], "/work", {
      runOsmium: async (args) => {
        calls.push(args);
      },
      readGeojson: async () => geojson,
    });

    expect(calls[0]).toEqual([
      "tags-filter",
      "-O",
      "/tmp/in.pbf",
      "w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link",
      "-o",
      "/work/filtered.osm.pbf",
    ]);
    expect(calls[1]).toEqual([
      "extract",
      "-O",
      "--strategy=complete_ways",
      "--bbox",
      "4,50,7,53",
      "/work/filtered.osm.pbf",
      "-o",
      "/work/clipped.osm.pbf",
    ]);
    expect(calls[2]).toEqual([
      "export",
      "-O",
      "/work/clipped.osm.pbf",
      "-f",
      "geojsonseq",
      "--add-unique-id=type_id",
      "--geometry-types=linestring",
      "-o",
      "/work/roads.geojsonl",
    ]);
    expect(ways).toEqual([
      {
        wayId: 5,
        coords: [
          [0, 0],
          [1, 1],
        ],
        highway: "motorway",
        oneway: false,
      },
    ]);
  });

  it("propagates a stage failure (e.g. an OOM SIGKILL) and runs no later stage", async () => {
    const seen: string[] = [];
    await expect(
      pbfToWays("/tmp/in.pbf", [0, 0, 1, 1], "/work", {
        runOsmium: async (args) => {
          seen.push(args[0]!);
          if (args[0] === "extract") throw new Error("osmium extract killed by SIGKILL (OOM ...)");
        },
        readGeojson: async () => "",
      })
    ).rejects.toThrow(/SIGKILL/);
    expect(seen).toEqual(["tags-filter", "extract"]); // never reached export
  });
});
