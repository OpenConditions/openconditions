import { describe, expect, it } from "vitest";
import { buildVildSnapshot, verifyVildArchive } from "../vild-import.js";

/** Minimal dBASE III and point shapefile, written independently of the reader. */
function dbf(fields: string[], rows: string[][]): Buffer {
  const header = 33 + 32 * fields.length;
  const width = 1 + 24 * fields.length;
  const out = Buffer.alloc(header + width * rows.length + 1);
  out[0] = 3;
  out.writeUInt32LE(rows.length, 4);
  out.writeUInt16LE(header, 8);
  out.writeUInt16LE(width, 10);
  fields.forEach((field, i) => {
    out.write(field, 32 + i * 32, "ascii");
    out[32 + i * 32 + 11] = 67;
    out[32 + i * 32 + 16] = 24;
  });
  out[header - 1] = 13;
  rows.forEach((row, i) => {
    const start = header + i * width;
    out.fill(32, start, start + width);
    row.forEach((cell, j) => {
      out.write(cell, start + 1 + j * 24, "ascii");
    });
  });
  out[out.length - 1] = 26;
  return out;
}
function shp(coordinates: [number, number][]): Buffer {
  const out = Buffer.alloc(100 + 28 * coordinates.length);
  out.writeInt32BE(9994);
  out.writeInt32BE(out.length / 2, 24);
  out.writeInt32LE(1000, 28);
  out.writeInt32LE(1, 32);
  coordinates.forEach(([lon, lat], i) => {
    const p = 100 + 28 * i;
    out.writeInt32BE(i + 1, p);
    out.writeInt32BE(10, p + 4);
    out.writeInt32LE(1, p + 8);
    out.writeDoubleLE(lon, p + 12);
    out.writeDoubleLE(lat, p + 20);
  });
  return out;
}
const files = (over = {}) => ({
  mainDbf: dbf(
    ["LOC_NR", "LOC_TYPE", "FIRST_NAME", "ROADNUMBER"],
    [
      ["0", "V1.0", "6.13.A", ""],
      ["10", "P1.0", "", "N2"],
      ["20", "P1.0", "", "A2"],
    ],
  ),
  pointDbf: dbf(["LOC_NR"], [["20"], ["10"]]),
  pointShp: shp([
    [5.2, 52.2],
    [5.1, 52.1],
  ]),
  projection: 'GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]',
  ...over,
});

describe("reproducible official VILD import", () => {
  it("joins by LOC_NR rather than main-file order and keeps official identity without synthetic TABCDs", () => {
    const snapshot = buildVildSnapshot(files());
    expect(snapshot.edition).toBe("6.13.A");
    expect(snapshot.reference).toEqual({ country: "8", table: "6.13", version: "A" });
    expect(snapshot.points).toEqual([
      [10, 5.1, 52.1, "N2"],
      [20, 5.2, 52.2, "A2"],
    ]);
    expect(snapshot.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.license).toBe("CC0-1.0");
  });
  it("refuses duplicate IDs, missing joins, wrong editions, projected coordinates and invalid coordinates", () => {
    expect(() => buildVildSnapshot(files({ pointDbf: dbf(["LOC_NR"], [["10"], ["10"]]) }))).toThrow(
      /duplicate/i,
    );
    expect(() => buildVildSnapshot(files({ pointDbf: dbf(["LOC_NR"], [["20"], ["30"]]) }))).toThrow(
      /join/i,
    );
    expect(() =>
      buildVildSnapshot(
        files({
          mainDbf: dbf(
            ["LOC_NR", "LOC_TYPE", "FIRST_NAME", "ROADNUMBER"],
            [["0", "V1.0", "6.14.A", ""]],
          ),
        }),
      ),
    ).toThrow(/edition/i);
    expect(() => buildVildSnapshot(files({ projection: 'PROJCS["RD"]' }))).toThrow(/WGS84/i);
    expect(() =>
      buildVildSnapshot(
        files({
          pointShp: shp([
            [Number.NaN, 52],
            [5, 52],
          ]),
        }),
      ),
    ).toThrow(/coordinate/i);
    expect(() =>
      buildVildSnapshot(
        files({
          pointShp: shp([
            [190, 52],
            [5, 52],
          ]),
        }),
      ),
    ).toThrow(/coordinate/i);
  });
  it("refuses changed archive bytes before extraction", () => {
    expect(() => verifyVildArchive(Buffer.from("not the pinned distribution"))).toThrow(/SHA-256/i);
  });
});
