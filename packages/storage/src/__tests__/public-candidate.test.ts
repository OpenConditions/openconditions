import { expect, test } from "vitest";
import { isPublicCandidate } from "../fused-rows.js";

const record = (license: string, upstream?: { license?: string }[]) => ({
  provenance: { attribution: { license }, ...(upstream === undefined ? {} : { upstream }) },
});

test("a feed candidate is public when its source is held unrestricted and its record's licences are public", () => {
  expect(
    isPublicCandidate({ restricted: false, record: record("CC-BY-4.0"), sourceId: "es-a" }),
  ).toBe(true);
  expect(
    isPublicCandidate({ restricted: true, record: record("CC-BY-4.0"), sourceId: "es-a" }),
  ).toBe(false);
  // A source this catalogue does not hold.
  expect(
    isPublicCandidate({ restricted: null, record: record("CC-BY-4.0"), sourceId: "es-a" }),
  ).toBe(false);
  expect(
    isPublicCandidate({ restricted: false, record: record("ODbL-1.0"), sourceId: "es-a" }),
  ).toBe(false);
  expect(
    isPublicCandidate({
      restricted: false,
      record: record("CC-BY-4.0", [{ license: "ODbL-1.0" }]),
      sourceId: "es-a",
    }),
  ).toBe(false);
});

test("a crowd candidate is judged by its record's licence alone", () => {
  expect(
    isPublicCandidate({ restricted: null, record: record("CC0-1.0"), sourceId: "crowd" }),
  ).toBe(true);
  expect(
    isPublicCandidate({ restricted: null, record: record("ODbL-1.0"), sourceId: "crowd" }),
  ).toBe(false);
});
