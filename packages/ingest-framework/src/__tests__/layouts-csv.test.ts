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
});

describe("layoutBlockSchema", () => {
  test("is strict", () => {
    expect(layoutBlockSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(layoutBlockSchema.safeParse({ lon: "x", lat: "y" }).success).toBe(true);
  });
});
