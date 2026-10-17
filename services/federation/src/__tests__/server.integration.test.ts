import { type ActorDocument, verifyActorAgainstPin } from "@openconditions/federation";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../server.js";

let db: TestDatabase;
let sql: postgres.Sql;

const NOW = "2026-01-01T00:00:00.000Z";

const ACTOR_CONFIG = {
  instanceId: "oc-test",
  baseUrl: "https://conditions.example.org",
  operator: "Test Operator",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: {
    protocolVersion: "0.1",
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
  OPENCONDITIONS_INSTANCE_ID: ACTOR_CONFIG.instanceId,
  OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(ACTOR_CONFIG),
  OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([PEER]),
};

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 3 } });
  sql = db.sql;
});

afterAll(async () => {
  await db?.close();
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
      build({ sql, env: { OPENCONDITIONS_FEDERATION_ENABLED: "true" }, logger: false }),
    ).rejects.toThrow(/OPENCONDITIONS_FEDERATION_ACTOR/);
  }, 30_000);

  it("fails the boot closed on an actor config that still names supported types", async () => {
    const env = {
      ...ENABLED_ENV,
      OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify({
        ...ACTOR_CONFIG,
        supportedTypes: ["incident"],
      }),
    };
    await expect(build({ sql, env, logger: false })).rejects.toThrow(/supportedTypes/);
  }, 30_000);

  it("fails the boot closed when the actor is not the instance its records carry", async () => {
    for (const instance of [{}, { OPENCONDITIONS_INSTANCE_ID: "oc-other" }]) {
      const { OPENCONDITIONS_INSTANCE_ID: _id, ...env } = ENABLED_ENV;
      await expect(build({ sql, env: { ...env, ...instance }, logger: false })).rejects.toThrow(
        /OPENCONDITIONS_INSTANCE_ID/,
      );
    }
  }, 30_000);

  it("fails the boot closed on a peer that is this instance, or an archive that is no URL", async () => {
    const self = {
      ...ENABLED_ENV,
      OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([{ ...PEER, instanceId: "oc-test" }]),
    };
    await expect(build({ sql, env: self, logger: false })).rejects.toThrow(/is this instance/);
    const archive = { ...ENABLED_ENV, OPENCONDITIONS_FEDERATION_ARCHIVE_URL: "/srv/archive" };
    await expect(build({ sql, env: archive, logger: false })).rejects.toThrow(/ARCHIVE_URL/);
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
      expect({
        outbox: doc.outbox,
        inbox: doc.inbox,
        subscriptions: doc.subscriptions,
        backfill: doc.backfill,
        stream: doc.stream,
      }).toEqual({
        outbox: "https://conditions.example.org/peer/outbox",
        inbox: "https://conditions.example.org/peer/inbox",
        subscriptions: "https://conditions.example.org/peer/subscriptions",
        backfill: "https://conditions.example.org/peer/backfill",
        stream: "https://conditions.example.org/peer/stream",
      });
      expect(doc).not.toHaveProperty("supportedTypes");
      expect(doc.capabilities.schemaVersions).toContain("kernel@1.1");
      expect(doc.capabilities.schemaVersions).toContain("situation/alert@1.1");

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
