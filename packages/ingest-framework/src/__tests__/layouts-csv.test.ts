import { describe, expect, test } from "vitest";
import { layoutBlockSchema } from "../layouts/block.js";
import { decodeLayout } from "../layouts/decode.js";

describe("decodeLayout csv", () => {
  test("csv reads a semicolon file in latin1 with a combined lat,lon column", () => {
    const text = 'nom;pos;note\nGare Zürich;"47.378, 8.54";"a; b"\nSans position;;x\n';
    const rows = decodeLayout("csv", Buffer.from(text, "latin1"), {
      delimiter: ";",
      encoding: "latin1",
      point: { field: "pos", order: "latlon" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.fields).toEqual({ nom: "Gare Zürich", pos: "47.378, 8.54", note: "a; b" });
    expect(rows[0]!.point).toEqual([8.54, 47.378]);
    expect(rows[1]!.point).toBeUndefined();
  });

  test("csv honours decimal commas", () => {
    const rows = decodeLayout("csv", Buffer.from("id;lon;lat\n1;8,54;47,378\n"), {
      delimiter: ";",
      lon: "lon",
      lat: "lat",
      decimalComma: true,
    });
    expect(rows[0]!.point).toEqual([8.54, 47.378]);
  });

  test("csv trims values, strips a BOM and handles quoted newlines and CRLF", () => {
    const text = '﻿id,lon,lat,desc\r\n 1 , 8 , 47 ,"two\nlines ""q"""\r\n';
    const rows = decodeLayout("csv", Buffer.from(text), { lon: "lon", lat: "lat" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields).toEqual({ id: "1", lon: "8", lat: "47", desc: 'two\nlines "q"' });
    expect(rows[0]!.point).toEqual([8, 47]);
  });

  test("csv reads a WKT point field in the block's crs", () => {
    const text =
      'id;geom\n1;"POINT (184781.200000003 128873.100000002)"\n2;"POINT EMPTY"\n3;"LINESTRING (1 2, 3 4)"\n';
    const rows = decodeLayout("csv", Buffer.from(text), {
      delimiter: ";",
      wkt: "geom",
      crs: "EPSG:31370",
    });
    // Namur, Boulevard de Merckem, from Belgian Lambert 72.
    expect(rows[0]!.point![0]).toBeCloseTo(4.858691, 5);
    expect(rows[0]!.point![1]).toBeCloseTo(50.469649, 5);
    expect(rows[1]!.point).toBeUndefined();
    expect(rows[2]!.point).toBeUndefined();
  });

  test("a WKT point without a crs is WGS84 lon/lat, and an implausible one is no point", () => {
    const text = "id,geom\n1,POINT(8.54 47.378)\n2,point ( -0.5 51.2 )\n3,POINT (184781 128873)\n";
    const rows = decodeLayout("csv", Buffer.from(text), { wkt: "geom" });
    expect(rows.map((r) => r.point)).toEqual([[8.54, 47.378], [-0.5, 51.2], undefined]);
  });
});

describe("layoutBlockSchema", () => {
  test("is strict", () => {
    expect(layoutBlockSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(layoutBlockSchema.safeParse({ lon: "x", lat: "y" }).success).toBe(true);
    expect(layoutBlockSchema.safeParse({ wkt: "WKT_GEOM", crs: "EPSG:31370" }).success).toBe(true);
    expect(layoutBlockSchema.safeParse({ wkt: "" }).success).toBe(false);
  });
});
