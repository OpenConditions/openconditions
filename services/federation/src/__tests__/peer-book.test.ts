import { generateInstanceKey, type PeerRecord } from "@openconditions/federation";
import { describe, expect, it } from "vitest";
import { resolveFederationSettings } from "../config.js";
import { PeerBook } from "../peer-book.js";

const NOW = "2026-10-22T12:00:00.000Z";

const peer = (instanceId: string, pinnedKeys: string[], over: Partial<PeerRecord> = {}) =>
  ({
    instanceId,
    actorUrl: `https://${instanceId}/.well-known/openconditions/actor.json`,
    trustTier: 1,
    pinnedKeys,
    ...over,
  }) as PeerRecord;

describe("the peers a registry sync found", () => {
  it("join the configured ones, which keep their own record and add the registry's keys", async () => {
    const [a, a2, b, self] = await Promise.all(
      [1, 2, 3, 4].map(async () => (await generateInstanceKey(NOW)).keyId),
    );
    const book = new PeerBook([peer("a.example.org", [a!], { trustTier: 2 })]);
    book.discover(
      [
        peer("a.example.org", [a2!], { trustTier: 0 }),
        peer("b.example.org", [b!]),
        peer("me.example.org", [self!]),
      ],
      "me.example.org",
    );
    expect(book.all().map((p) => [p.instanceId, p.trustTier, p.pinnedKeys])).toEqual([
      ["a.example.org", 2, [a, a2]],
      ["b.example.org", 1, [b]],
    ]);
    expect(book.discovered().map((p) => p.instanceId)).toEqual(["a.example.org", "b.example.org"]);

    // A later sync that drops a peer drops it here.
    book.discover([peer("a.example.org", [a2!])], "me.example.org");
    expect(book.find("b.example.org")).toBeUndefined();
  });

  it("never take a key a configured peer pins", async () => {
    const [a, b] = await Promise.all(
      [1, 2].map(async () => (await generateInstanceKey(NOW)).keyId),
    );
    const book = new PeerBook([peer("a.example.org", [a!])]);
    book.discover([peer("b.example.org", [a!, b!]), peer("c.example.org", [a!])], "me.example.org");
    expect(book.find("b.example.org")?.pinnedKeys).toEqual([b]);
    expect(book.find("c.example.org")).toBeUndefined();
  });
});

describe("the registry settings", () => {
  const enabled = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: "me.example.org",
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify({
      instanceId: "me.example.org",
      baseUrl: "https://me.example.org",
      operator: "Me",
      jurisdiction: "NL",
      coverage: {},
      license: "ODbL-1.0",
      trustTier: 1,
      capabilities: {
        protocolVersion: "0.1",
        wireFormats: [],
        deliveryModes: [],
        subscriptionFilters: [],
        maxEventRate: 10,
        convergenceBound: 300,
      },
    }),
  };

  it("are absent without a registry, and complete with one", () => {
    expect(resolveFederationSettings(enabled).registry).toBeUndefined();
    expect(
      resolveFederationSettings({
        ...enabled,
        OPENCONDITIONS_FEDERATION_REGISTRY_URL: "https://registry.example.org/",
        OPENCONDITIONS_FEDERATION_REGISTRY_ROOT: '{"signed":{}}',
        OPENCONDITIONS_FEDERATION_REGISTRY_CACHE: "/data/registry",
      }).registry,
    ).toEqual({
      metadataUrl: "https://registry.example.org/metadata",
      targetsUrl: "https://registry.example.org/targets",
      root: '{"signed":{}}',
      cacheDir: "/data/registry",
    });
  });

  it("fail the boot when only half of the registry is configured", () => {
    expect(() =>
      resolveFederationSettings({
        ...enabled,
        OPENCONDITIONS_FEDERATION_REGISTRY_URL: "https://registry.example.org",
      }),
    ).toThrow(/needs both/);
    expect(() =>
      resolveFederationSettings({
        ...enabled,
        OPENCONDITIONS_FEDERATION_REGISTRY_URL: "file:///registry",
        OPENCONDITIONS_FEDERATION_REGISTRY_ROOT: "{}",
      }),
    ).toThrow(/http\(s\) URL/);
  });
});
