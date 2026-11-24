import { SecretsKey } from "@openconditions/core/server";
import {
  createTestDatabase,
  dumpHolds,
  dumpTable,
  TEST_SECRETS_KEY,
  type TestDatabase,
} from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActorConfig,
  assertInstanceKeysOpen,
  buildActorDocument,
  type InstanceKey,
  loadActiveKeys,
  maintainInstanceKey,
  rotateInstanceKey,
  signingKeyOf,
  verifyEndorsement,
} from "../index.js";

let db: TestDatabase;
let sql: postgres.Sql;

const secrets = SecretsKey.parse(TEST_SECRETS_KEY);
const ME = "oc-test";
const T_BOOTSTRAP = "2026-01-01T00:00:00.000Z";
const T_QUIET = "2026-05-15T00:00:00.000Z";
const T_ROTATE = "2026-06-05T00:00:00.000Z";
const T_UNPUBLISHED = "2026-06-06T00:00:00.000Z";
const T_PUBLISHED = "2026-06-13T00:00:00.000Z";
const T_AFTER_OVERLAP = "2026-07-06T00:00:00.000Z";

const ACTOR_CONFIG: ActorConfig = {
  instanceId: "oc-test",
  baseUrl: "https://conditions.example.org",
  operator: "Test Operator",
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  license: "ODbL-1.0",
  trustTier: 0,
  capabilities: {
    protocolVersion: "0.1",
    convergenceBound: 300,
  },
};

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 3 } });
  sql = db.sql;
});

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("federation_instance_key", () => {
  it("has its columns", async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'federation_instance_key'`;
    expect(new Set(cols.map((c) => c.column_name))).toEqual(
      new Set([
        "key_id",
        "public_key",
        "private_key_ciphertext",
        "private_key_iv",
        "private_key_tag",
        "multibase",
        "not_before",
        "not_after",
        "created_at",
        "endorsed_by",
        "endorsement",
        "endorsement_proof",
      ]),
    );
  }, 30_000);
});

describe("instance key lifecycle", () => {
  let first: InstanceKey;
  let firstPkcs8: Uint8Array;
  let second: InstanceKey;

  it("creates exactly one key on first boot, unendorsed", async () => {
    const created = await maintainInstanceKey(sql, secrets, T_BOOTSTRAP, ME);
    expect(created).toMatchObject({ status: "created" });
    firstPkcs8 = new Uint8Array(
      await globalThis.crypto.subtle.exportKey(
        "pkcs8",
        (created as { key: InstanceKey }).key.privateKey,
      ),
    );
    expect(await maintainInstanceKey(sql, secrets, T_BOOTSTRAP, ME)).toMatchObject({
      status: "current",
    });
    const active = await loadActiveKeys(sql, secrets, T_BOOTSTRAP);
    expect(active).toHaveLength(1);
    first = active[0]!;
    expect(first.keyId).toMatch(/^z6Mk/);
    expect(first.endorsement).toBeUndefined();
    expect(first.notAfter.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  }, 30_000);

  it("stores the private key sealed: a dump of the table does not hold it", async () => {
    expect(firstPkcs8.length).toBeGreaterThan(32);
    expect(dumpHolds(await dumpTable(sql, "federation_instance_key"), firstPkcs8)).toBe(false);
    const [row] = await sql`
      SELECT octet_length(private_key_iv) AS iv, octet_length(private_key_tag) AS tag
      FROM conditions.federation_instance_key WHERE key_id = ${first.keyId}`;
    expect(row).toEqual({ iv: 12, tag: 16 });
  }, 30_000);

  it("a loaded key signs and verifies after the pkcs8 database round-trip", async () => {
    const message = new TextEncoder().encode("persisted key round-trip");
    const signature = await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      first.privateKey,
      message,
    );
    await expect(
      globalThis.crypto.subtle.verify({ name: "Ed25519" }, first.publicKey, signature, message),
    ).resolves.toBe(true);
  }, 30_000);

  it("refuses a key that cannot open the stored private keys, naming the key id", async () => {
    await expect(assertInstanceKeysOpen(sql, secrets)).resolves.toBeUndefined();
    const wrong = SecretsKey.parse("cd".repeat(32));
    await expect(assertInstanceKeysOpen(sql, wrong)).rejects.toThrow(
      `wrong key: OPENCONDITIONS_SECRETS_KEY cannot decrypt conditions.federation_instance_key.private_key of the row ${first.keyId}`,
    );
    await expect(loadActiveKeys(sql, wrong, T_BOOTSTRAP)).rejects.toThrow(/^wrong key: /);
  }, 30_000);

  it("keeps the key while more than the rotation lead is left", async () => {
    expect(await maintainInstanceKey(sql, secrets, T_QUIET, ME)).toEqual({
      status: "current",
      expiresAt: first.notAfter,
    });
  }, 30_000);

  it("rotates within the lead, to a key the old one endorses, keeping both valid", async () => {
    const kept = await maintainInstanceKey(sql, secrets, T_ROTATE, ME);
    expect(kept.status).toBe("rotated");
    second = (kept as { key: InstanceKey }).key;
    expect(second.notBefore.toISOString()).toBe(T_ROTATE);
    expect(second.notAfter.toISOString()).toBe("2026-12-05T00:00:00.000Z");
    expect(second.endorsement?.by).toBe(first.keyId);
    expect(await verifyEndorsement(ME, second.keyId, second.endorsement!)).toBe(true);
    expect(await verifyEndorsement(ME, first.keyId, second.endorsement!)).toBe(false);
    expect(await verifyEndorsement("other.example.org", second.keyId, second.endorsement!)).toBe(
      false,
    );

    const active = await loadActiveKeys(sql, secrets, T_ROTATE);
    expect(active.map((k) => k.keyId)).toEqual([second.keyId, first.keyId]);
    expect(active[0]!.endorsement).toEqual(second.endorsement);
    expect(active[1]!.notAfter.toISOString()).toBe("2026-07-05T00:00:00.000Z");
    expect(await maintainInstanceKey(sql, secrets, T_ROTATE, ME)).toMatchObject({
      status: "current",
    });
  }, 30_000);

  it("does not open a private key copied into another key's row", async () => {
    const rollBack = new Error("roll the copy back");
    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE conditions.federation_instance_key AS b SET
            private_key_ciphertext = a.private_key_ciphertext,
            private_key_iv = a.private_key_iv,
            private_key_tag = a.private_key_tag
          FROM conditions.federation_instance_key AS a
          WHERE a.key_id = ${first.keyId} AND b.key_id = ${second.keyId}`;
        await expect(loadActiveKeys(tx, secrets, T_ROTATE)).rejects.toThrow(
          `cannot decrypt conditions.federation_instance_key.private_key of the row ${second.keyId}`,
        );
        throw rollBack;
      }),
    ).rejects.toBe(rollBack);
    expect(await loadActiveKeys(sql, secrets, T_ROTATE)).toHaveLength(2);
  }, 30_000);

  it("signs with the old key until the new one has been served a week", async () => {
    expect(
      signingKeyOf(await loadActiveKeys(sql, secrets, T_UNPUBLISHED), T_UNPUBLISHED)?.keyId,
    ).toBe(first.keyId);
    expect(signingKeyOf(await loadActiveKeys(sql, secrets, T_PUBLISHED), T_PUBLISHED)?.keyId).toBe(
      second.keyId,
    );
  }, 30_000);

  it("serves both keys in the overlap, with the endorsement, and only the new one after", async () => {
    const versions = ["kernel@1.0"];
    const during = buildActorDocument(
      ACTOR_CONFIG,
      await loadActiveKeys(sql, secrets, T_PUBLISHED),
      versions,
    );
    expect(during.publicKey.map((k) => k.publicKeyMultibase)).toEqual([second.keyId, first.keyId]);
    expect(during.publicKey[0]!.endorsement).toEqual(second.endorsement);
    expect(during.publicKey[1]).not.toHaveProperty("endorsement");

    const after = buildActorDocument(
      ACTOR_CONFIG,
      await loadActiveKeys(sql, secrets, T_AFTER_OVERLAP),
      versions,
    );
    expect(after.publicKey.map((k) => k.publicKeyMultibase)).toEqual([second.keyId]);
  }, 30_000);

  it("never shortens an old key that already outlives the overlap window", async () => {
    await rotateInstanceKey(sql, secrets, "2026-07-27T00:00:00.000Z", ME);
    const rows = await sql<{ not_after: Date }[]>`
      SELECT not_after FROM conditions.federation_instance_key WHERE key_id = ${second.keyId}`;
    expect(rows[0]!.not_after.toISOString()).toBe("2026-12-05T00:00:00.000Z");
  }, 30_000);

  it("rotates once every key has expired, endorsed by the last one", async () => {
    const t = "2028-02-01T00:00:00.000Z";
    expect(await loadActiveKeys(sql, secrets, t)).toHaveLength(0);
    const [{ key_id: last }] = await sql<{ key_id: string }[]>`
      SELECT key_id FROM conditions.federation_instance_key ORDER BY not_before DESC LIMIT 1`;
    const kept = await maintainInstanceKey(sql, secrets, t, ME);
    expect(kept.status).toBe("rotated");
    const key = (kept as { key: InstanceKey }).key;
    expect(key.endorsement?.by).toBe(last);
    expect(await verifyEndorsement(ME, key.keyId, key.endorsement!)).toBe(true);
    expect(signingKeyOf(await loadActiveKeys(sql, secrets, t), t)?.keyId).toBe(key.keyId);
  }, 30_000);
});
