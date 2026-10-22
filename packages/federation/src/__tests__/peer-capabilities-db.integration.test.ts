import { schemaVersions } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActorConfig,
  buildActorDocument,
  chainedActorKeys,
  endorsementMessage,
  generateInstanceKey,
  type InstanceKey,
  loadLearnedKeys,
  loadPeerVersions,
  type PeerRecord,
  peerVersionsFromActor,
  refreshPeerCapabilities,
  withLearnedKeys,
} from "../index.js";

let db: TestDatabase;
let sql: postgres.Sql;

const NOW = "2026-10-02T10:00:00.000Z";
const LATER = "2026-10-02T11:00:00.000Z";
const ACTOR_URL = "https://peer.example.net/.well-known/openconditions/actor.json";
const versions = schemaVersions(productionRegistry());

const CONFIG: ActorConfig = {
  instanceId: "peer.example.net",
  baseUrl: "https://peer.example.net",
  operator: "Peer Operator",
  jurisdiction: "BE",
  coverage: { iso3166: ["BE"] },
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: {
    protocolVersion: "0.1",
    wireFormats: ["application/activity+json"],
    deliveryModes: ["pull"],
    subscriptionFilters: [],
    maxEventRate: 10,
    convergenceBound: 300,
  },
};
const local = { ...CONFIG.capabilities, schemaVersions: versions };

let key: InstanceKey;
const peer = (): PeerRecord => ({
  instanceId: "peer.example.net",
  actorUrl: ACTOR_URL,
  trustTier: 1,
  pinnedKeys: [key.publicKeyMultibase],
});
const serving = (document: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(document), { status: 200 })) as typeof fetch;

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 4 } });
  sql = db.sql;
  key = await generateInstanceKey(NOW);
});

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("a peer's capabilities", () => {
  it("are the schema versions its pinned actor document advertises", async () => {
    const actor = buildActorDocument(CONFIG, [key], versions);
    expect(await peerVersionsFromActor(actor, peer(), local)).toEqual({
      ok: true,
      schemaVersions: versions,
      keys: new Map([[key.keyId, key.keyId]]),
    });
  });

  it("are refused from a document that fails its pin or shares no kernel major", async () => {
    const actor = buildActorDocument(CONFIG, [key], versions);
    expect(
      await peerVersionsFromActor(actor, { ...peer(), pinnedKeys: ["zOther"] }, local),
    ).toMatchObject({ ok: false });
    const otherKernel = buildActorDocument(
      CONFIG,
      [key],
      versions.map((v) => (v.startsWith("kernel@") ? "kernel@2.0" : v)),
    );
    expect(await peerVersionsFromActor(otherKernel, peer(), local)).toEqual({
      ok: false,
      reason: "no shared kernel major: every record class differs",
    });
  });

  it("are kept on refresh, and an unreachable peer keeps what was last verified", async () => {
    expect(await loadPeerVersions(sql, "peer.example.net")).toBeUndefined();
    const actor = buildActorDocument(CONFIG, [key], versions);
    await refreshPeerCapabilities(sql, peer(), { local, fetchImpl: serving(actor), now: NOW });
    expect(await loadPeerVersions(sql, "peer.example.net")).toEqual(versions);

    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    expect(
      await refreshPeerCapabilities(sql, peer(), { local, fetchImpl: down, now: LATER }),
    ).toEqual({ ok: false, reason: "the actor document answered 503" });
    expect(await loadPeerVersions(sql, "peer.example.net")).toEqual(versions);
  });
});

describe("a peer's rotated key", () => {
  const PEER = "peer.example.net";
  const endorsedBy = (endorser: InstanceKey, instanceId = PEER) =>
    generateInstanceKey(LATER, 6, { key: endorser, instanceId });
  const pinned = () => new Map([[key.keyId, key.keyId]]);
  const chained = async (keys: InstanceKey[], instanceId = PEER) => [
    ...(
      await chainedActorKeys(buildActorDocument(CONFIG, keys, versions), instanceId, pinned())
    ).keys(),
  ];

  it("is trusted once the pinned key endorsed it, and its successor once it did", async () => {
    const next = await endorsedBy(key);
    const overlap = buildActorDocument(CONFIG, [next, key], versions);
    const verified = await peerVersionsFromActor(overlap, peer(), local);
    expect(verified).toMatchObject({
      ok: true,
      keys: new Map([
        [next.keyId, key.keyId],
        [key.keyId, key.keyId],
      ]),
    });
    await refreshPeerCapabilities(sql, peer(), { local, fetchImpl: serving(overlap), now: LATER });
    const learned = (await loadLearnedKeys(sql)).get(PEER);
    expect(learned).toEqual(new Map([[next.keyId, key.keyId]]));

    // A rotation later, neither the pinned key nor its endorsement is served:
    // the learned key carries the trust, and the retired one is dropped.
    const third = await endorsedBy(next);
    const after = buildActorDocument(CONFIG, [third], versions);
    expect(await peerVersionsFromActor(after, peer(), local)).toMatchObject({ ok: false });
    expect(
      await refreshPeerCapabilities(sql, peer(), {
        local,
        fetchImpl: serving(after),
        now: LATER,
        learned,
      }),
    ).toMatchObject({ ok: true, keys: new Map([[third.keyId, key.keyId]]) });
    const relearned = (await loadLearnedKeys(sql)).get(PEER);
    expect(relearned).toEqual(new Map([[third.keyId, key.keyId]]));
    expect(withLearnedKeys(peer(), relearned).pinnedKeys).toEqual([key.keyId, third.keyId]);

    // The operator removing the pin revokes every key it led to.
    const repinned = { ...peer(), pinnedKeys: [(await generateInstanceKey(NOW)).keyId] };
    expect(withLearnedKeys(repinned, relearned).pinnedKeys).toEqual(repinned.pinnedKeys);
  });

  it("is not trusted on an endorsement of another key, instance, or by an unpinned key", async () => {
    const next = await endorsedBy(key);
    const impostor = await generateInstanceKey(LATER);
    expect(await chained([{ ...impostor, endorsement: next.endorsement! }, key])).toEqual([
      key.keyId,
    ]);

    // Another instance's key, endorsed by that instance, is not this peer's.
    const elsewhere = await endorsedBy(key, "other.example.net");
    expect(await chained([elsewhere, key])).toEqual([key.keyId]);

    // A peer that endorses a key it does not hold: its own signature holds,
    // the key's proof cannot.
    const victim = await generateInstanceKey(LATER);
    const message = endorsementMessage(PEER, victim.keyId);
    const sign = async (privateKey: CryptoKey) =>
      Buffer.from(
        await globalThis.crypto.subtle.sign(
          { name: "Ed25519" },
          privateKey,
          message as BufferSource,
        ),
      ).toString("base64url");
    const forged = {
      ...victim,
      endorsement: {
        by: key.keyId,
        signature: await sign(key.privateKey),
        proof: await sign(impostor.privateKey),
      },
    };
    expect(await chained([forged, key])).toEqual([key.keyId]);

    const stranger = await generateInstanceKey(NOW);
    expect(await chained([await endorsedBy(stranger), stranger, key])).toEqual([key.keyId]);
  });

  it("is trusted along a chain the document serves", async () => {
    const second = await endorsedBy(key);
    const third = await endorsedBy(second);
    expect(await chained([third, second])).toEqual([third.keyId, second.keyId]);
  });
});
