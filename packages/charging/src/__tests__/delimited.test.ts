import { describe, expect, test } from "vitest";
import { type DelimitedRow, readDelimited } from "../formats/delimited.js";

function rows(
  text: string,
  columns: string[],
  options: { delimiter?: string; headerStartsWith?: string; chunkBytes?: number } = {},
): DelimitedRow[] {
  const out: DelimitedRow[] = [];
  readDelimited(
    Buffer.from(text),
    { delimiter: options.delimiter ?? ",", columns, ...options },
    (row) => out.push(row),
  );
  return out;
}

describe("readDelimited", () => {
  test("a row holds the wanted columns only, so the record path never materialises the rest", () => {
    const wide = Array.from({ length: 53 }, (_, i) => `c${i}`);
    const big = "x".repeat(100_000);
    const text = [
      wide.join(","),
      wide.map((_, i) => (i === 7 ? "keep" : i === 20 ? `"${big}"` : `v${i}`)).join(","),
    ].join("\n");
    const [row] = rows(text, ["c7", "c40", "missing"]);
    expect(row).toEqual({ c7: "keep", c40: "v40" });
    expect(Object.keys(row!)).toHaveLength(2);
  });

  test("quotes, doubled quotes, embedded newlines and delimiters, CRLF and a BOM are read as written", () => {
    const text = '﻿a;b;c\r\n1;"x;y ""z""\r\nsecond line";3\r\n\r\n4;5;6';
    expect(rows(text, ["a", "b", "c"], { delimiter: ";" })).toEqual([
      { a: "1", b: 'x;y "z"\r\nsecond line', c: "3" },
      { a: "4", b: "5", c: "6" },
    ]);
  });

  test("a quote inside a cell of an unwanted column does not open a quoted cell", () => {
    expect(rows('a,b,c\n1,x"y,2\n3,z,4\n5,w,6', ["a", "c"])).toEqual([
      { a: "1", c: "2" },
      { a: "3", c: "4" },
      { a: "5", c: "6" },
    ]);
  });

  test("the preamble before the header row is skipped", () => {
    const text = "Title;;\n;;\nNotes: x;;\nid;name;extra\n7;Seven;y\n";
    expect(rows(text, ["id", "name"], { delimiter: ";", headerStartsWith: "id" })).toEqual([
      { id: "7", name: "Seven" },
    ]);
  });

  test("chunk boundaries fall anywhere: multibyte text, CRLF and quotes survive a one-byte chunk", () => {
    const text = 'id,name\r\n1,"Ä ""ö"" ü"\r\n2,€uro\r\n3,plain';
    const whole = rows(text, ["id", "name"]);
    expect(rows(text, ["id", "name"], { chunkBytes: 1 })).toEqual(whole);
    expect(rows(text, ["id", "name"], { chunkBytes: 7 })).toEqual(whole);
    expect(whole[0]).toEqual({ id: "1", name: 'Ä "ö" ü' });
  });
});
