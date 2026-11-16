/**
 * The test vectors docs/federation-protocol.md points a second implementation
 * at, checked against this one so the two cannot drift apart: the signed
 * request and the response bound to it (Ed25519 is deterministic, so the
 * signatures are recomputed and compared byte for byte), Content-Digest,
 * publicKeyMultibase, cursors, an example page and how entries are read.
 */
import { createPrivateKey, sign as edSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { schemaVersions } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { describe, expect, it } from "vitest";
import { admitFederatedRecord, readInboundEntry } from "../admit.js";
import { FEDERATION_PROTOCOL_VERSION } from "../capabilities.js";
import {
  contentDigest,
  InMemoryNonceStore,
  signMessage,
  verifyContentDigest,
  verifyMessage,
} from "../http-signature.js";
import { multibaseFromRawEd25519, rawEd25519FromMultibase } from "../multibase.js";
import { decodeOutboxCursor, encodeOutboxCursor } from "../outbox.js";

async function vector<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`./vectors/${name}`, import.meta.url), "utf8")) as T;
}

interface SigningVector {
  protocolVersion: string;
  key: { privateKeyPkcs8Base64: string; publicKeySpkiBase64: string; keyId: string };
  created: number;
  expires: number;
  request: {
    method: string;
    url: string;
    nonce: string;
    signatureBase: string;
    headers: Record<string, string>;
  };
  response: {
    status: number;
    nonce: string;
    body: string;
    signatureBase: string;
    headers: Record<string, string>;
  };
}

const ED25519 = { name: "Ed25519" } as const;

