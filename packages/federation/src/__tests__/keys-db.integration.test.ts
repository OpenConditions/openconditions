import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  buildActorDocument,
  ensureInstanceKey,
  loadActiveKeys,
  rotateInstanceKey,
  type ActorConfig,
} from "../index.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const T_BOOTSTRAP = "2026-01-01T00:00:00.000Z";
const T_ROTATE = "2026-06-25T00:00:00.000Z";
const T_OVERLAP = "2026-06-30T00:00:00.000Z";
const T_AFTER_OVERLAP = "2026-07-26T00:00:00.000Z";

const ACTOR_CONFIG: ActorConfig = {
  instanceId: "oc-test",
  baseUrl: "https://conditions.example.org",
  operator: "Test Operator",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  supportedTypes: ["incident"],
  license: "ODbL-1.0",
  trustTier: 0,
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

describe("migration 0013 — federation_instance_key", () => {
  it("creates the table with its columns", async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'federation_instance_key'`;
    expect(new Set(cols.map((c) => c.column_name))).toEqual(
      new Set([
        "key_id",
        "public_key",
        "private_key",
        "multibase",
        "not_before",
        "not_after",
        "created_at",
      ])
    );
  }, 30_000);
});

describe("instance key lifecycle", () => {
  it("ensureInstanceKey bootstraps exactly one key, idempotently", async () => {
    await ensureInstanceKey(sql, T_BOOTSTRAP);
    await ensureInstanceKey(sql, T_BOOTSTRAP);
    const rows = await sql<{ key_id: string; multibase: string }[]>`
      SELECT key_id, multibase FROM conditions.federation_instance_key`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_id).toBe(rows[0]!.multibase);
    expect(rows[0]!.multibase).toMatch(/^z6Mk/);

    const active = await loadActiveKeys(sql, T_BOOTSTRAP);
    expect(active).toHaveLength(1);
    expect(active[0]!.notAfter.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  }, 30_000);

  it("a loaded key signs and verifies after the pkcs8 database round-trip", async () => {
    const [key] = await loadActiveKeys(sql, T_BOOTSTRAP);
    const message = new TextEncoder().encode("persisted key round-trip");
    const signature = await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      key!.privateKey,
      message
    );
    await expect(
      globalThis.crypto.subtle.verify({ name: "Ed25519" }, key!.publicKey, signature, message)
    ).resolves.toBe(true);
  }, 30_000);

  it("rotateInstanceKey adds a second key and extends the old one to a ≥30-day overlap", async () => {
    const [oldKey] = await loadActiveKeys(sql, T_BOOTSTRAP);
    const newKey = await rotateInstanceKey(sql, T_ROTATE);
    expect(newKey.keyId).not.toBe(oldKey!.keyId);
    expect(newKey.notBefore.toISOString()).toBe(T_ROTATE);
    expect(newKey.notAfter.toISOString()).toBe("2026-12-25T00:00:00.000Z");

    const rows = await sql<{ key_id: string; not_after: Date }[]>`
      SELECT key_id, not_after FROM conditions.federation_instance_key`;
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.key_id === oldKey!.keyId);
    expect(oldRow!.not_after.toISOString()).toBe("2026-07-25T00:00:00.000Z");
  }, 30_000);

  it("loadActiveKeys returns BOTH keys during the overlap window, newest first", async () => {
    const active = await loadActiveKeys(sql, T_OVERLAP);
    expect(active).toHaveLength(2);
    expect(active[0]!.notBefore.toISOString()).toBe(T_ROTATE);
  }, 30_000);

  it("the Actor document carries both keys in the overlap and only the new one after", async () => {
    const during = buildActorDocument(ACTOR_CONFIG, await loadActiveKeys(sql, T_OVERLAP));
    expect(during.publicKey).toHaveLength(2);

    const after = buildActorDocument(ACTOR_CONFIG, await loadActiveKeys(sql, T_AFTER_OVERLAP));
    expect(after.publicKey).toHaveLength(1);
    expect(after.publicKey[0]!.publicKeyMultibase).toMatch(/^z6Mk/);
  }, 30_000);

  it("after the old key's extended not_after only the new key is active", async () => {
    const active = await loadActiveKeys(sql, T_AFTER_OVERLAP);
    expect(active).toHaveLength(1);
    expect(active[0]!.notBefore.toISOString()).toBe(T_ROTATE);
  }, 30_000);

  it("rotation never shortens an old key that already outlives the overlap window", async () => {
    const [longLived] = await loadActiveKeys(sql, T_AFTER_OVERLAP);
    await rotateInstanceKey(sql, "2026-07-27T00:00:00.000Z");
    const rows = await sql<{ not_after: Date }[]>`
      SELECT not_after FROM conditions.federation_instance_key
      WHERE key_id = ${longLived!.keyId}`;
    expect(rows[0]!.not_after.toISOString()).toBe("2026-12-25T00:00:00.000Z");
  }, 30_000);

  it("ensureInstanceKey bootstraps again once every key has expired", async () => {
    const t = "2027-02-01T00:00:00.000Z";
    expect(await loadActiveKeys(sql, t)).toHaveLength(0);
    await ensureInstanceKey(sql, t);
    const active = await loadActiveKeys(sql, t);
    expect(active).toHaveLength(1);
  }, 30_000);
});
