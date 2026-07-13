import { describe, expect, it } from "vitest";
import {
  buildActorDocument,
  generateInstanceKey,
  parseActorConfig,
  type ActorConfig,
} from "../index.js";

const NOW = "2026-01-01T00:00:00.000Z";

function config(overrides: Partial<ActorConfig> = {}): ActorConfig {
  return {
    instanceId: "oc-nl-prod",
    baseUrl: "https://conditions.example.org",
    operator: "Example Mobility Foundation",
    jurisdiction: "NL",
    coverage: { iso3166: ["NL"], bbox: [3.3, 50.7, 7.2, 53.6] },
    supportedTypes: ["incident", "roadwork", "flow"],
    license: "ODbL-1.0",
    trustTier: 1,
    capabilities: {
      protocolVersion: "0.1",
      schemaVersions: ["1"],
      wireFormats: ["application/activity+json"],
      deliveryModes: ["pull"],
      subscriptionFilters: ["bbox", "type"],
      maxEventRate: 10,
      convergenceBound: 300,
    },
    ...overrides,
  };
}

describe("buildActorDocument", () => {
  it("builds the well-known actor shape with endpoints under /peer", async () => {
    const key = await generateInstanceKey(NOW);
    const doc = buildActorDocument(config(), [key]);
    const actorId = "https://conditions.example.org/.well-known/openconditions/actor.json";
    expect(doc.id).toBe(actorId);
    expect(doc.type).toEqual(["Service", "MobilityCommonsInstance"]);
    expect(doc.operator).toBe("Example Mobility Foundation");
    expect(doc.jurisdiction).toBe("NL");
    expect(doc.outbox).toBe("https://conditions.example.org/peer/outbox");
    expect(doc.inbox).toBe("https://conditions.example.org/peer/inbox");
    expect(doc.subscribe).toBe("https://conditions.example.org/peer/subscribe");
    expect(doc.events).toBe("https://conditions.example.org/peer/event/{id}");
    expect(doc.tombstones).toBe("https://conditions.example.org/peer/tombstones");
    expect(doc.coverage).toEqual({ iso3166: ["NL"], bbox: [3.3, 50.7, 7.2, 53.6] });
    expect(doc.supportedTypes).toEqual(["incident", "roadwork", "flow"]);
    expect(doc.capabilities.protocolVersion).toBe("0.1");
    expect(doc.license).toBe("ODbL-1.0");
    expect(doc.trustTier).toBe(1);
    expect(doc.trustAnchor).toEqual([]);
  });

  it("serves each active key as a Multikey entry keyed by its multibase", async () => {
    const key = await generateInstanceKey(NOW);
    const doc = buildActorDocument(config(), [key]);
    const actorId = doc.id;
    expect(doc.publicKey).toHaveLength(1);
    expect(doc.publicKey[0]).toEqual({
      id: `${actorId}#${key.keyId}`,
      owner: actorId,
      type: "Multikey",
      publicKeyMultibase: key.publicKeyMultibase,
    });
  });

  it("carries BOTH keys during a rotation overlap", async () => {
    const oldKey = await generateInstanceKey(NOW);
    const newKey = await generateInstanceKey("2026-06-25T00:00:00.000Z");
    const doc = buildActorDocument(config(), [newKey, oldKey]);
    expect(doc.publicKey.map((k) => k.publicKeyMultibase)).toEqual([
      newKey.publicKeyMultibase,
      oldKey.publicKeyMultibase,
    ]);
  });

  it("never leaks private key material (Multikey entries carry exactly four public fields)", async () => {
    const key = await generateInstanceKey(NOW);
    const doc = buildActorDocument(config(), [key]);
    expect(Object.keys(doc.publicKey[0]!).sort()).toEqual([
      "id",
      "owner",
      "publicKeyMultibase",
      "type",
    ]);
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("pkcs8");
  });

  it("normalizes a trailing slash on baseUrl", async () => {
    const key = await generateInstanceKey(NOW);
    const doc = buildActorDocument(config({ baseUrl: "https://conditions.example.org/" }), [key]);
    expect(doc.id).toBe("https://conditions.example.org/.well-known/openconditions/actor.json");
    expect(doc.outbox).toBe("https://conditions.example.org/peer/outbox");
  });

  it("includes optional fields only when configured", async () => {
    const key = await generateInstanceKey(NOW);
    const bare = buildActorDocument(config(), [key]);
    expect("transparencyReportUrl" in bare).toBe(false);
    expect("policyDocument" in bare).toBe(false);
    const full = buildActorDocument(
      config({
        transparencyReportUrl: "https://conditions.example.org/transparency",
        policyDocument: "https://conditions.example.org/policy",
        trustAnchors: ["z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],
      }),
      [key]
    );
    expect(full.transparencyReportUrl).toBe("https://conditions.example.org/transparency");
    expect(full.policyDocument).toBe("https://conditions.example.org/policy");
    expect(full.trustAnchor).toEqual(["z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"]);
  });

  it("refuses to build an actor document with no active keys", () => {
    expect(() => buildActorDocument(config(), [])).toThrow(TypeError);
  });
});

describe("parseActorConfig", () => {
  it("accepts a valid config as JSON text or as a parsed object", () => {
    const cfg = config();
    expect(parseActorConfig(JSON.stringify(cfg))).toEqual(cfg);
    expect(parseActorConfig(cfg)).toEqual(cfg);
  });

  it("rejects malformed JSON, missing fields, and bad values", () => {
    expect(() => parseActorConfig("{not json")).toThrow(TypeError);
    expect(() => parseActorConfig(JSON.stringify({ instanceId: "x" }))).toThrow(TypeError);
    expect(() => parseActorConfig({ ...config(), baseUrl: "ftp://nope" })).toThrow(TypeError);
    expect(() => parseActorConfig({ ...config(), trustTier: 3 })).toThrow(TypeError);
    expect(() => parseActorConfig({ ...config(), supportedTypes: "incident" })).toThrow(TypeError);
    expect(() =>
      parseActorConfig({ ...config(), capabilities: { protocolVersion: "0.1" } })
    ).toThrow(TypeError);
  });
});