/** The vector's Ed25519 signature over `base`, by node:crypto rather than the signer under test. */
function independentSignature(key: SigningVector["key"], base: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(key.privateKeyPkcs8Base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return `oc=:${edSign(null, Buffer.from(base, "utf8"), privateKey).toString("base64")}:`;
}

describe("the protocol version", () => {
  it("is the one the vectors and the specification describe", async () => {
    expect(FEDERATION_PROTOCOL_VERSION).toBe("0.2");
    expect((await vector<SigningVector>("signing.json")).protocolVersion).toBe(
      FEDERATION_PROTOCOL_VERSION,
    );
    expect((await vector<{ protocolVersion: string }>("page.json")).protocolVersion).toBe(
      FEDERATION_PROTOCOL_VERSION,
    );
  });
});

describe("signing.json", () => {
  it("names the test key by its publicKeyMultibase", async () => {
    const { key } = await vector<SigningVector>("signing.json");
    const raw = Buffer.from(key.publicKeySpkiBase64, "base64").subarray(-32);
    expect(multibaseFromRawEd25519(new Uint8Array(raw))).toBe(key.keyId);
  });

  it("signs the request and the response bound to it exactly as the vector states", async () => {
    const v = await vector<SigningVector>("signing.json");
    const privateKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(v.key.privateKeyPkcs8Base64, "base64") as BufferSource,
      ED25519,
      false,
      ["sign"],
    );
    const common = { keyId: v.key.keyId, privateKey, created: v.created, expires: v.expires };

    const request = await signMessage({
      method: v.request.method,
      url: v.request.url,
      headers: {},
      nonce: v.request.nonce,
      ...common,
    });
    expect(request.headers).toEqual(v.request.headers);
    expect(v.request.headers["Signature"]).toBe(
      independentSignature(v.key, v.request.signatureBase),
    );

    const answered = { method: v.request.method, url: v.request.url, headers: request.headers };
    const response = await signMessage({
      ...answered,
      headers: { "content-type": v.response.headers["content-type"]! },
      body: Buffer.from(v.response.body, "utf8"),
      nonce: v.response.nonce,
      isResponse: true,
      status: v.response.status,
      request: answered,
      ...common,
    });
    expect(response.headers).toEqual(v.response.headers);
    expect(v.response.headers["Signature"]).toBe(
      independentSignature(v.key, v.response.signatureBase),
    );
  });

  it("verifies both within their window, and the response only against its request", async () => {
    const v = await vector<SigningVector>("signing.json");
    const publicKey = await globalThis.crypto.subtle.importKey(
      "spki",
      Buffer.from(v.key.publicKeySpkiBase64, "base64") as BufferSource,
      ED25519,
      false,
      ["verify"],
    );
    const resolvePublicKey = async (keyId: string) => (keyId === v.key.keyId ? publicKey : null);
    const now = v.created + 1;

    expect(
      await verifyMessage({
        method: v.request.method,
        url: v.request.url,
        headers: v.request.headers,
        resolvePublicKey,
        nonceStore: new InMemoryNonceStore(),
        now,
      }),
    ).toEqual({ ok: true, keyId: v.key.keyId });

    const answered = { method: v.request.method, url: v.request.url, headers: v.request.headers };
    const verifyResponse = (request: typeof answered, at = now) =>
      verifyMessage({
        ...request,
        status: v.response.status,
        headers: v.response.headers,
        body: Buffer.from(v.response.body, "utf8"),
        isResponse: true,
        request,
        resolvePublicKey,
        nonceStore: new InMemoryNonceStore(),
        now: at,
      });
    expect(await verifyResponse(answered)).toEqual({ ok: true, keyId: v.key.keyId });
    expect(await verifyResponse({ ...answered, url: `${v.request.url}&kinds=incident` })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(await verifyResponse(answered, v.expires + 31)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("content-digest.json", () => {
  it("states the Content-Digest of each body", async () => {
    const { cases } = await vector<{ cases: { body: string; contentDigest: string }[] }>(
      "content-digest.json",
    );
    for (const { body, contentDigest: digest } of cases) {
      const bytes = Buffer.from(body, "utf8");
      expect(await contentDigest(bytes)).toBe(digest);
      expect(await verifyContentDigest(digest, bytes)).toBe(true);
      expect(await verifyContentDigest(digest, Buffer.from(`${body} `, "utf8"))).toBe(false);
    }
  });
});

describe("multibase.json", () => {
  it("encodes each raw key as its publicKeyMultibase and back", async () => {
    const { cases } = await vector<{
      cases: { publicKeyRawHex: string; publicKeyMultibase: string }[];
    }>("multibase.json");
    for (const { publicKeyRawHex, publicKeyMultibase } of cases) {
      const raw = new Uint8Array(Buffer.from(publicKeyRawHex, "hex"));
      expect(multibaseFromRawEd25519(raw)).toBe(publicKeyMultibase);
      expect(Buffer.from(rawEd25519FromMultibase(publicKeyMultibase)).toString("hex")).toBe(
        publicKeyRawHex,
      );
    }
  });
});

describe("cursors.json", () => {
  it("reads the valid wire forms, refuses the others, and orders by txid then seq", async () => {
    const v = await vector<{
      valid: { wire: string; txid: string; seq: number }[];
      invalid: string[];
      ascending: string[];
    }>("cursors.json");
    for (const { wire, txid, seq } of v.valid) {
      expect(decodeOutboxCursor(wire)).toEqual({ txid, seq });
      expect(encodeOutboxCursor({ txid, seq })).toBe(wire);
    }
    for (const wire of v.invalid) expect(decodeOutboxCursor(wire), wire).toBeNull();
    const order = (a: string, b: string) => {
      const x = decodeOutboxCursor(a)!;
      const y = decodeOutboxCursor(b)!;
      const dt = BigInt(x.txid) - BigInt(y.txid);
      return dt === 0n ? x.seq - y.seq : dt < 0n ? -1 : 1;
    };
    expect([...v.ascending].reverse().sort(order)).toEqual(v.ascending);
  });
});

describe("page.json", () => {
  it("is a page whose every entry is read, and whose record is admitted from its publisher", async () => {
    const v = await vector<{
      publisherInstanceId: string;
      page: { highWaterMark: string; epoch: string; orderedItems: unknown[] };
    }>("page.json");
    expect(decodeOutboxCursor(v.page.highWaterMark)).not.toBeNull();
    expect(v.page.epoch.length).toBeGreaterThan(0);
    expect(v.page.epoch.length).toBeLessThanOrEqual(64);
    const registry = productionRegistry();
    for (const item of v.page.orderedItems) {
      const read = readInboundEntry(item);
      expect(read.ok).toBe(true);
      if (read.ok && (read.entry.operation === "create" || read.entry.operation === "update")) {
        const admitted = admitFederatedRecord(
          registry,
          {
            peerInstanceId: v.publisherInstanceId,
            peerVersions: schemaVersions(registry),
            receivedAt: "2026-01-01T00:30:00.000Z",
          },
          read.entry.record,
        );
        expect(admitted.admitted).toBe(true);
        // The same record from any other instance is refused: peers send their own only.
        const relayed = admitFederatedRecord(
          registry,
          {
            peerInstanceId: "relay.example",
            peerVersions: schemaVersions(registry),
            receivedAt: "2026-01-01T00:30:00.000Z",
          },
          read.entry.record,
        );
        expect(relayed.admitted).toBe(false);
      }
    }
  });
});

describe("entries.json", () => {
  it("reads each accepted entry as stated, and refuses each other one with its reason", async () => {
    const v = await vector<{
      accepted: { wire: unknown; entry: unknown }[];
      refused: { wire: unknown; result: unknown }[];
    }>("entries.json");
    for (const { wire, entry } of v.accepted) {
      expect(readInboundEntry(wire)).toEqual({ ok: true, entry });
    }
    for (const { wire, result } of v.refused) {
      expect(readInboundEntry(wire)).toEqual(result);
    }
  });
});
