import { describe, expect, it } from "vitest";
import { contentDigest, verifyContentDigest } from "../http-signature.js";

/**
 * Conformance against the digest values published in RFC 9530
 * (https://www.rfc-editor.org/rfc/rfc9530.txt, RFC 8792 line wrapping
 * unfolded). Federation sends and checks Content-Digest; with no content
 * coding, the Repr-Digest examples are digests of the same bytes.
 */

const text = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "hex"));

const HELLO = text('{"hello": "world"}');
const HELLO_LF = text('{"hello": "world"}\n');
/**
 * §B.4/B.6: {"hello": "world"} followed by LF, Brotli-encoded. The figures
 * print the first two bytes as 8B 08, which is not a valid Brotli stream; the
 * published digests are those of the encoder's actual output, 0B 09.
 */
const HELLO_BROTLI = hex("0B 09 80 7B 22 68 65 6C 6C 6F 22 3A 20 22 77 6F 72 6C 64 22 7D 0A 03");

/** Content and the sha-256 / sha-512 field values the RFC gives for it. */
const vectors: { where: string; content: Uint8Array; sha256?: string; sha512?: string }[] = [
  {
    where: "Appendix D (sample digest values)",
    content: HELLO,
    sha256: "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:",
    sha512:
      "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
  },
  {
    where: "§B.1 (full representation data)",
    content: HELLO_LF,
    sha256: "sha-256=:RK/0qy18MlBSVnWgjwz6lZEWjP/lF5HF9bvEF8FabDg=:",
  },
  {
    where: "§B.2 (empty content)",
    content: new Uint8Array(),
    sha256: "sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:",
  },
  {
    where: "§B.3 (partial content, bytes 10-18)",
    content: HELLO_LF.slice(10),
    sha256: "sha-256=:jjcgBDWNAtbYUXI37CVG3gRuGOAjaaDRGpIUFsdyepQ=:",
  },
  {
    where: "§B.6 (encoded content, two algorithms)",
    content: HELLO_BROTLI,
    sha256: "sha-256=:d435Qo+nKZ+gLcUHn7GQtQ72hiBVAgqoLsZnZPiTGPk=:",
    sha512:
      "sha-512=:db7fdBbgZMgX1Wb2MjA8zZj+rSNgfmDCEEXM8qLWfpfoNY0sCpHAzZbj09X1/7HAb7Od5Qfto4QpuBsFbUO3dQ==:",
  },
  {
    where: "§B.7 (POST request content)",
    content: text('{"title": "New Title"}\n'),
    sha256: "sha-256=:mEkdbO7Srd9LIOegftO0aBX+VPTVz7/CSHes2Z27gc4=:",
  },
  {
    where: "§B.7 (multiline response content)",
    content: text('{\n  "id": "123",\n  "title": "New Title"\n}\n'),
    sha256: "sha-256=:uVSlinTTdQUwm2On4k8TJUikGN1bf/Ds8WPX4oe0h9I=:",
  },
  {
    where: "§B.8 (status response content)",
    content: text(
      '{\n  "status": "created",\n  "id": "123",\n  "ts": 1569327729,\n  "instance": "/books/123"\n}\n',
    ),
    sha256: "sha-256=:yXIGDTN5VrfoyisKlXgRKUHHMs35SNtyC3szSz1dbO8=:",
  },
  {
    where: "§B.10 (error response content)",
    content: text(
      '{\n  "title": "Not Found",\n  "detail": "Cannot PATCH a non-existent resource",\n  "status": 404\n}\n',
    ),
    sha256: "sha-256=:EXB0S2VF2H7ijkAVJkH1Sm0pBho0iDZcvVUHHXTTZSA=:",
  },
];

describe("RFC 9530 Content-Digest vectors", () => {
  it.each(vectors)("computes the published values for $where", async (v) => {
    if (v.sha256) expect(await contentDigest(v.content)).toBe(v.sha256);
    if (v.sha512) expect(await contentDigest(v.content, "sha-512")).toBe(v.sha512);
  });

  it.each(vectors)("accepts the published values for $where, alone or together", async (v) => {
    const values = [v.sha256, v.sha512].filter((x): x is string => x !== undefined);
    for (const value of values) expect(await verifyContentDigest(value, v.content)).toBe(true);
    expect(await verifyContentDigest(values.join(", "), v.content)).toBe(true);
  });

  it.each(vectors)("rejects the published values for $where on other content", async (v) => {
    const other = new Uint8Array([...v.content, 0x20]);
    for (const value of [v.sha256, v.sha512]) {
      if (value) expect(await verifyContentDigest(value, other)).toBe(false);
    }
  });

  it("rejects a field when any supported algorithm disagrees with the content", async () => {
    const [b6] = vectors.filter((v) => v.where.startsWith("§B.6"));
    const wrong512 = vectors[0]!.sha512!;
    expect(await verifyContentDigest(`${b6!.sha256}, ${wrong512}`, b6!.content)).toBe(false);
  });

  it("does not rely on the insecure algorithms of Appendix D", async () => {
    // Appendix D's md5, sha, unixsum and crc32c values for {"hello": "world"}.
    for (const value of [
      "md5=:Sd/dVLAcvNLSq16eXua5uQ==:",
      "sha=:07CavjDP4u3/TungoUHJO/Wzr4c=:",
      "unixsum=:GQU=:",
      "crc32c=:Q3lHIA==:",
    ]) {
      expect(await verifyContentDigest(value, HELLO), value).toBe(false);
    }
    // Beside a secure value, they are ignored rather than trusted.
    expect(await verifyContentDigest(`md5=:AAAA:, ${vectors[0]!.sha256}`, HELLO)).toBe(true);
  });

  it("rejects malformed fields", async () => {
    for (const value of [
      "",
      "sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=",
      "SHA-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:",
      'sha-256="X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE="',
    ]) {
      expect(await verifyContentDigest(value, HELLO), value).toBe(false);
    }
  });
});
