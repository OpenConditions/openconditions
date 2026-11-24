import {
  type CredentialEnv,
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
 * After the migrations: opens every stored OAuth2 grant, then seals the
 * secrets key check row the other services verify their key against (once;
 * a row already there must open with this key). A key that is not the one
 * in use stops the start, naming what it could not open; the grants come
 * first, so such a key never seals the check row.
 */
export async function checkIngestSecrets(sql: postgres.Sql, key: SecretsKey): Promise<void> {
  await assertGrantsOpen(sql, key);
  await sealSecretsKeyCheck(sql, key);
}
