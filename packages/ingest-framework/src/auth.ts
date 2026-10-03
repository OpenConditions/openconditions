import { fetch as undiciFetch } from "undici";
import {
  type CredentialRef,
  type Env,
  type FeedCredentialName,
  feedCredentialNames,
  resolveCredential,
} from "./catalog/credentials.js";
import type { CatalogFeed } from "./catalog/types.js";
import { guardedFetch, guardOptionsFromEnv } from "./egress.js";

/**
 * Per-feed authentication. Turns a feed's declared `auth` into a `fetch`
 * wrapper that injects the right credential (from env) on every request, and
 * exposes credential-presence helpers so the scheduler can skip a feed whose
 * secrets are not configured. Keeping this here (not in the parser package)
 * keeps secrets and HTTP concerns out of the pure feed registry.
 */

type FeedAuth = NonNullable<CatalogFeed["auth"]>;

/**
 * The env vars a feed still needs: every credential it reads (auth, endpoint
 * `${field}`s and `expand`) that is unset in `env` and its `_FILE` variant.
 * An optional field, or one with a `default`, is never missing.
 */
export function missingCredentials(feed: CatalogFeed, env: Env = process.env): string[] {
  return feedCredentialNames(feed)
    .filter((name) => !name.optional && name.default === undefined)
    .filter((name) => resolveCredential(env, name.env) === undefined)
    .map((name) => name.env);
}

/** True when the feed needs no credentials, or every one it needs is set. */
export function hasCredentials(feed: CatalogFeed, env: Env = process.env): boolean {
  return missingCredentials(feed, env).length === 0;
}

/** Reads a feed's credentials by ref: env (or `_FILE`) first, then the field's `default`. */
function credentialReader(feed: CatalogFeed, env: Env) {
  const byRef = new Map<CredentialRef, FeedCredentialName>(
    feedCredentialNames(feed).map((name) => [name.ref, name]),
  );
  const nameOf = (ref: CredentialRef): FeedCredentialName => {
    const name = byRef.get(ref);
    if (!name) throw new Error(`feed ${feed.id}: credential ${ref} is not declared`);
    return name;
  };
  return {
    optional: (ref: CredentialRef): string | undefined => {
      const name = nameOf(ref);
      return resolveCredential(env, name.env) ?? name.default;
    },
    need: (ref: CredentialRef): string => {
      const name = nameOf(ref);
      const value = resolveCredential(env, name.env) ?? name.default;
      if (!value) throw new Error(`missing credential env var ${name.env} (or ${name.env}_FILE)`);
      return value;
    },
  };
}

type CredentialReader = ReturnType<typeof credentialReader>;

/**
 * Reconstruct canonical PEM from a possibly-mangled credential value. Pasting a
 * certificate/key into an admin-panel field, or converting a `.p12` with
 * `openssl pkcs12`, commonly produces material that Node's TLS (and curl) reject:
 * a "Bag Attributes …" preamble before the first `-----BEGIN`, and/or newlines
 * collapsed to spaces so the whole block is one line ("no start line"). For each
 * BEGIN/END block we keep only the base64 body, strip every non-base64 char, and
 * re-wrap at 64 columns. Returns the input unchanged when it holds no PEM block.
 */
export function normalizePem(raw: string): string {
  const re = /-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]*?)-----END \1-----/g;
  const blocks: string[] = [];
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const label = m[1];
    const body = (m[2].match(/[A-Za-z0-9+/=]/g) ?? []).join("");
    const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? "";
    blocks.push(`-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`);
  }
  return blocks.length > 0 ? `${blocks.join("\n")}\n` : raw;
}

function withQueryParam(input: Parameters<typeof fetch>[0], param: string, value: string): string {
  const url = new URL(typeof input === "string" ? input : input.toString());
  url.searchParams.set(param, value);
  return url.toString();
}

function withHeader(baseFetch: typeof fetch, name: string, value: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(name, value);
    return baseFetch(input, { ...init, headers });
  };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

/** Refresh-cached OAuth2 client-credentials bearer fetch. */
function oauthClientCredentialsFetch(
  auth: Extract<FeedAuth, { kind: "oauth2-client-credentials" }>,
  baseFetch: typeof fetch,
  credentials: CredentialReader,
  now: () => number,
): typeof fetch {
  let cache: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    const t = now();
    // 30 s skew so a token never expires mid-request.
    if (cache && cache.expiresAt > t + 30_000) return cache.token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.need(auth.clientId),
      client_secret: credentials.need(auth.clientSecret),
    });
    if (auth.scope) body.set("scope", auth.scope);
    const res = await baseFetch(auth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status}`);
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) throw new Error("OAuth token response missing access_token");
    cache = { token: json.access_token, expiresAt: t + (json.expires_in ?? 3600) * 1000 };
    return cache.token;
  }

  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${await token()}`);
    return baseFetch(input, { ...init, headers });
  };
}

/**
 * Wraps `baseFetch` so every request for `feed` carries its credential. Returns
 * `baseFetch` unchanged for keyless feeds. Reads each credential from its
 * derived env var (or `_FILE` variant), else its field's `default` (e.g. a
 * public key); throws if a required static secret is missing (the scheduler
 * gates on {@link hasCredentials} first, so this only fires on misconfiguration).
 */
export function makeAuthorizedFetch(
  feed: CatalogFeed,
  baseFetch: typeof fetch,
  env: Env = process.env,
  now: () => number = Date.now,
): typeof fetch {
  const auth = feed.auth;
  if (!auth || auth.kind === "none") return baseFetch;
  const credentials = credentialReader(feed, env);

  switch (auth.kind) {
    case "query-key": {
      const value = credentials.need(auth.credential);
      return (input, init) => baseFetch(withQueryParam(input, auth.param, value), init);
    }
    case "header-key":
      return withHeader(
        baseFetch,
        auth.header,
        (auth.valuePrefix ?? "") + credentials.need(auth.credential),
      );
    case "bearer":
      return withHeader(baseFetch, "Authorization", `Bearer ${credentials.need(auth.credential)}`);
    case "basic": {
      const creds = Buffer.from(
        `${credentials.need(auth.user)}:${credentials.need(auth.password)}`,
      ).toString("base64");
      return withHeader(baseFetch, "Authorization", `Basic ${creds}`);
    }
    case "oauth2-client-credentials":
      return oauthClientCredentialsFetch(auth, baseFetch, credentials, now);
    case "mtls": {
      // Fold the client certificate into the egress guard's OWN pinned
      // dispatcher, so mTLS gets the same SSRF/DNS-rebinding protection as every
      // other auth kind: the guard resolves+validates the host once and dials the
      // pinned IP with the cert on a single Agent — no separate, unpinned
      // handshake path that a 302 could redirect to an internal address, and no
      // second unchecked DNS resolution. `dispatcher` is honored by undici's
      // fetch (the guard's default base), version-matched to its Agent.
      const ca = auth.ca ? credentials.optional(auth.ca) : undefined;
      return guardedFetch(undiciFetch as unknown as typeof fetch, guardOptionsFromEnv(), {
        cert: normalizePem(credentials.need(auth.cert)),
        key: normalizePem(credentials.need(auth.key)),
        ...(ca ? { ca: normalizePem(ca) } : {}),
      });
    }
  }
}
