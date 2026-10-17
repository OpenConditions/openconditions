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

const epoch = (value: unknown): number | null =>
  value === null || value === undefined ? null : new Date(value as string | Date).getTime();

function storedGrant(row: postgres.Row): StoredGrant {
  return {
    refreshToken: row["refresh_token"] as string,
    refreshIssuedAt: epoch(row["refresh_issued_at"]) as number,
    accessToken: (row["access_token"] as string | null) ?? null,
    accessExpiresAt: epoch(row["access_expires_at"]),
    rejectedAt: epoch(row["rejected_at"]),
    lastError: (row["last_error"] as string | null) ?? null,
    lastErrorAt: epoch(row["last_error_at"]),
    updatedAt: epoch(row["updated_at"]) as number,
  };
}

const instant = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/**
 * The grants in `conditions.oauth_grant`. `locked` holds the grant's row
 * (`SELECT … FOR UPDATE`) in a transaction for the whole of `fn`, so two
 * ingest processes never spend one refresh token, and commits what `fn`
 * wrote before it resolves.
 */
export function pgOAuthGrantStore(sql: postgres.Sql): OAuthGrantStore {
  return {
    async read(key) {
      const [row] = await sql`SELECT * FROM conditions.oauth_grant WHERE grant_key = ${key}`;
      return row ? storedGrant(row) : undefined;
    },
    async locked(key, fn) {
      return (await sql.begin(async (tx) => {
        const [row] = await tx`
          SELECT * FROM conditions.oauth_grant WHERE grant_key = ${key} FOR UPDATE`;
        const write = async (next: StoredGrant) => {
          await tx`
            INSERT INTO conditions.oauth_grant (
              grant_key, refresh_token, refresh_issued_at, access_token, access_expires_at,
              rejected_at, last_error, last_error_at, updated_at
            ) VALUES (
              ${key}, ${next.refreshToken}, ${new Date(next.refreshIssuedAt)},
              ${next.accessToken}, ${instant(next.accessExpiresAt)}, ${instant(next.rejectedAt)},
              ${next.lastError}, ${instant(next.lastErrorAt)}, ${new Date(next.updatedAt)}
            )
            ON CONFLICT (grant_key) DO UPDATE SET
              refresh_token = excluded.refresh_token,
              refresh_issued_at = excluded.refresh_issued_at,
              access_token = excluded.access_token,
              access_expires_at = excluded.access_expires_at,
              rejected_at = excluded.rejected_at,
              last_error = excluded.last_error,
              last_error_at = excluded.last_error_at,
              updated_at = excluded.updated_at`;
        };
        return fn(row ? storedGrant(row) : undefined, write);
      })) as Awaited<ReturnType<typeof fn>>;
    },
  };
}

/** The process's grants, kept in the database `sql` reaches. */
export function createOAuthGrants(sql: postgres.Sql, now: () => number = Date.now): OAuthGrants {
  return new OAuthGrants(pgOAuthGrantStore(sql), { now, loginHint: grantLoginHint });
}
