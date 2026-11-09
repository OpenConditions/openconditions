import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const punCoordinationDirectory = () =>
  process.env["PUN_COORDINATION_DIR"] ||
  join(
    process.env["OPENCONDITIONS_STATE_DIR"] || join(homedir(), ".cache/openconditions"),
    "cruscotto-italia-client",
  );

/** A crashed lease fails closed: operators inspect and remove it, never age it out. */
export async function withPunCoordination<T>(
  directory: string,
  work: (budget: {
    next: number;
    reserveUntil: (timestamp: number) => Promise<void>;
  }) => Promise<T>,
  options: { deadline?: number; signal?: AbortSignal | null } = {},
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lease = join(directory, "lease");
  const deadline = options.deadline ?? Date.now() + 4 * 60 * 60 * 1000;
  for (;;) {
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw Error("PUN coordination lease deadline exceeded");
    try {
      await mkdir(lease);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, {
        signal: options.signal ?? undefined,
      });
    }
  }
  let release = true;
  try {
    await writeFile(
      join(lease, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const path = join(directory, "budget.json");
    let next = 0;
    try {
      const stored: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof stored !== "object" ||
        stored === null ||
        !("next" in stored) ||
        typeof stored.next !== "number" ||
        !Number.isFinite(stored.next) ||
        stored.next < 0
      )
        throw Error("PUN invalid persisted cooldown");
      next = stored.next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (next >= deadline) throw Error("PUN persisted cooldown exceeds acquisition deadline");
    return await work({
      next,
      reserveUntil: async (timestamp) => {
        next = Math.max(next, timestamp);
        try {
          await writeFile(`${path}.tmp`, JSON.stringify({ next }));
          await rename(`${path}.tmp`, path);
        } catch (error) {
          release = false;
          throw error;
        }
      },
    });
  } finally {
    if (release) {
      await rm(join(lease, "owner.json"), { force: true });
      await rmdir(lease);
    }
  }
}
