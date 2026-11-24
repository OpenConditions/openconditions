import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InstanceIdMismatchError,
  sealInstanceId,
  verifyInstanceId,
  waitForInstanceId,
} from "../instance-identity.js";

/**
 * The sealed instance id: the first ingest process writes it once, and every
 * service refuses to start with another id.
 */

const mismatch =
  /OPENCONDITIONS_INSTANCE_ID "other\.example\.org" differs from "maps\.example\.org"/;

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
  await sql`TRUNCATE conditions.instance_identity`;
});

describe("conditions.instance_identity", () => {
  it("is absent until the ingest service seals it, then matches the same id", async () => {
    expect(await verifyInstanceId(sql, "maps.example.org")).toBe("absent");
    await sealInstanceId(sql, "maps.example.org");
    expect(await verifyInstanceId(sql, "maps.example.org")).toBe("match");
    // A restart seals nothing new and still matches.
    await sealInstanceId(sql, "maps.example.org");
    expect(await sql`SELECT instance_id FROM conditions.instance_identity`).toEqual([
      { instance_id: "maps.example.org" },
    ]);
  });

  it("refuses another id, naming both and the one to set", async () => {
    await sealInstanceId(sql, "maps.example.org");
    await expect(verifyInstanceId(sql, "other.example.org")).rejects.toBeInstanceOf(
      InstanceIdMismatchError,
    );
    await expect(verifyInstanceId(sql, "other.example.org")).rejects.toThrow(mismatch);
    await expect(sealInstanceId(sql, "other.example.org")).rejects.toThrow(mismatch);
  });

  it("keeps one row when two processes start together, refusing the one with another id", async () => {
    const differing = await Promise.allSettled([
      sealInstanceId(sql, "maps.example.org"),
      sealInstanceId(other, "other.example.org"),
    ]);
    expect(differing.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(differing.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await sql`SELECT id FROM conditions.instance_identity`).toHaveLength(1);
  });

  it("is waited for by a service that starts before the ingest service sealed it", async () => {
    const waiting = waitForInstanceId(other, "maps.example.org", { timeoutMs: 10_000, pollMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sealInstanceId(sql, "maps.example.org");
    await expect(waiting).resolves.toBeUndefined();
    await expect(
      waitForInstanceId(other, "other.example.org", { timeoutMs: 10_000, pollMs: 50 }),
    ).rejects.toThrow(mismatch);
  });

  it("stops waiting after the timeout, saying the ingest service has not sealed it", async () => {
    await expect(
      waitForInstanceId(sql, "maps.example.org", { timeoutMs: 150, pollMs: 50 }),
    ).rejects.toThrow(
      /the ingest service did not seal conditions\.instance_identity within 150 ms/,
    );
  });

  it("holds one row only, and only a DNS-name id", async () => {
    await sealInstanceId(sql, "maps.example.org");
    await expect(
      sql`INSERT INTO conditions.instance_identity (id, instance_id) VALUES (2, 'b.example.org')`,
    ).rejects.toThrow(/instance_identity_id_check/);
    await sql`TRUNCATE conditions.instance_identity`;
    for (const bad of ["local:x", "Maps.example.org", "a..b", "-a", `${"a".repeat(64)}.org`]) {
      await expect(
        sql`INSERT INTO conditions.instance_identity (instance_id) VALUES (${bad})`,
        bad,
      ).rejects.toThrow(/instance_identity_instance_id_check/);
    }
  });
});
