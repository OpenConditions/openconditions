import {
  assertStoredSecretsOpen,
  type SecretPlace,
  type SecretsKey,
  type SecretTable,
  storedSecret,
} from "@openconditions/core/server";
import {
  type OAuthGrantStore,
  OAuthGrants,
  type StoredGrant,
} from "@openconditions/ingest-framework";
import type postgres from "postgres";

/** How the operator logs a grant in, as a failing poll tells them. */
export function grantLoginHint(key: string): string {
  return `log in with "node dist/feed-auth.js login ${key}" in the ingest container (see feeds/credentials.jsonc)`;
}

/** The grants' table and the secrets it stores sealed. */
export const OAUTH_GRANT_SECRETS: SecretTable = {
  table: "oauth_grant",
  rowKey: "grant_key",
  columns: ["refresh_token", "access_token"],
};

const place = (column: string, key: string): SecretPlace => ({
  table: OAUTH_GRANT_SECRETS.table,
  column,
  row: key,
});

const epoch = (value: unknown): number | null =>
  value === null || value === undefined ? null : new Date(value as string | Date).getTime();

function storedGrant(row: postgres.Row, secrets: SecretsKey): StoredGrant {
  const key = row["grant_key"] as string;
  const refresh = storedSecret(row, place("refresh_token", key));
  if (refresh === null) throw new Error(`conditions.oauth_grant ${key} has no refresh token`);
  const access = storedSecret(row, place("access_token", key));
  return {
    refreshToken: secrets.openText(refresh, place("refresh_token", key)),
    refreshIssuedAt: epoch(row["refresh_issued_at"]) as number,
    accessToken: access === null ? null : secrets.openText(access, place("access_token", key)),
    accessExpiresAt: epoch(row["access_expires_at"]),
    rejectedAt: epoch(row["rejected_at"]),
    lastError: (row["last_error"] as string | null) ?? null,
    lastErrorAt: epoch(row["last_error_at"]),
    updatedAt: epoch(row["updated_at"]) as number,
  };
}

const instant = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/**
 * The grants in `conditions.oauth_grant`, their tokens sealed with
 * `secrets`. `locked` holds the grant's row (`SELECT … FOR UPDATE`) in a
 * transaction for the whole of `fn`, so two ingest processes never spend one
 * refresh token, and commits what `fn` wrote before it resolves.
 */
export function pgOAuthGrantStore(sql: postgres.Sql, secrets: SecretsKey): OAuthGrantStore {
  return {
    async read(key) {
      const [row] = await sql`SELECT * FROM conditions.oauth_grant WHERE grant_key = ${key}`;
      return row ? storedGrant(row, secrets) : undefined;
    },
    async locked(key, fn) {
      return (await sql.begin(async (tx) => {
        const [row] = await tx`
          SELECT * FROM conditions.oauth_grant WHERE grant_key = ${key} FOR UPDATE`;
        const write = async (next: StoredGrant) => {
          const refresh = secrets.seal(next.refreshToken, place("refresh_token", key));
          const access =
            next.accessToken === null
              ? null
              : secrets.seal(next.accessToken, place("access_token", key));
          const bytes = (value: Uint8Array | undefined) =>
            value === undefined ? null : Buffer.from(value);
          await tx`
            INSERT INTO conditions.oauth_grant (
              grant_key, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
              refresh_issued_at, access_token_ciphertext, access_token_iv, access_token_tag,
              access_expires_at, rejected_at, last_error, last_error_at, updated_at
            ) VALUES (
              ${key}, ${Buffer.from(refresh.ciphertext)}, ${Buffer.from(refresh.iv)},
              ${Buffer.from(refresh.tag)}, ${new Date(next.refreshIssuedAt)},
              ${bytes(access?.ciphertext)}, ${bytes(access?.iv)}, ${bytes(access?.tag)},
              ${instant(next.accessExpiresAt)}, ${instant(next.rejectedAt)},
              ${next.lastError}, ${instant(next.lastErrorAt)}, ${new Date(next.updatedAt)}
            )
            ON CONFLICT (grant_key) DO UPDATE SET
              refresh_token_ciphertext = excluded.refresh_token_ciphertext,
              refresh_token_iv = excluded.refresh_token_iv,
              refresh_token_tag = excluded.refresh_token_tag,
              refresh_issued_at = excluded.refresh_issued_at,
              access_token_ciphertext = excluded.access_token_ciphertext,
              access_token_iv = excluded.access_token_iv,
              access_token_tag = excluded.access_token_tag,
              access_expires_at = excluded.access_expires_at,
              rejected_at = excluded.rejected_at,
              last_error = excluded.last_error,
              last_error_at = excluded.last_error_at,
              updated_at = excluded.updated_at`;
        };
        return fn(row ? storedGrant(row, secrets) : undefined, write);
      })) as Awaited<ReturnType<typeof fn>>;
    },
  };
}

/** The process's grants, kept in the database `sql` reaches. */
export function createOAuthGrants(
  sql: postgres.Sql,
  secrets: SecretsKey,
  now: () => number = Date.now,
): OAuthGrants {
  return new OAuthGrants(pgOAuthGrantStore(sql, secrets), { now, loginHint: grantLoginHint });
}

/**
 * Opens every stored grant's tokens under `secrets`, so a key that is not
 * the one they were sealed with stops the start with a "wrong key" error
 * naming the grant.
 */
export function assertGrantsOpen(sql: postgres.Sql, secrets: SecretsKey): Promise<void> {
  return assertStoredSecretsOpen(sql, secrets, OAUTH_GRANT_SECRETS);
}
