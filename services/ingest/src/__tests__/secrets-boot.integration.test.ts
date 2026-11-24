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
  await db.sql`TRUNCATE conditions.secrets_key_check, conditions.oauth_grant`;
});

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
});
