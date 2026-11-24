import { SecretsKey } from "@openconditions/core/server";
import {
  createTestDatabase,
  TEST_SECRETS_KEY,
  type TestDatabase,
} from "@openconditions/test-database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgOAuthGrantStore } from "../oauth-grants.js";
import { checkIngestSecrets, readIngestSecretsKey } from "../secrets-boot.js";

/**
 * The ingest service's start: the key is read before the migrations, and
 * after them the key check is sealed and every stored grant opened.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await db.sql`TRUNCATE conditions.secrets_key_check, conditions.oauth_grant,
    conditions.issuer_key, conditions.federation_instance_key`;
});

/** Stores a private key sealed with `key` in `table`, as its service does. */
async function storePrivateKey(
  table: "issuer_key" | "federation_instance_key",
  key: SecretsKey,
): Promise<void> {
  const sealed = key.seal("private key", { table, column: "private_key", row: "k1" });
  const row = {
    key_id: "k1",
    public_key: Buffer.from("public key"),
    private_key_ciphertext: Buffer.from(sealed.ciphertext),
    private_key_iv: Buffer.from(sealed.iv),
    private_key_tag: Buffer.from(sealed.tag),
    not_before: new Date(),
    not_after: new Date(Date.now() + 86_400_000),
    ...(table === "federation_instance_key" ? { multibase: "z", created_at: new Date() } : {}),
  };
  await db.sql`INSERT INTO ${db.sql(`conditions.${table}`)} ${db.sql(row)}`;
}

describe("the ingest service's start", () => {
  it("refuses a missing or malformed key before touching the database", () => {
    expect(() => readIngestSecretsKey({})).toThrow(
      /OPENCONDITIONS_SECRETS_KEY is required: set OPENCONDITIONS_SECRETS_KEY_FILE/,
    );
    expect(() => readIngestSecretsKey({ OPENCONDITIONS_SECRETS_KEY: "short" })).toThrow(
      /must be 64 hexadecimal characters/,
    );
  });

  it("starts with its key, sealing the key check once", async () => {
    const key = readIngestSecretsKey({ OPENCONDITIONS_SECRETS_KEY: TEST_SECRETS_KEY });
    await checkIngestSecrets(db.sql, key);
    await checkIngestSecrets(db.sql, key);
    expect(await db.sql`SELECT id FROM conditions.secrets_key_check`).toEqual([{ id: 1 }]);
  });

  it("refuses a key other than the one the key check was sealed with", async () => {
    await checkIngestSecrets(db.sql, SecretsKey.parse(TEST_SECRETS_KEY));
    await expect(checkIngestSecrets(db.sql, SecretsKey.parse("c3".repeat(32)))).rejects.toThrow(
      /OPENCONDITIONS_SECRETS_KEY differs from the key the ingest service sealed/,
    );
  });

  it("refuses a key that cannot open a stored grant, naming the grant", async () => {
    const key = SecretsKey.parse(TEST_SECRETS_KEY);
    await pgOAuthGrantStore(db.sql, key).locked("eumetsat", (_stored, write) =>
      write({
        refreshToken: "refresh-1",
        refreshIssuedAt: Date.now(),
        accessToken: null,
        accessExpiresAt: null,
        rejectedAt: null,
        lastError: null,
        lastErrorAt: null,
        updatedAt: Date.now(),
      }),
    );
    // No key check yet: the grant refuses the key, which seals no check row.
    await expect(checkIngestSecrets(db.sql, SecretsKey.parse("c3".repeat(32)))).rejects.toThrow(
      /^wrong key: .*conditions\.oauth_grant\.refresh_token of the row eumetsat/,
    );
    expect(await db.sql`SELECT id FROM conditions.secrets_key_check`).toEqual([]);
    await expect(checkIngestSecrets(db.sql, key)).resolves.toBeUndefined();
  });

  it.each(["issuer_key", "federation_instance_key"] as const)(
    "refuses a key that cannot open a stored %s, sealing no check row",
    async (table) => {
      const key = SecretsKey.parse(TEST_SECRETS_KEY);
      await storePrivateKey(table, key);
      // The check row is gone, as after a hand delete: the stored key still refuses another key.
      await expect(checkIngestSecrets(db.sql, SecretsKey.parse("c3".repeat(32)))).rejects.toThrow(
        new RegExp(`^wrong key: .*conditions\\.${table}\\.private_key of the row k1`),
      );
      expect(await db.sql`SELECT id FROM conditions.secrets_key_check`).toEqual([]);
      await expect(checkIngestSecrets(db.sql, key)).resolves.toBeUndefined();
    },
  );
});
