import { runMigrations } from "@openconditions/core/server";
import { schemaVersions } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActorConfig,
  buildActorDocument,
  generateInstanceKey,
  type InstanceKey,
  loadPeerVersions,
  type PeerRecord,
  peerVersionsFromActor,
  refreshPeerCapabilities,
} from "../index.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  await runMigrations(url);
  sql = postgres(url, { max: 4 });
  key = await generateInstanceKey(NOW);
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("a peer's capabilities", () => {
  it("are the schema versions its pinned actor document advertises", () => {
    const actor = buildActorDocument(CONFIG, [key], versions);
    expect(peerVersionsFromActor(actor, peer(), local)).toEqual({
      ok: true,
      schemaVersions: versions,
    });
  });

  it("are refused from a document that fails its pin or shares no kernel major", () => {
    const actor = buildActorDocument(CONFIG, [key], versions);
    expect(
      peerVersionsFromActor(actor, { ...peer(), pinnedKeys: ["zOther"] }, local),
    ).toMatchObject({ ok: false });
    const otherKernel = buildActorDocument(
      CONFIG,
      [key],
      versions.map((v) => (v.startsWith("kernel@") ? "kernel@2.0" : v)),
    );
    expect(peerVersionsFromActor(otherKernel, peer(), local)).toEqual({
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
