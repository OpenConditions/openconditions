import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { multibaseFromRawEd25519 } from "../multibase.js";
import {
  parseRegistryEntry,
  registryEntryFileName,
  registryToPeerRecords,
  type RegistryEntry,
} from "../registry.js";
import { loadPeers, verifyActorAgainstPin, type PeerRecord } from "../peers.js";
import type { ActorDocument } from "../actor.js";

function randomMultibase(): string {
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
  return multibaseFromRawEd25519(raw);
}

function sampleEntryObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "openmapx-de",
    actor: "https://de.example.org/.well-known/openconditions/actor.json",
    operator: {
      name: "OpenMapX DE e.V.",
      contact: "federation@de.example.org",
      jurisdiction: "DE",
    },
    coverage: { iso3166: ["DE"], bbox: [5.8, 47.2, 15.1, 55.1] },
    trustTier: 1,
    keys: [randomMultibase()],
    ...overrides,
  };
}

describe("parseRegistryEntry", () => {
  it("parses the documented registry YAML shape", () => {
    const object = sampleEntryObject();
    const entry = parseRegistryEntry(stringify(object));
    expect(entry.id).toBe("openmapx-de");
    expect(entry.actor).toBe("https://de.example.org/.well-known/openconditions/actor.json");
    expect(entry.operator).toEqual(object["operator"]);
    expect(entry.coverage).toEqual(object["coverage"]);
    expect(entry.trustTier).toBe(1);
    expect(entry.keys).toEqual(object["keys"]);
  });

  it("accepts coverage with only iso3166 or only bbox", () => {
    const iso = parseRegistryEntry(stringify(sampleEntryObject({ coverage: { iso3166: ["NL"] } })));
    expect(iso.coverage.bbox).toBeUndefined();
    const bbox = parseRegistryEntry(
      stringify(sampleEntryObject({ coverage: { bbox: [3.3, 50.7, 7.2, 53.6] } }))
    );
    expect(bbox.coverage.iso3166).toBeUndefined();
  });

  it("ignores unknown top-level fields for forward compatibility", () => {
    const entry = parseRegistryEntry(stringify(sampleEntryObject({ futureField: "ok" })));
    expect(entry.id).toBe("openmapx-de");
    expect((entry as unknown as Record<string, unknown>)["futureField"]).toBeUndefined();
  });

  it("throws on YAML that is not a mapping", () => {
    expect(() => parseRegistryEntry("just a string")).toThrow(TypeError);
    expect(() => parseRegistryEntry("- a\n- b\n")).toThrow(TypeError);
    expect(() => parseRegistryEntry("")).toThrow(TypeError);
  });

  it("throws on unparseable YAML", () => {
    expect(() => parseRegistryEntry("id: [unclosed")).toThrow();
  });

  it.each([
    ["missing id", { id: undefined }],
    ["empty id", { id: "" }],
    ["id with path characters", { id: "../evil" }],
    ["id with uppercase", { id: "OpenMapX" }],
    ["non-url actor", { actor: "not a url" }],
    ["non-http actor", { actor: "ftp://example.org/actor.json" }],
    ["missing operator", { operator: undefined }],
    ["operator missing name", { operator: { contact: "a@b.c", jurisdiction: "DE" } }],
    ["operator missing contact", { operator: { name: "X", jurisdiction: "DE" } }],
    ["operator missing jurisdiction", { operator: { name: "X", contact: "a@b.c" } }],
    ["missing coverage", { coverage: undefined }],
    ["coverage not an object", { coverage: "DE" }],
    ["bbox with 3 numbers", { coverage: { bbox: [1, 2, 3] } }],
    ["bbox out of range", { coverage: { bbox: [-181, 47.2, 15.1, 55.1] } }],
    ["bbox inverted", { coverage: { bbox: [15.1, 47.2, 5.8, 55.1] } }],
    ["iso3166 not strings", { coverage: { iso3166: [1] } }],
    ["trustTier 3", { trustTier: 3 }],
    ["trustTier string", { trustTier: "1" }],
    ["missing keys", { keys: undefined }],
    ["empty keys", { keys: [] }],
    ["non-multibase key", { keys: ["not-a-key"] }],
  ])("throws on %s", (_name, overrides) => {
    expect(() => parseRegistryEntry(stringify(sampleEntryObject(overrides)))).toThrow(TypeError);
  });

  it("throws on duplicate keys", () => {
    const key = randomMultibase();
    expect(() => parseRegistryEntry(stringify(sampleEntryObject({ keys: [key, key] })))).toThrow(
      TypeError
    );
  });
});

describe("registryEntryFileName", () => {
  it("maps an id to its target file name", () => {
    expect(registryEntryFileName("openmapx-de")).toBe("openmapx-de.yaml");
  });
});

describe("registryToPeerRecords", () => {
  it("maps registry entries to T1 peer records with keys as pinnedKeys", () => {
    const entry = parseRegistryEntry(stringify(sampleEntryObject()));
    const records = registryToPeerRecords([entry]);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      instanceId: "openmapx-de",
      actorUrl: entry.actor,
      coverage: entry.coverage,
      trustTier: 1,
      pinnedKeys: entry.keys,
    });
  });

  it("produces records that pass the T1 loadPeers validation round-trip", () => {
    const entries: RegistryEntry[] = [
      parseRegistryEntry(stringify(sampleEntryObject())),
      parseRegistryEntry(
        stringify(
          sampleEntryObject({
            id: "openmapx-nl",
            actor: "https://nl.example.org/.well-known/openconditions/actor.json",
            trustTier: 2,
          })
        )
      ),
    ];
    const records = registryToPeerRecords(entries);
    expect(loadPeers(JSON.stringify(records))).toEqual(records);
  });
});

describe("bilateral-pin bootstrap without the registry", () => {
  it("verifies a peer from an out-of-band pinned key alone", () => {
    const pinned = randomMultibase();
    const peers = loadPeers(
      JSON.stringify([
        {
          instanceId: "openmapx-nl",
          actorUrl: "https://nl.example.org/.well-known/openconditions/actor.json",
          trustTier: 1,
          pinnedKeys: [pinned],
        },
      ])
    );
    const actor = {
      id: "https://nl.example.org/.well-known/openconditions/actor.json",
      publicKey: [
        {
          id: pinned,
          owner: "https://nl.example.org",
          type: "Multikey",
          publicKeyMultibase: pinned,
        },
      ],
    } as unknown as ActorDocument;
    const result = verifyActorAgainstPin(actor, peers[0] as PeerRecord);
    expect(result.ok).toBe(true);
    expect(result.matchedKeys).toEqual([pinned]);
  });

  it("rejects a runtime key that matches neither the pin nor anything else", () => {
    const peers = loadPeers(
      JSON.stringify([
        {
          instanceId: "openmapx-nl",
          actorUrl: "https://nl.example.org/.well-known/openconditions/actor.json",
          trustTier: 1,
          pinnedKeys: [randomMultibase()],
        },
      ])
    );
    const substituted = randomMultibase();
    const actor = {
      id: "https://nl.example.org/.well-known/openconditions/actor.json",
      publicKey: [
        {
          id: substituted,
          owner: "https://nl.example.org",
          type: "Multikey",
          publicKeyMultibase: substituted,
        },
      ],
    } as unknown as ActorDocument;
    const result = verifyActorAgainstPin(actor, peers[0] as PeerRecord);
    expect(result.ok).toBe(false);
    expect(result.matchedKeys).toEqual([]);
  });
});
