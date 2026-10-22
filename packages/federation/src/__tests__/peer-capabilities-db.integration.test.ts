import { schemaVersions } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActorConfig,
  buildActorDocument,
  chainedActorKeys,
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
      keys: [key.keyId],
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
  it("is trusted once the pinned key endorsed it, and its successor once it did", async () => {
    const next = await generateInstanceKey(LATER, 6, key);
    const overlap = buildActorDocument(CONFIG, [next, key], versions);
    expect(await peerVersionsFromActor(overlap, peer(), local)).toMatchObject({
      ok: true,
      keys: [next.keyId, key.keyId],
    });
    await refreshPeerCapabilities(sql, peer(), { local, fetchImpl: serving(overlap), now: LATER });
    const learned = (await loadLearnedKeys(sql)).get("peer.example.net");
    expect(learned?.sort()).toEqual([next.keyId, key.keyId].sort());

    // A rotation later, neither the pinned key nor its endorsement is served:
    // the learned key carries the trust, and the retired one is dropped.
    const third = await generateInstanceKey(LATER, 6, next);
    const after = buildActorDocument(CONFIG, [third], versions);
    expect(await peerVersionsFromActor(after, peer(), local)).toMatchObject({ ok: false });
    const trusting = withLearnedKeys(peer(), learned);
    expect(
      await refreshPeerCapabilities(sql, trusting, {
        local,
        fetchImpl: serving(after),
        now: LATER,
      }),
    ).toMatchObject({ ok: true, keys: [third.keyId] });
    expect((await loadLearnedKeys(sql)).get("peer.example.net")).toEqual([third.keyId]);
  });

  it("is not trusted on an endorsement that signs another key or comes from an unpinned one", async () => {
    const next = await generateInstanceKey(LATER, 6, key);
    const impostor = await generateInstanceKey(LATER);
    const stolen = { ...impostor, endorsement: next.endorsement! };
    expect(
      await chainedActorKeys(
        buildActorDocument(CONFIG, [stolen, key], versions),
        new Set([key.keyId]),
      ),
    ).toEqual([key.keyId]);

    const stranger = await generateInstanceKey(NOW);
    const vouched = await generateInstanceKey(LATER, 6, stranger);
    expect(
      await chainedActorKeys(
        buildActorDocument(CONFIG, [vouched, stranger, key], versions),
        new Set([key.keyId]),
      ),
    ).toEqual([key.keyId]);
  });

  it("is trusted along a chain the document serves", async () => {
    const second = await generateInstanceKey(LATER, 6, key);
    const third = await generateInstanceKey(LATER, 6, second);
    expect(
      await chainedActorKeys(
        buildActorDocument(CONFIG, [third, second], versions),
        new Set([key.keyId]),
      ),
    ).toEqual([third.keyId, second.keyId]);
  });
});
