import { describe, expect, it } from "vitest";
import {
  base58btcDecode,
  base58btcEncode,
  multibaseFromRawEd25519,
  rawEd25519FromMultibase,
} from "../index.js";

function hex(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h, "hex"));
}

/**
 * Reference vectors.
 *
 * "did:key spec example" is the Ed25519 example DID from the w3c-ccg did:key
 * spec's DID Document example; its raw key is the multicodec payload of that
 * published multibase string. The RFC 8032 vectors are the test-vector public
 * keys from RFC 8032 §7.1; their multibase forms were computed with two
 * independent reference implementations (`bs58` and `multiformats/bases/
 * base58`), which agree, and are pinned here so a regression in the hand-
 * rolled encoder can never pass unnoticed.
 */
const VECTORS = [
  {
    name: "did:key spec example",
    raw: "2e6fcce36701dc791488e0d0b1745cc1e33a4c1c9fcc41c63bd343dbbe0970e6",
    multibase: "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  },
  {
    name: "RFC 8032 test vector 1",
    raw: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    multibase: "z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw",
  },
  {
    name: "RFC 8032 test vector 2",
    raw: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    multibase: "z6MkiaMbhXHNA4eJVCCj8dbzKzTgYDKf6crKgHVHid1F1WCT",
  },
  {
    name: "RFC 8032 test vector 3",
    raw: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    multibase: "z6MkwSD8dBdqcXQzKJZQFPy2hh2izzxskndKCjdmC2dBpfME",
  },
] as const;

describe("multibaseFromRawEd25519", () => {
  for (const v of VECTORS) {
    it(`encodes the ${v.name} to its pinned z6Mk multibase`, () => {
      expect(multibaseFromRawEd25519(hex(v.raw))).toBe(v.multibase);
    });
  }

  it("every Ed25519 multikey starts with z6Mk (multicodec 0xed01 invariant)", () => {
    for (const v of VECTORS) {
      expect(multibaseFromRawEd25519(hex(v.raw))).toMatch(/^z6Mk/);
    }
  });

  it("rejects a public key that is not exactly 32 bytes", () => {
    expect(() => multibaseFromRawEd25519(new Uint8Array(31))).toThrow(TypeError);
    expect(() => multibaseFromRawEd25519(new Uint8Array(33))).toThrow(TypeError);
    expect(() => multibaseFromRawEd25519(new Uint8Array(0))).toThrow(TypeError);
  });
});

describe("rawEd25519FromMultibase", () => {
  for (const v of VECTORS) {
    it(`decodes the ${v.name} multibase back to its raw bytes`, () => {
      expect(Buffer.from(rawEd25519FromMultibase(v.multibase)).toString("hex")).toBe(v.raw);
    });
  }

  it("rejects a corrupted multibase (character outside the base58btc alphabet)", () => {
    const corrupted = VECTORS[0].multibase.slice(0, 10) + "0" + VECTORS[0].multibase.slice(11);
    expect(() => rawEd25519FromMultibase(corrupted)).toThrow(TypeError);
    for (const bad of ["O", "I", "l"]) {
      expect(() => rawEd25519FromMultibase(VECTORS[0].multibase.slice(0, -1) + bad)).toThrow(
        TypeError
      );
    }
  });

  it("rejects a multibase without the base58btc 'z' prefix", () => {
    expect(() => rawEd25519FromMultibase(VECTORS[0].multibase.slice(1))).toThrow(TypeError);
    expect(() => rawEd25519FromMultibase("u" + VECTORS[0].multibase.slice(1))).toThrow(TypeError);
    expect(() => rawEd25519FromMultibase("")).toThrow(TypeError);
  });

  it("rejects a multibase whose multicodec prefix is not ed25519-pub (0xed 0x01)", () => {
    const x25519Prefixed = new Uint8Array(34);
    x25519Prefixed[0] = 0xec;
    x25519Prefixed[1] = 0x01;
    const wrongCodec = "z" + base58btcEncode(x25519Prefixed);
    expect(() => rawEd25519FromMultibase(wrongCodec)).toThrow(TypeError);
  });

  it("rejects a truncated payload (not 32 key bytes after the codec prefix)", () => {
    const short = new Uint8Array(33);
    short[0] = 0xed;
    short[1] = 0x01;
    expect(() => rawEd25519FromMultibase("z" + base58btcEncode(short))).toThrow(TypeError);
  });

  it("rejects an oversized multibase fast, without entering the O(n^2) BigInt loop", () => {
    const huge = "z" + "1".repeat(64_000);
    const start = performance.now();
    expect(() => rawEd25519FromMultibase(huge)).toThrow(/too long/);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("base58btc encode/decode", () => {
  it("preserves leading zero bytes as leading '1' characters", () => {
    expect(base58btcEncode(Uint8Array.from([0, 0, 1]))).toBe("112");
    expect(Array.from(base58btcDecode("112"))).toEqual([0, 0, 1]);
    expect(base58btcEncode(Uint8Array.from([0]))).toBe("1");
    expect(Array.from(base58btcDecode("1"))).toEqual([0]);
  });

  it("encodes the empty input to the empty string and back", () => {
    expect(base58btcEncode(new Uint8Array(0))).toBe("");
    expect(Array.from(base58btcDecode(""))).toEqual([]);
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 5) % 256);
    expect(Array.from(base58btcDecode(base58btcEncode(bytes)))).toEqual(Array.from(bytes));
  });
});
