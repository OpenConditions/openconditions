import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { settleQueue } from "../pipeline/bind-records.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * Settling the binding queue while another writer holds one of its rows. The
 * rows are stored in reverse key order, so a statement locking them as it
 * finds them may lock them in either order; settled in key order, two
 * writers settling overlapping records never wait on each other in a cycle.
 */
let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;

beforeAll(async () => {
  db = await createRestrictionDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const queued = (ids: readonly string[]) =>
  db.sql`
    INSERT INTO conditions.binding_queue
      (record_class, record_id, effect_id, record_revision, attempts, next_attempt_at, updated_at)
    SELECT 'situation', id, '', 1, 0, now(), now() FROM unnest(${ids as string[]}::text[]) AS id`;

describe("settling the binding queue", () => {
  test("locks the queued rows in key order", async () => {
    await queued(["oc:situation:q:c", "oc:situation:q:b", "oc:situation:q:a"]);
    const holder = postgres(db.url, { max: 1, onnotice: () => {} });
    // A plan that finds the rows as stored, as a settle of other records may.
    const settler = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      connection: { enable_indexscan: "off", enable_bitmapscan: "off" },
    });
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const hold = holder.begin(async (tx) => {
        await tx`SELECT 1 FROM conditions.binding_queue
                  WHERE record_id = 'oc:situation:q:b' FOR UPDATE`;
        held();
        await released;
      });
      await holding;
      const [{ pid }] = await settler<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const settled = settleQueue(
        settler,
        ["oc:situation:q:c", "oc:situation:q:b", "oc:situation:q:a"],
        new Set(),
        new Set(),
      );
      // The settle waits on the held row, having locked what comes before it.
      await vi.waitFor(
        async () => {
          const [waiting] = await db.sql`
            SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`;
          expect(waiting).toBeDefined();
        },
        { timeout: 10_000 },
      );
      const free = await db.sql<{ record_id: string }[]>`
        SELECT record_id FROM conditions.binding_queue
         WHERE record_id LIKE 'oc:situation:q:%' ORDER BY record_id FOR UPDATE SKIP LOCKED`;
      expect(free.map((r) => r.record_id)).toEqual(["oc:situation:q:c"]);
      release();
      await hold;
      await settled;
      const left = await db.sql`
        SELECT record_id FROM conditions.binding_queue WHERE record_id LIKE 'oc:situation:q:%'`;
      expect(left).toEqual([]);
    } finally {
      await holder.end();
      await settler.end();
    }
  }, 60_000);
});
