import { describe, expect, it } from "vitest";
import {
  canonicalIdOf,
  formatRecordId,
  isInstanceId,
  isSourceId,
  jcs,
  normalizeNamespace,
  parseRecordId,
} from "../kernel/identity.js";

describe("record ids", () => {
  it("round-trips and splits on the first three colons only", () => {
    const id = formatRecordId({ class: "situation", namespace: "de-ndw", localId: "NDW01:SRA:1" });
    expect(id).toBe("oc:situation:de-ndw:NDW01:SRA:1");
    expect(parseRecordId(id)).toEqual({
      class: "situation",
      namespace: "de-ndw",
      localId: "NDW01:SRA:1",
    });
  });

  it("accepts hostname instance ids as namespaces and rejects colons", () => {
    expect(parseRecordId("oc:observation:maps.example.org:x")?.namespace).toBe("maps.example.org");
    expect(() => formatRecordId({ class: "offer", namespace: "a:b", localId: "x" })).toThrow();
    expect(parseRecordId("oc:event:de-ndw:x")).toBeNull();
  });

  it("separates source ids from instance ids", () => {
    expect(isSourceId("de-by-mobilithek-events")).toBe(true);
    expect(isSourceId("maps.example.org")).toBe(false);
    expect(isInstanceId("maps.example.org")).toBe(true);
    expect(isInstanceId("Maps.example.org")).toBe(false);
    expect(isInstanceId("-local")).toBe(false);
  });

  it("keeps canonicalId = sha256([namespace, localId]) with the namespace normalised", () => {
    expect(canonicalIdOf(" DE-NDW ", "x")).toBe(canonicalIdOf("de-ndw", "x"));
    expect(canonicalIdOf("a:b", "c")).not.toBe(canonicalIdOf("a", "b:c"));
    expect(() => normalizeNamespace("   ")).toThrow();
  });

  it("canonicalises JSON with RFC 8785", () => {
    expect(jcs({ b: 1, a: [2, "x"] })).toBe('{"a":[2,"x"],"b":1}');
    expect(() => jcs(undefined)).toThrow();
  });
});
