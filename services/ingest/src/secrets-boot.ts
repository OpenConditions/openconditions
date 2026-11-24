import {
  assertStoredSecretsOpen,
  type CredentialEnv,
  INSTANCE_KEY_SECRETS,
  ISSUER_KEY_SECRETS,
  type SecretsKey,
  sealSecretsKeyCheck,
  secretsKeyFromEnv,
} from "@openconditions/core/server";
import type postgres from "postgres";
import { assertGrantsOpen } from "./oauth-grants.js";

/**
 * The secrets key, read before the migrations so a missing or malformed key
 * stops the start before anything touches the database.
 */
export function readIngestSecretsKey(env: CredentialEnv): SecretsKey {
  return secretsKeyFromEnv(env);
}

/**
 * After the migrations: opens every stored OAuth2 grant, issuer key and
 * federation instance key, then seals the secrets key check row the other
 * services verify their key against (once; a row already there must open
 * with this key). A key that is not the one in use stops the start, naming
 * what it could not open; the stored secrets come first, so such a key never
 * seals the check row, even when the row was deleted by hand.
 */
export async function checkIngestSecrets(sql: postgres.Sql, key: SecretsKey): Promise<void> {
  await assertGrantsOpen(sql, key);
  await assertStoredSecretsOpen(sql, key, ISSUER_KEY_SECRETS);
  await assertStoredSecretsOpen(sql, key, INSTANCE_KEY_SECRETS);
  await sealSecretsKeyCheck(sql, key);
}
