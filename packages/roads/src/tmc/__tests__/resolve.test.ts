import { describe, expect, it } from "vitest";
import type { TmcLocationTable } from "../lcl.js";
import { resolveAlertC } from "../resolve.js";
import { tmcTables } from "../index.js";

/** A: 0,0 — B: 0,1 — C: 0,2, chained A -> B -> C in the positive direction. */
const TABLE: TmcLocationTable = {
  cid: 58,
  tabcd: 1,
  version: "22.0",
  ccd: "D",
  ecc: "E0",
  attribution: "Test authority",
  license: "CC-BY-4.0",
  points: new Map([
    [100, { lon: 0, lat: 0, pos: 200 }],
    [200, { lon: 0, lat: 1, pos: 300, neg: 100 }],
    [300, { lon: 0, lat: 2, neg: 200 }],
  ]),
};

const ref = (over: Record<string, unknown> = {}) => ({
  country: "D",
  table: "1",
  version: "22.0",
  primary: 100,
  ...over,
});

describe("resolveAlertC", () => {
  it("places a point location at its coded point", () => {
    const r = resolveAlertC(ref(), [TABLE]);
    expect(r).toMatchObject({ ok: true, geometry: { type: "Point", coordinates: [0, 0] } });
  });

  it("follows the coded chain across a linear location", () => {
    const r = resolveAlertC(ref({ primary: 300, secondary: 100 }), [TABLE]);
    // Not just the two endpoints: the intermediate coded point is included, so
    // the line follows the road instead of cutting the corner between them.
    expect(r).toMatchObject({
      ok: true,
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [0, 1],
          [0, 2],
        ],
      },
    });
  });

  it("falls back to joining the endpoints when they are not linked", () => {
    const orphan: TmcLocationTable = {
      ...TABLE,
      points: new Map([
        [100, { lon: 0, lat: 0 }],
        [300, { lon: 0, lat: 2 }],
      ]),
    };
    expect(resolveAlertC(ref({ primary: 300, secondary: 100 }), [orphan])).toMatchObject({
      ok: true,
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [0, 2],
        ],
      },
    });
  });

  it("identifies the country by numeric CID or extended code, not just the letter", () => {
    for (const country of ["58", "D", "E0", "d"]) {
      expect(resolveAlertC(ref({ country }), [TABLE])).toMatchObject({ ok: true });
    }
  });

  it("accepts an equivalent spelling of the same version", () => {
    expect(resolveAlertC(ref({ version: "22.00" }), [TABLE])).toMatchObject({ ok: true });
  });

  /**
   * The safety property. Location codes are renumbered between table editions,
   * so resolving against the wrong one returns a confident coordinate on the
   * wrong road — measurably ~2km out for a table 13 versions stale. Refusing is
   * the only safe answer; a caller can see the reason and act on it.
   */
  it("refuses a record whose declared table version is not ours", () => {
    expect(resolveAlertC(ref({ version: "9.00" }), [TABLE])).toEqual({
      ok: false,
      reason: "version-mismatch",
    });
  });

  /**
   * Reported apart from a genuine mismatch. Both refuse, but they mean opposite
   * things: a mismatch says the publisher references an edition we do not hold,
   * while a missing version says there is nothing to check against — and only
   * the second can be argued away, since a country with one final table has
   * little else its codes could mean.
   */
  it("distinguishes a record that declares no version from one that declares another", () => {
    expect(resolveAlertC(ref({ version: undefined }), [TABLE])).toEqual({
      ok: false,
      reason: "version-missing",
    });
    expect(resolveAlertC(ref({ version: "9.00" }), [TABLE])).toEqual({
      ok: false,
      reason: "version-mismatch",
    });
  });

  it("reports a country we hold no table for, rather than using another", () => {
    expect(resolveAlertC(ref({ country: "8", table: "6.13" }), [TABLE])).toEqual({
      ok: false,
      reason: "no-table",
    });
  });

  it("reports a code the table does not contain", () => {
    expect(resolveAlertC(ref({ primary: 4242 }), [TABLE])).toEqual({
      ok: false,
      reason: "unknown-code",
    });
  });

  it("reports a reference carrying no location at all", () => {
    expect(resolveAlertC(ref({ primary: undefined }), [TABLE])).toEqual({
      ok: false,
      reason: "no-reference",
    });
  });

  it("treats a secondary equal to the primary as a point, not a zero-length line", () => {
    expect(resolveAlertC(ref({ secondary: 100 }), [TABLE])).toMatchObject({
      ok: true,
      geometry: { type: "Point" },
    });
  });
});

describe("the vendored German table", () => {
  const [table] = tmcTables();

  it("is the final published edition, keyed to Germany", () => {
    expect(table).toMatchObject({ cid: 58, tabcd: 1, version: "22.0", ccd: "D" });
    expect(table!.license).toBe("CC-BY-4.0");
    expect(table!.attribution).toMatch(/BASt|Bundesanstalt/);
  });

  it("resolves a real linear location to the stretch between its coded points", () => {
    // Giengen/Herbrechtingen -> Heidenheim on the A7, a pair taken from live
    // Bayern records that carry both this reference and real coordinates.
    const r = resolveAlertC(
      { country: "D", table: "1", version: "22.0", primary: 12271, secondary: 12270 },
      tmcTables()
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [10.2075, 48.6133],
        [10.2144, 48.6899],
      ],
    });
  });
});
