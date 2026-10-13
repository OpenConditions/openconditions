import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase } from "./database.integration.js";
import {
  captureDatabaseStart,
  cleanupProfileDatabase,
  type OwnedDatabase,
} from "./database-profile-audit.integration.js";

const owned: OwnedDatabase[] = [];
let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;

beforeAll(async () => {
  const restore = captureDatabaseStart(owned);
  try {
    db = await createTestDatabase();
  } finally {
    restore();
  }
}, 180_000);

afterAll(async () => {
  await cleanupProfileDatabase(db, owned);
}, 30_000);

it("runs the selected physical major in an actually migrated database", async () => {
  expect(owned).toHaveLength(1);
  expect(db).toBeDefined();
  if (!db) throw new Error("Disposable profile database was not created");
  const [{ server_version_num }] = await db.sql`SHOW server_version_num`;
  const profile = process.env["OC_TEST_POSTGIS_PROFILE"] ?? "pg16";
  expect(Math.floor(Number(server_version_num) / 10000)).toBe(profile === "pg18" ? 18 : 16);
  const [schema] = await db.sql`SELECT to_regclass('conditions.feature') AS feature`;
  expect(schema?.["feature"]).toBe("conditions.feature");
  console.info("DATABASE_PROFILE_VERIFIED", JSON.stringify({ profile, server_version_num }));
});
