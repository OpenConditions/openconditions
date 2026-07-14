import { describe, expect, it } from "vitest";
import {
  buildActorDocument,
  generateInstanceKey,
  loadPeers,
  verifyActorAgainstPin,
  type ActorConfig,
  type InstanceKey,
  type PeerRecord,
} from "../index.js";

const NOW = "2026-01-01T00:00:00.000Z";
const ACTOR_URL = "https://conditions.example.org/.well-known/openconditions/actor.json";

const ACTOR_CONFIG: ActorConfig = {
  instanceId: "oc-nl-prod",
  baseUrl: "https://conditions.example.org",
  operator: "Example Mobility Foundation",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  supportedTypes: ["incident"],
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: {
    protocolVersion: "0.1",
    schemaVersions: ["1"],
    wireFormats: ["application/activity+json"],
    deliveryModes: ["pull"],
    subscriptionFilters: [],
    maxEventRate: 10,
    convergenceBound: 300,
  },
};

function peer(pinnedKeys: string[], overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    instanceId: "oc-nl-prod",
    actorUrl: ACTOR_URL,
    trustTier: 1,
    pinnedKeys,
    ...overrides,
  };
}

describe("loadPeers", () => {
  it("parses a peers.json document (text or parsed) into validated records", async () => {
    const key = await generateInstanceKey(NOW);
    const records = [
      {
        instanceId: "oc-nl-prod",
        actorUrl: ACTOR_URL,
        coverage: { iso3166: ["NL"] },
        trustTier: 1,
        pinnedKeys: [key.publicKeyMultibase],
      },
    ];
    expect(loadPeers(JSON.stringify(records))).toEqual(records);
    expect(loadPeers(records)).toEqual(records);
  });

  it("defaults to no peers on an empty array", () => {
    expect(loadPeers("[]")).toEqual([]);
  });

  it("rejects malformed JSON and non-array documents", () => {
    expect(() => loadPeers("{not json")).toThrow(TypeError);
    expect(() => loadPeers("{}")).toThrow(TypeError);
  });

  it("rejects a peer without a usable bilateral pin", async () => {
    const key = await generateInstanceKey(NOW);
    const valid = {
      instanceId: "a",
      actorUrl: ACTOR_URL,
      trustTier: 1,
      pinnedKeys: [key.publicKeyMultibase],
    };
    expect(() => loadPeers([{ ...valid, pinnedKeys: [] }])).toThrow(TypeError);
    expect(() => loadPeers([{ ...valid, pinnedKeys: undefined }])).toThrow(TypeError);
    expect(() => loadPeers([{ ...valid, pinnedKeys: ["not-a-multikey"] }])).toThrow(TypeError);
  });

  it("rejects bad instanceId, actorUrl, trustTier, and duplicate instanceIds", async () => {
    const key = await generateInstanceKey(NOW);
    const valid = {
      instanceId: "a",
      actorUrl: ACTOR_URL,
      trustTier: 1,
      pinnedKeys: [key.publicKeyMultibase],
    };
    expect(() => loadPeers([{ ...valid, instanceId: "" }])).toThrow(TypeError);
    expect(() => loadPeers([{ ...valid, actorUrl: "ftp://x" }])).toThrow(TypeError);
    expect(() => loadPeers([{ ...valid, trustTier: 5 }])).toThrow(TypeError);
    expect(() => loadPeers([valid, { ...valid }])).toThrow(TypeError);
  });

  it("parses the optional mTLS gate fields and validates their shape", async () => {
    const key = await generateInstanceKey(NOW);
    const valid = {
      instanceId: "a",
      actorUrl: ACTOR_URL,
      trustTier: 1 as const,
      pinnedKeys: [key.publicKeyMultibase],
    };
    const withMtls = { ...valid, mtlsRequired: true, mtlsFingerprints: ["AA:BB"] };
    expect(loadPeers([withMtls])[0]).toMatchObject({
      mtlsRequired: true,
      mtlsFingerprints: ["AA:BB"],
    });
    // Absent → the fields are simply not present (non-mTLS peer).
    expect(loadPeers([valid])[0]!.mtlsRequired).toBeUndefined();
    expect(() => loadPeers([{ ...valid, mtlsRequired: "yes" }])).toThrow(TypeError);
    expect(() => loadPeers([{ ...valid, mtlsFingerprints: "AA:BB" }])).toThrow(TypeError);
    expect(() => loadPeers([{ ...valid, mtlsFingerprints: [""] }])).toThrow(TypeError);
  });
});

describe("verifyActorAgainstPin", () => {
  async function actorWith(keys: InstanceKey[]) {
    return buildActorDocument(ACTOR_CONFIG, keys);
  }

  it("accepts an actor whose publicKey[] includes a pinned key", async () => {
    const key = await generateInstanceKey(NOW);
    const actor = await actorWith([key]);
    const result = verifyActorAgainstPin(actor, peer([key.publicKeyMultibase]));
    expect(result).toEqual({ ok: true, matchedKeys: [key.publicKeyMultibase] });
  });

  it("accepts during rotation overlap when only the OLD key is pinned", async () => {
    const oldKey = await generateInstanceKey(NOW);
    const newKey = await generateInstanceKey(NOW);
    const actor = await actorWith([newKey, oldKey]);
    const result = verifyActorAgainstPin(actor, peer([oldKey.publicKeyMultibase]));
    expect(result.ok).toBe(true);
    expect(result.matchedKeys).toEqual([oldKey.publicKeyMultibase]);
  });

  it("rejects a substituted runtime key (actor serves only unpinned keys)", async () => {
    const pinned = await generateInstanceKey(NOW);
    const substituted = await generateInstanceKey(NOW);
    const actor = await actorWith([substituted]);
    const result = verifyActorAgainstPin(actor, peer([pinned.publicKeyMultibase]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unpinned/);
    expect(result.matchedKeys).toEqual([]);
  });

  it("rejects a rolled-back actor serving only a retired key that was never pinned", async () => {
    const retired = await generateInstanceKey("2025-01-01T00:00:00.000Z");
    const current = await generateInstanceKey(NOW);
    const rolledBack = await actorWith([retired]);
    const result = verifyActorAgainstPin(rolledBack, peer([current.publicKeyMultibase]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unpinned/);
  });

  it("rejects an actor document that serves no keys at all", async () => {
    const key = await generateInstanceKey(NOW);
    const actor = await actorWith([key]);
    const stripped = { ...actor, publicKey: [] };
    const result = verifyActorAgainstPin(stripped, peer([key.publicKeyMultibase]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no public keys/);
  });

  it("rejects an actor whose id is not the pinned actorUrl", async () => {
    const key = await generateInstanceKey(NOW);
    const actor = await actorWith([key]);
    const result = verifyActorAgainstPin(
      actor,
      peer([key.publicKeyMultibase], { actorUrl: "https://evil.example.net/actor.json" })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/actorUrl/);
  });

  it("rejects when the peer record itself pins no keys", async () => {
    const key = await generateInstanceKey(NOW);
    const actor = await actorWith([key]);
    const result = verifyActorAgainstPin(actor, peer([]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/pins no keys/);
  });
});
