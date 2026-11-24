import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { INSTANCE_ID_VARIABLE } from "./instance.js";

const DEFAULT_POLL_MS = 2_000;

/** This service's instance id is not the one the ingest service sealed. */
export class InstanceIdMismatchError extends Error {
  override name = "InstanceIdMismatchError";
}

const mismatch = (configured: string, sealed: string) =>
  new InstanceIdMismatchError(
    `${INSTANCE_ID_VARIABLE} "${configured}" differs from "${sealed}", the instance id sealed in conditions.instance_identity: every record id of this instance carries the sealed one, so set ${INSTANCE_ID_VARIABLE} to "${sealed}" on this service`,
  );

/**
 * Compares `instanceId` with the sealed row: "match" when they are equal,
 * "absent" before the ingest service wrote it. Throws an
 * {@link InstanceIdMismatchError} when they differ.
 */
export async function verifyInstanceId(
  sql: postgres.Sql,
  instanceId: string,
): Promise<"match" | "absent"> {
  const [row] = await sql<{ instance_id: string }[]>`
    SELECT instance_id FROM conditions.instance_identity WHERE id = 1`;
  if (row === undefined) return "absent";
  if (row.instance_id !== instanceId) throw mismatch(instanceId, row.instance_id);
  return "match";
}

/**
 * The ingest service's step at start, after the migrations: seals
 * `instanceId` unless a row is there already, then verifies the stored row.
 * Two processes starting together write one row; the one whose id differs
 * fails with an {@link InstanceIdMismatchError}.
 */
export async function sealInstanceId(sql: postgres.Sql, instanceId: string): Promise<void> {
  await sql`
    INSERT INTO conditions.instance_identity (id, instance_id) VALUES (1, ${instanceId})
    ON CONFLICT (id) DO NOTHING`;
  if ((await verifyInstanceId(sql, instanceId)) !== "match") {
    throw new Error("conditions.instance_identity is empty after it was written");
  }
}

export interface WaitForInstanceIdOptions {
  /** How long to wait for the ingest service to write the row. */
  timeoutMs: number;
  pollMs?: number;
  /** Called once when the row is not there yet. */
  onWait?: () => void;
}

/**
 * The start of a service that does not migrate, after
 * `waitForSchemaVersion`: waits until the ingest service has sealed the
 * instance id, then compares `instanceId` with it. Throws an
 * {@link InstanceIdMismatchError} on another id, and a clear error when the
 * row does not appear within `timeoutMs`.
 */
export async function waitForInstanceId(
  sql: postgres.Sql,
  instanceId: string,
  options: WaitForInstanceIdOptions,
): Promise<void> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + options.timeoutMs;
  let told = false;
  for (;;) {
    if ((await verifyInstanceId(sql, instanceId)) === "match") return;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(
        `the ingest service did not seal conditions.instance_identity within ${options.timeoutMs} ms: ` +
          `start the ingest service with ${INSTANCE_ID_VARIABLE} first`,
      );
    }
    if (!told) {
      options.onWait?.();
      told = true;
    }
    await sleep(Math.min(pollMs, left));
  }
}
