import { describe, expect, it } from "vitest";
import { MAX_CANONICAL_BYTES, canonicalClaimBytes } from "../index.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("canonicalClaimBytes (RFC 8785 JCS)", () => {
  it("reproduces the RFC 8785 section 3.2.3 canonicalization vector exactly", () => {
    // Input JSON text verbatim from the RFC (unicode escapes, exponent forms,
    // redundant escapes), parsed the way a wire payload would be.
    const input = JSON.parse(
      "{\n" +
        '  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n' +
        '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n' +
        '  "literals": [null, true, false]\n' +
        "}"
    ) as unknown;
    const expected =
      '{"literals":[null,true,false],' +
      '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
    expect(decode(canonicalClaimBytes(input))).toBe(expected);
  });

  it("sorts keys by UTF-16 code units per the RFC 8785 sorting vector", () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
        '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
        '"\\u00f6":"Latin Small Letter O With Diaeresis"}'
    ) as unknown;
    // Note: the "Control" key below is a literal, invisible U+0080 character;
    // JCS emits it raw (only C0 controls are escaped in canonical form).
    const expected =
      '{"\\r":"Carriage Return","1":"One","":"Control",' +
      '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",' +
      '"\u{1f600}":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}';
    expect(decode(canonicalClaimBytes(input))).toBe(expected);
  });

  it("serializes numbers with the ECMAScript shortest round-trip form", () => {
    expect(decode(canonicalClaimBytes([0, -0, 1e21, 9007199254740994, 1e-7]))).toBe(
      "[0,0,1e+21,9007199254740994,1e-7]"
    );
  });

  it("is independent of object literal key order", () => {
    const a = { domain: "roads", type: "hazard", nonce: "abcdefgh12345678" };
    const b = { nonce: "abcdefgh12345678", domain: "roads", type: "hazard" };
    expect(canonicalClaimBytes(a)).toStrictEqual(canonicalClaimBytes(b));
  });

  it("encodes as UTF-8 bytes", () => {
    const bytes = canonicalClaimBytes({ s: "€" });
    // {"s":"€"} — the euro sign is 3 UTF-8 bytes (e2 82 ac).
    expect(Array.from(bytes.slice(-5, -2))).toStrictEqual([0xe2, 0x82, 0xac]);
  });

  it("throws TypeError on NaN and Infinity (aligned with the I-JSON walk's wording)", () => {
    expect(() => canonicalClaimBytes({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalClaimBytes({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalClaimBytes({ n: Number.NaN })).toThrow(TypeError);
  });

  it("throws TypeError on a value that is not JSON-serializable at all", () => {
    expect(() => canonicalClaimBytes(undefined)).toThrow(TypeError);
  });

  it("exports the 64 KiB wire cap", () => {
    expect(MAX_CANONICAL_BYTES).toBe(65536);
  });
});
