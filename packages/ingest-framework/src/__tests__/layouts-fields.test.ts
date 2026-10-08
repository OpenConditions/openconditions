import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  fieldRef,
  fieldText,
  lookupField,
  mapped,
  readField,
  scalarText,
} from "../layouts/fields.js";

const record = {
  name: "  Hellisheiði ",
  count: 3,
  open: true,
  empty: "   ",
  nested: { url: "https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg" },
  "status.flag": "videoOrImagesAvailable",
};

describe("field references", () => {
  it("accepts a path or a path with a pattern that compiles", () => {
    expect(fieldRef.safeParse("nested.url").success).toBe(true);
    expect(fieldRef.safeParse({ field: "id", pattern: "^([^_]+)_" }).success).toBe(true);
    expect(fieldRef.safeParse({ field: "id", pattern: "(" }).success).toBe(false);
    expect(fieldRef.safeParse("").success).toBe(false);
    expect(fieldRef.safeParse({ field: "id", other: 1 }).success).toBe(false);
  });

  it("maps a field onto a closed vocabulary only", () => {
    const rule = mapped(["online", "offline"] as const);
    expect(rule.safeParse({ field: "s", map: { a: "online" } }).success).toBe(true);
    expect(rule.safeParse({ field: "s", map: { a: "broken" } }).success).toBe(false);
    expect(z.toJSONSchema(rule)).toMatchObject({ required: ["field", "map"] });
  });
});

describe("field readers", () => {
  it("reads scalars as trimmed text", () => {
    expect(scalarText(" a ")).toBe("a");
    expect(scalarText("  ")).toBeUndefined();
    expect(scalarText(7)).toBe("7");
    expect(scalarText(Number.NaN)).toBeUndefined();
    expect(scalarText(false)).toBe("false");
    expect(scalarText({})).toBeUndefined();
  });

  it("reads a path, a dotted key and a pattern's capture", () => {
    expect(fieldText(record, "name")).toBe("Hellisheiði");
    expect(fieldText(record, "count")).toBe("3");
    expect(fieldText(record, "empty")).toBeUndefined();
    expect(fieldText(record, "status.flag")).toBe("videoOrImagesAvailable");
    expect(fieldText(record, { field: "nested.url", pattern: "/([^/]+)\\.jpg$" })).toBe(
      "hellisheidi_1",
    );
    // Without a group the whole match is the value; no match is no value.
    expect(fieldText(record, { field: "name", pattern: "Hellis" })).toBe("Hellis");
    expect(fieldText(record, { field: "name", pattern: "^x" })).toBeUndefined();
    expect(fieldText(record, undefined)).toBeUndefined();
  });

  it("keeps a raw value without a pattern", () => {
    expect(readField(record, "count")).toBe(3);
    expect(readField(record, "open")).toBe(true);
    expect(readField(record, { field: "count", pattern: "\\d" })).toBe("3");
  });

  it("looks a field's text up in a value map", () => {
    const rule = { field: "status.flag", map: { videoOrImagesAvailable: "online" } };
    expect(lookupField(record, rule)).toBe("online");
    expect(lookupField(record, { field: "name", map: { other: "x" } })).toBeUndefined();
    // Only the map's own keys count.
    expect(lookupField({ v: "toString" }, { field: "v", map: {} })).toBeUndefined();
    expect(lookupField(record, undefined)).toBeUndefined();
  });
});
