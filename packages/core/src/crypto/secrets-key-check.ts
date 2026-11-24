import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import {
  SECRETS_KEY_VARIABLE,
  type SecretPlace,
  type SecretsKey,
  WrongSecretsKeyError,
} from "./secrets.js";
import { storedSecret } from "./stored-secrets.js";

/** Where the check value is stored, which its sealing binds. */
const PLACE: SecretPlace = { table: "secrets_key_check", column: "value", row: "1" };

/** The fixed text the check row seals. */
const CHECK_TEXT = "openconditions secrets key check";

const DEFAULT_POLL_MS = 2_000;

/** This service's secrets key is not the one the ingest service sealed the check row with. */
export class SecretsKeyMismatchError extends Error {
  override name = "SecretsKeyMismatchError";
}

const mismatch = () =>
  new SecretsKeyMismatchError(
    `${SECRETS_KEY_VARIABLE} differs from the key the ingest service sealed in conditions.secrets_key_check: give this service the ingest service's key, never a newly generated one`,
  );

/**
 * Opens the check row with `key`: "match" when it opens to the check text,
 * "absent" before the ingest service wrote it. Throws a
 * {@link SecretsKeyMismatchError} when it does not open, naming no key.
 */
export async function verifySecretsKeyCheck(
  sql: postgres.Sql,
  key: SecretsKey,
): Promise<"match" | "absent"> {
  const [row] = await sql`
    SELECT value_ciphertext, value_iv, value_tag FROM conditions.secrets_key_check WHERE id = 1`;
  if (row === undefined) return "absent";
  const sealed = storedSecret(row, PLACE);
  if (sealed === null) throw mismatch();
  let text: string;
  try {
    text = key.openText(sealed, PLACE);
  } catch (error) {
    if (error instanceof WrongSecretsKeyError) throw mismatch();
    throw error;
  }
  if (text !== CHECK_TEXT) throw mismatch();
  return "match";
}

/**
 * The ingest service's step at start, after the migrations: seals the check
 * row with `key` unless a row is there already, then verifies the stored row.
 * Two processes starting together write one row; the one whose key differs
 * from the stored row's fails with a {@link SecretsKeyMismatchError}.
 */
export async function sealSecretsKeyCheck(sql: postgres.Sql, key: SecretsKey): Promise<void> {
  const sealed = key.seal(CHECK_TEXT, PLACE);
  await sql`
    INSERT INTO conditions.secrets_key_check (id, value_ciphertext, value_iv, value_tag)
    VALUES (1, ${Buffer.from(sealed.ciphertext)}, ${Buffer.from(sealed.iv)},
            ${Buffer.from(sealed.tag)})
    ON CONFLICT (id) DO NOTHING`;
  if ((await verifySecretsKeyCheck(sql, key)) !== "match") {
    throw new Error("conditions.secrets_key_check is empty after it was written");
  }
}

export interface WaitForSecretsKeyCheckOptions {
  /** How long to wait for the ingest service to write the row. */
  timeoutMs: number;
  pollMs?: number;
  /** Called once when the row is not there yet. */
  onWait?: () => void;
}

/**
 * The start of a service that does not migrate, after
 * `waitForSchemaVersion`: waits until the ingest service has sealed the
 * check row, then verifies `key` against it. Throws a
 * {@link SecretsKeyMismatchError} on another key, and a clear error when the
 * row does not appear within `timeoutMs`.
 */
export async function waitForSecretsKeyCheck(
  sql: postgres.Sql,
  key: SecretsKey,
  options: WaitForSecretsKeyCheckOptions,
): Promise<void> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + options.timeoutMs;
  let told = false;
  for (;;) {
    if ((await verifySecretsKeyCheck(sql, key)) === "match") return;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(
        `the ingest service did not seal conditions.secrets_key_check within ${options.timeoutMs} ms: ` +
          `start the ingest service with ${SECRETS_KEY_VARIABLE} first`,
      );
    }
    if (!told) {
      options.onWait?.();
      told = true;
    }
    await sleep(Math.min(pollMs, left));
  }
}
