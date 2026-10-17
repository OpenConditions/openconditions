import { createHash, randomBytes } from "node:crypto";
import type { CatalogFeed } from "./catalog/types.js";

/** The auth of a feed that reads an account's OAuth2 grant. */
export type AuthorizationCodeAuth = Extract<
  NonNullable<CatalogFeed["auth"]>,
  { kind: "oauth2-authorization-code" }
>;

/** A grant as the store keeps it; instants are epoch ms. */
export interface StoredGrant {
  refreshToken: string;
  /** When the provider issued the refresh token, which it honours `refreshTokenTtlSec` from then. */
  refreshIssuedAt: number;
  accessToken: string | null;
  accessExpiresAt: number | null;
  /** When the provider refused the refresh token: only a new login revives the grant. */
  rejectedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  updatedAt: number;
}

/**
 * Where grants are kept. `locked` runs `fn` holding the grant's lock, so no
 * other holder (in this process or another) reads or refreshes it meanwhile,
 * and makes what `fn` wrote durable before it resolves: a refresh token the
 * provider rotated is stored before the access token it came with is used.
 */
export interface OAuthGrantStore {
  read(key: string): Promise<StoredGrant | undefined>;
  locked<T>(
    key: string,
    fn: (grant: StoredGrant | undefined, write: (next: StoredGrant) => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

/** What a grant's feeds need of it: how it is obtained, its client and where its requests go. */
export interface GrantRequest {
  key: string;
  auth: AuthorizationCodeAuth;
  clientId: string;
  fetch: typeof fetch;
}

/** An access token is renewed this long before it expires, so none expires mid-poll. */
const ACCESS_MARGIN_MS = 5 * 60_000;

/** Without `expires_in`, an access token is taken to last an hour. */
const DEFAULT_ACCESS_SEC = 3600;

/** The longest provider error code a stored or thrown message repeats. */
const MAX_ERROR_CODE = 64;

interface TokenAnswer {
  accessToken: string;
  expiresInSec: number;
  refreshToken?: string;
}

type TokenOutcome = { ok: TokenAnswer } | { rejected: string } | { failed: string };

/** The provider's OAuth error code, when its body is an OAuth error; never more of the body. */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && /^[A-Za-z0-9_.-]+$/.test(body.error)
      ? body.error.slice(0, MAX_ERROR_CODE)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One token-endpoint request. A 400 or 401 answer refuses the grant (an
 * expired or revoked refresh token, a spent code): asking again cannot help.
 * Any other failure may pass.
 */
async function tokenRequest(
  grant: GrantRequest,
  params: Record<string, string>,
): Promise<TokenOutcome> {
  let res: Response;
  try {
    res = await grant.fetch(grant.auth.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ ...params, client_id: grant.clientId }),
    });
  } catch (err) {
    return { failed: `token request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const code = await errorCode(res);
    const reason = `HTTP ${res.status}${code ? ` ${code}` : ""}`;
    return res.status === 400 || res.status === 401
      ? { rejected: reason }
      : { failed: `token request failed: ${reason}` };
  }
  let body: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { failed: "token response is not JSON" };
  }
  if (typeof body.access_token !== "string" || body.access_token === "") {
    return { failed: "token response has no access_token" };
  }
  const expires = Number(body.expires_in);
  return {
    ok: {
      accessToken: body.access_token,
      expiresInSec: Number.isFinite(expires) && expires > 0 ? expires : DEFAULT_ACCESS_SEC,
      ...(typeof body.refresh_token === "string" && body.refresh_token !== ""
        ? { refreshToken: body.refresh_token }
        : {}),
    },
  };
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** A random `state` for one authorization request. */
export function oauthState(): string {
  return randomBytes(16).toString("base64url");
}

/** The URL the operator opens to log in and obtain an authorization code. */
export function authorizationUrl(
  auth: AuthorizationCodeAuth,
  clientId: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(auth.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", auth.redirectUri);
  if (auth.scope) url.searchParams.set("scope", auth.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (auth.responseMode) url.searchParams.set("response_mode", auth.responseMode);
  return url.toString();
}

/**
 * The code and state in what the operator pasted: the code alone, or the
 * redirect URL (its query or fragment) the provider sent the browser to.
 */
export function pastedAuthorization(text: string): { code: string; state?: string } | undefined {
  const pasted = text.trim();
  if (pasted === "") return undefined;
  if (!pasted.includes("code="))
    return /^[\x21-\x7e]+$/.test(pasted) ? { code: pasted } : undefined;
  const params = new URLSearchParams(pasted.replace(/^[^?#]*[?#]/, ""));
  const code = params.get("code");
  const state = params.get("state");
  return code ? { code, ...(state ? { state } : {}) } : undefined;
}

/** Whether a stored grant must be refreshed before its access token is used. */
function needsRefresh(grant: StoredGrant, auth: AuthorizationCodeAuth, now: number): boolean {
  if (grant.accessToken === null || grant.accessExpiresAt === null) return true;
  if (grant.accessExpiresAt - ACCESS_MARGIN_MS <= now) return true;
  // Renewed at half its life however long the access token lasts, so a
  // refresh token never lapses while its feeds poll.
  const ttlMs = (auth.refreshTokenTtlSec ?? 0) * 1000;
  return ttlMs > 0 && now - grant.refreshIssuedAt >= ttlMs / 2;
}

/** The grant as a token answer leaves it; a provider that does not rotate keeps the refresh token. */
function granted(answer: TokenAnswer, prior: StoredGrant | undefined, now: number): StoredGrant {
  const refreshToken = answer.refreshToken ?? prior?.refreshToken;
  if (refreshToken === undefined) throw new Error("token response has no refresh_token");
  return {
    refreshToken,
    refreshIssuedAt: answer.refreshToken !== undefined ? now : (prior?.refreshIssuedAt ?? now),
    accessToken: answer.accessToken,
    accessExpiresAt: now + answer.expiresInSec * 1000,
    rejectedAt: null,
    lastError: null,
    lastErrorAt: null,
    updatedAt: now,
  };
}

/**
 * The OAuth2 grants of one process: hands out each grant's access token,
 * refreshing it under the store's lock when it is about to expire, and keeps
 * the token in memory meanwhile so a poll's requests do not read the store.
 * A grant with no stored token, or one whose refresh token the provider
 * refused, fails every request with what the operator has to run, and sends
 * nothing to the provider until they do.
 */
export class OAuthGrants {
  private readonly memo = new Map<string, { token: string; expiresAt: number }>();
  private readonly now: () => number;
  private readonly loginHint: (key: string) => string;

  constructor(
    private readonly store: OAuthGrantStore,
    opts: { now?: () => number; loginHint?: (key: string) => string } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.loginHint = opts.loginHint ?? ((key) => `run "feed-auth login ${key}"`);
  }

  private missing(key: string): Error {
    return new Error(`OAuth2 grant ${key} has no stored login: ${this.loginHint(key)}`);
  }

  private refused(key: string, grant: StoredGrant): Error {
    return new Error(
      `OAuth2 grant ${key}: the provider refused its refresh token (${grant.lastError ?? "rejected"}); ${this.loginHint(key)}`,
    );
  }

  /** The grant's access token, refreshed first when it is due. */
  async accessToken(grant: GrantRequest): Promise<string> {
    const now = this.now();
    const memo = this.memo.get(grant.key);
    if (memo && memo.expiresAt - ACCESS_MARGIN_MS > now) return memo.token;
    const stored = await this.store.read(grant.key);
    if (stored === undefined) throw this.missing(grant.key);
    if (stored.rejectedAt !== null) throw this.refused(grant.key, stored);
    if (!needsRefresh(stored, grant.auth, now)) return this.remember(grant.key, stored);

    const outcome = await this.store.locked(grant.key, async (current, write) => {
      if (current === undefined) return { error: this.missing(grant.key) };
      if (current.rejectedAt !== null) return { error: this.refused(grant.key, current) };
      // Another holder refreshed it while this one waited for the lock.
      if (!needsRefresh(current, grant.auth, this.now())) return { grant: current };
      const answer = await tokenRequest(grant, {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      });
      const at = this.now();
      if ("ok" in answer) {
        const next = granted(answer.ok, current, at);
        await write(next);
        return { grant: next };
      }
      const rejected = "rejected" in answer;
      const failed: StoredGrant = {
        ...current,
        ...(rejected ? { accessToken: null, accessExpiresAt: null, rejectedAt: at } : {}),
        lastError: rejected ? answer.rejected : answer.failed,
        lastErrorAt: at,
        updatedAt: at,
      };
      await write(failed);
      return {
        error: rejected
          ? this.refused(grant.key, failed)
          : new Error(`OAuth2 grant ${grant.key}: ${answer.failed}`),
      };
    });
    if ("error" in outcome) throw outcome.error;
    return this.remember(grant.key, outcome.grant);
  }

  private remember(key: string, grant: StoredGrant): string {
    if (grant.accessToken === null || grant.accessExpiresAt === null) throw this.missing(key);
    this.memo.set(key, { token: grant.accessToken, expiresAt: grant.accessExpiresAt });
    return grant.accessToken;
  }

  /**
   * Forgets an access token the provider no longer accepts (a 401), so the
   * next request refreshes. Another token stored meanwhile is left alone.
   */
  async invalidate(key: string, token: string): Promise<void> {
    if (this.memo.get(key)?.token === token) this.memo.delete(key);
    await this.store.locked(key, async (current, write) => {
      if (current?.accessToken !== token) return;
      await write({ ...current, accessToken: null, accessExpiresAt: null, updatedAt: this.now() });
    });
  }

  /** Exchanges an authorization code (with its PKCE verifier) for a new grant, replacing any stored one. */
  async login(grant: GrantRequest, code: string, verifier: string): Promise<StoredGrant> {
    return this.establish(grant, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: grant.auth.redirectUri,
    });
  }

  /**
   * Stores the grant a refresh token obtained elsewhere stands for, after
   * spending it on one refresh: that proves it, and the provider's rotation
   * leaves the refresh token only this store holds.
   */
  async import(grant: GrantRequest, refreshToken: string): Promise<StoredGrant> {
    return this.establish(
      grant,
      { grant_type: "refresh_token", refresh_token: refreshToken },
      refreshToken,
    );
  }

  private async establish(
    grant: GrantRequest,
    params: Record<string, string>,
    presented?: string,
  ): Promise<StoredGrant> {
    this.memo.delete(grant.key);
    return this.store.locked(grant.key, async (_current, write) => {
      const answer = await tokenRequest(grant, params);
      if (!("ok" in answer)) {
        throw new Error(
          `OAuth2 grant ${grant.key}: ${"rejected" in answer ? `the provider refused it (${answer.rejected})` : answer.failed}`,
        );
      }
      const at = this.now();
      const prior =
        presented === undefined
          ? undefined
          : {
              refreshToken: presented,
              refreshIssuedAt: at,
              accessToken: null,
              accessExpiresAt: null,
              rejectedAt: null,
              lastError: null,
              lastErrorAt: null,
              updatedAt: at,
            };
      const next = granted(answer.ok, prior, at);
      await write(next);
      return next;
    });
  }
}
