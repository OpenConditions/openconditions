import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { verifyActorAgainstPin, type ActorDocument } from "@openconditions/federation";
import { build } from "../server.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

const ACTOR_CONFIG = {
  instanceId: "oc-test",
  baseUrl: "https://conditions.example.org",
  operator: "Test Operator",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  supportedTypes: ["incident", "roadwork"],
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: {
    protocolVersion: "0.1",
    schemaVersions: ["1"],
    wireFormats: ["application/activity+json"],
    deliveryModes: ["pull"],
    subscriptionFilters: ["bbox"],
    maxEventRate: 10,
    convergenceBound: 300,
  },
};

const PEER = {
  instanceId: "oc-neighbor",
  actorUrl: "https://neighbor.example.net/.well-known/openconditions/actor.json",
  trustTier: 1,
  pinnedKeys: ["z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],
};

const ENABLED_ENV = {
  OPENCONDITIONS_FEDERATION_ENABLED: "true",
  OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(ACTOR_CONFIG),
  OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([PEER]),
};

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
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("federation disabled (the default)", () => {
  it("serves 404 on the well-known federation routes without touching the key table", async () => {
    const app = await build({ sql, env: {}, logger: false, now: () => NOW });
    try {
      for (const path of [
        "/.well-known/openconditions/actor.json",
        "/.well-known/openconditions/peers.json",
      ]) {
        const res = await app.inject({ method: "GET", url: path });
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toMatch(/disabled/);
      }
      const rows = await sql`SELECT key_id FROM conditions.federation_instance_key`;
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("reports federation disabled in /status", async () => {
    const app = await build({ sql, env: {}, logger: false, now: () => NOW });
    try {
      const res = await app.inject({ method: "GET", url: "/status" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ok", federation: false });
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("federation enabled", () => {
  it("fails the boot closed when enabled without an actor config", async () => {
    await expect(
      build({ sql, env: { OPENCONDITIONS_FEDERATION_ENABLED: "true" }, logger: false })
    ).rejects.toThrow(/OPENCONDITIONS_FEDERATION_ACTOR/);
  }, 30_000);

  it("bootstraps an instance key and serves the actor document as activity+json", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/openconditions/actor.json",
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/activity+json");
      const doc = res.json() as ActorDocument;
      expect(doc.id).toBe("https://conditions.example.org/.well-known/openconditions/actor.json");
      expect(doc.type).toEqual(["Service", "MobilityCommonsInstance"]);
      expect(doc.publicKey).toHaveLength(1);
      expect(doc.publicKey[0]!.publicKeyMultibase).toMatch(/^z6Mk/);
      expect(doc.outbox).toBe("https://conditions.example.org/peer/outbox");

      const rows = await sql`SELECT key_id FROM conditions.federation_instance_key`;
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("never serves private key material", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/openconditions/actor.json",
      });
      expect(res.body).not.toContain("privateKey");
      expect(res.body).not.toContain("private_key");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("the served actor verifies against a pin of its own key and rejects a foreign pin", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/openconditions/actor.json",
      });
      const doc = res.json() as ActorDocument;
      const servedKey = doc.publicKey[0]!.publicKeyMultibase;
      const pinned = verifyActorAgainstPin(doc, {
        instanceId: "oc-test",
        actorUrl: doc.id,
        trustTier: 1,
        pinnedKeys: [servedKey],
      });
      expect(pinned.ok).toBe(true);
      const foreign = verifyActorAgainstPin(doc, {
        instanceId: "oc-test",
        actorUrl: doc.id,
        trustTier: 1,
        pinnedKeys: ["z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],
      });
      expect(foreign.ok).toBe(false);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("serves the declared peers as public metadata", async () => {
    const app = await build({ sql, env: ENABLED_ENV, logger: false, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/.well-known/openconditions/peers.json",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ peers: [PEER] });
    } finally {
      await app.close();
    }
  }, 30_000);
});
