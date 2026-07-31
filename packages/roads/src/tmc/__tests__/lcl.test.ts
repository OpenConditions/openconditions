import { describe, expect, it } from "vitest";
import { buildTmcTable, fromSnapshot, parseDatFile, toSnapshot } from "../lcl.js";

const META = { attribution: "Test authority", license: "CC-BY-4.0" };

const LOCATION_DATASETS = "CID;TABCD;DCOMMENT;VERSION;VERSIONDESCRIPTION\r\n58;1;;22.0;22.0\r\n";
const COUNTRIES = "CID;ECC;CCD;CNAME\r\n58;E0;D;Germany\r\n";

/** Two coded points on one road, plus one with no coordinates. */
const POINTS = [
  "CID;TABCD;LCD;CLASS;XCOORD;YCOORD",
  "58;1;12271;P;+01021440;+4868990",
  "58;1;12270;P;+01020750;+4861330",
  "58;1;99999;P;;",
].join("\r\n");

const POFFSETS = ["CID;TABCD;LCD;NEG_OFF_LCD;POS_OFF_LCD", "58;1;12270;30500;12271"].join("\r\n");

describe("parseDatFile", () => {
  it("reads semicolon rows, tolerating a BOM and CRLF endings", () => {
    const rows = parseDatFile("﻿A;B\r\nx;y\r\n\r\n");
    expect(rows).toEqual([{ A: "x", B: "y" }]);
  });

  it("returns nothing for an empty file rather than throwing", () => {
    expect(parseDatFile("")).toEqual([]);
  });
});

describe("buildTmcTable", () => {
  const table = buildTmcTable(
    {
      points: POINTS,
      poffsets: POFFSETS,
      locationDatasets: LOCATION_DATASETS,
      countries: COUNTRIES,
    },
    META
  );

  it("takes the table's identity and version from LOCATIONDATASETS", () => {
    expect(table).toMatchObject({ cid: 58, tabcd: 1, version: "22.0", ccd: "D", ecc: "E0" });
  });

  it("decodes coordinates from 1e-5 degree integers", () => {
    expect(table.points.get(12271)).toMatchObject({ lon: 10.2144, lat: 48.6899 });
  });

  it("drops points with no coordinates, which cannot place anything", () => {
    expect(table.points.has(99999)).toBe(false);
  });

  it("links each point to its neighbours along the road", () => {
    expect(table.points.get(12270)).toMatchObject({ pos: 12271, neg: 30500 });
  });

  it("refuses a table whose version it cannot determine", () => {
    expect(() =>
      buildTmcTable(
        { points: POINTS, locationDatasets: "CID;TABCD;VERSION\r\n", countries: COUNTRIES },
        META
      )
    ).toThrow(/version/i);
  });
});

describe("snapshot round-trip", () => {
  it("preserves every point and its links", () => {
    const table = buildTmcTable(
      {
        points: POINTS,
        poffsets: POFFSETS,
        locationDatasets: LOCATION_DATASETS,
        countries: COUNTRIES,
      },
      META
    );
    const restored = fromSnapshot(toSnapshot(table));
    expect(restored.points).toEqual(table.points);
    expect(restored).toMatchObject({ cid: 58, tabcd: 1, version: "22.0", license: "CC-BY-4.0" });
  });
});
