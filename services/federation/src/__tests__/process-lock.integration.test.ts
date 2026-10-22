import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEDERATION_LOCK, holdProcessLock } from "../process-lock.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 2 } });
});

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("the federation's single-process lock", () => {
  it("keeps a second process waiting until the first releases it", async () => {
    const lost: unknown[] = [];
    const first = await holdProcessLock(db.url, { onLost: (r) => lost.push(r) });
    let waits = 0;
    let secondHeld = false;
    const second = holdProcessLock(db.url, {
      retryMs: 20,
      onWait: () => waits++,
      onLost: (r) => lost.push(r),
    }).then((lock) => {
      secondHeld = true;
      return lock;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondHeld).toBe(false);
    expect(waits).toBeGreaterThan(0);

    await first.release();
    const lock = await second;
    expect(secondHeld).toBe(true);
    await lock.release();
    expect(lost).toEqual([]);
  }, 30_000);

  it("tells a process whose lock was taken from it", async () => {
    let lost: unknown;
    const lock = await holdProcessLock(db.url, { checkMs: 20, onLost: (r) => (lost = r) });
    await db.sql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name = 'openconditions-federation-lock' AND datname = current_database()`;
    await expect.poll(() => lost, { timeout: 5_000 }).toBeDefined();
    await lock.release();
    const [{ held }] = await db.sql<{ held: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${FEDERATION_LOCK})) AS held`;
    expect(held).toBe(true);
  }, 30_000);
});
