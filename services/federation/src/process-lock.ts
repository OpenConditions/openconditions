/**
 * One federation process per database. What its timers keep in memory is one
 * process's to keep: the replay cache of peers' signatures, the per-peer rate
 * limits, the single flight of the pull, the push and the peer upkeep. A
 * second process (a second replica, or a new container started before the
 * old one stopped) waits for the session advisory lock until the first ends.
 * The lock's connection is checked while held; a process that lost it is
 * told, and must stop, so two never run at once.
 */
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";

/** The advisory lock's name; its key is `hashtext` of it. */
export const FEDERATION_LOCK = "openconditions-federation";

export interface ProcessLock {
  release(): Promise<void>;
}

export interface ProcessLockOptions {
  /** How long to wait between attempts while another process holds the lock. */
  retryMs?: number;
  /** How often the held lock is checked. */
  checkMs?: number;
  /** Called on each attempt another process held the lock. */
  onWait?: () => void;
  /** Called once when the held lock is gone. */
  onLost: (reason: unknown) => void;
}

/** Waits for the federation's lock on a connection of its own, and holds it. */
export async function holdProcessLock(url: string, opts: ProcessLockOptions): Promise<ProcessLock> {
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: "openconditions-federation-lock" },
  });
  const conn = await sql.reserve();
  try {
    for (;;) {
      const [row] = await conn<{ held: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${FEDERATION_LOCK})) AS held`;
      if (row?.held === true) break;
      opts.onWait?.();
      await sleep(opts.retryMs ?? 5_000);
    }
  } catch (err) {
    conn.release();
    await sql.end({ timeout: 5 });
    throw err;
  }

  let lost = false;
  const check = setInterval(() => {
    void (async () => {
      try {
        const [row] = await conn<{ held: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted) AS held`;
        if (row?.held === true) return;
        throw new Error("the federation lock is no longer held");
      } catch (err) {
        if (lost) return;
        lost = true;
        clearInterval(check);
        opts.onLost(err);
      }
    })();
  }, opts.checkMs ?? 30_000);
  check.unref();

  return {
    async release() {
      clearInterval(check);
      lost = true;
      try {
        await conn`SELECT pg_advisory_unlock(hashtext(${FEDERATION_LOCK}))`;
      } catch {
        // The session ending releases it too.
      }
      conn.release();
      await sql.end({ timeout: 5 });
    },
  };
}
