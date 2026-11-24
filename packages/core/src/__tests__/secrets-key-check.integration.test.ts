import {
  createTestDatabase,
  TEST_SECRETS_KEY,
  type TestDatabase,
} from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecretsKey } from "../crypto/secrets.js";
import {
  SecretsKeyMismatchError,
  sealSecretsKeyCheck,
  verifySecretsKeyCheck,
  waitForSecretsKeyCheck,
} from "../crypto/secrets-key-check.js";

/**
 * The secrets key check: the ingest service seals one fixed row with its key,
 * and every other service refuses to start with a key that does not open it.
 */

const ingestKey = SecretsKey.parse(TEST_SECRETS_KEY);
const otherKey = SecretsKey.parse("9a".repeat(32));
const mismatch = /OPENCONDITIONS_SECRETS_KEY differs from the key the ingest service sealed/;

let db: TestDatabase;
let sql: postgres.Sql;
/** A second pool, as a second process holds. */
let other: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  other = postgres(db.url, { max: 2, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
  await other?.end();
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.secrets_key_check`;
});

describe("conditions.secrets_key_check", () => {
  it("is absent until the ingest service seals it, then opens with the ingest service's key", async () => {
    expect(await verifySecretsKeyCheck(sql, ingestKey)).toBe("absent");
    await sealSecretsKeyCheck(sql, ingestKey);
    expect(await verifySecretsKeyCheck(sql, ingestKey)).toBe("match");
    // A restart seals nothing new and still matches.
    await sealSecretsKeyCheck(sql, SecretsKey.parse(TEST_SECRETS_KEY));
    const rows = await sql`SELECT octet_length(value_iv) AS iv, octet_length(value_tag) AS tag
      FROM conditions.secrets_key_check`;
    expect(rows).toEqual([{ iv: 12, tag: 16 }]);
  });

  it("refuses another key, as another service or a restarted ingest service, naming no key", async () => {
    await sealSecretsKeyCheck(sql, ingestKey);
    let message = "";
    try {
      await verifySecretsKeyCheck(sql, otherKey);
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsKeyMismatchError);
      message = (error as Error).message;
    }
    expect(message).toMatch(mismatch);
    expect(message).not.toContain(TEST_SECRETS_KEY);
    await expect(sealSecretsKeyCheck(sql, otherKey)).rejects.toThrow(mismatch);
  });

  it("keeps one row when two processes start together, refusing the one with another key", async () => {
    const same = await Promise.allSettled([
      sealSecretsKeyCheck(sql, ingestKey),
      sealSecretsKeyCheck(other, ingestKey),
    ]);
    expect(same.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await sql`SELECT id FROM conditions.secrets_key_check`).toHaveLength(1);

    await sql`TRUNCATE conditions.secrets_key_check`;
    const differing = await Promise.allSettled([
      sealSecretsKeyCheck(sql, ingestKey),
      sealSecretsKeyCheck(other, otherKey),
    ]);
    expect(differing.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = differing.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(mismatch);
    expect(await sql`SELECT id FROM conditions.secrets_key_check`).toHaveLength(1);
  });

  it("is waited for by a service that starts before the ingest service sealed it", async () => {
    const waiting = waitForSecretsKeyCheck(other, ingestKey, { timeoutMs: 10_000, pollMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sealSecretsKeyCheck(sql, ingestKey);
    await expect(waiting).resolves.toBeUndefined();
    await expect(
      waitForSecretsKeyCheck(other, otherKey, { timeoutMs: 10_000, pollMs: 50 }),
    ).rejects.toThrow(mismatch);
  });

  it("stops waiting after the timeout, saying the ingest service has not sealed it", async () => {
    await expect(
      waitForSecretsKeyCheck(sql, ingestKey, { timeoutMs: 150, pollMs: 50 }),
    ).rejects.toThrow(
      /the ingest service did not seal conditions\.secrets_key_check within 150 ms/,
    );
  });

  it("holds one row only", async () => {
    await sealSecretsKeyCheck(sql, ingestKey);
    await expect(
      sql`INSERT INTO conditions.secrets_key_check (id, value_ciphertext, value_iv, value_tag)
          SELECT 2, value_ciphertext, value_iv, value_tag FROM conditions.secrets_key_check`,
    ).rejects.toThrow(/secrets_key_check_id_check/);
  });
});
