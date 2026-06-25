import type { FeedAuth, FeedSource } from "@openconditions/roads";

/**
 * Per-feed authentication. Turns a feed's declared {@link FeedAuth} into a
 * `fetch` wrapper that injects the right credential (from env) on every request,
 * and exposes credential-presence helpers so the scheduler can skip a feed whose
 * secrets are not configured. Keeping this here (not in the parser package) keeps
 * secrets and HTTP concerns out of the pure feed registry.
 */

type Env = Record<string, string | undefined>;

/** The env-var names a given auth config needs to be usable. */
export function requiredEnvVars(auth: FeedAuth | undefined): string[] {
  if (!auth) return [];
  switch (auth.kind) {
    case "none":
      return [];
    case "query-key":
    case "header-key":
    case "bearer":
      return [auth.envVar];
    case "basic":
      return [auth.userEnvVar, auth.passEnvVar];
    case "oauth2-client-credentials":
      return [auth.clientIdEnvVar, auth.clientSecretEnvVar];
  }
}

/** True when the feed needs no credentials, or all its required env vars are set.
 * Covers both `auth`-derived vars and any extra `requiredEnv` (e.g. a key the
 * feed embeds in its POST body). */
export function hasCredentials(
  src: Pick<FeedSource, "auth" | "requiredEnv">,
  env: Env = process.env
): boolean {
  const required = [...requiredEnvVars(src.auth), ...(src.requiredEnv ?? [])];
  return required.every((k) => {
    const v = env[k];
    return typeof v === "string" && v.length > 0;
  });
}

function need(env: Env, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing credential env var ${key}`);
  return v;
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
  env: Env,
  now: () => number
): typeof fetch {
  let cache: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    const t = now();
    // 30 s skew so a token never expires mid-request.
    if (cache && cache.expiresAt > t + 30_000) return cache.token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: need(env, auth.clientIdEnvVar),
      client_secret: need(env, auth.clientSecretEnvVar),
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
 * Wraps `baseFetch` so every request for `src` carries its credential. Returns
 * `baseFetch` unchanged for keyless feeds. Reads secrets from `env`; throws if a
 * required static secret is missing (the scheduler gates on {@link hasCredentials}
 * first, so this only fires on misconfiguration).
 */
export function makeAuthorizedFetch(
  src: Pick<FeedSource, "auth">,
  baseFetch: typeof fetch,
  env: Env = process.env,
  now: () => number = Date.now
): typeof fetch {
  const auth = src.auth;
  if (!auth || auth.kind === "none") return baseFetch;

  switch (auth.kind) {
    case "query-key": {
      const value = need(env, auth.envVar);
      return (input, init) => baseFetch(withQueryParam(input, auth.param, value), init);
    }
    case "header-key":
      return withHeader(baseFetch, auth.header, (auth.valuePrefix ?? "") + need(env, auth.envVar));
    case "bearer":
      return withHeader(baseFetch, "Authorization", `Bearer ${need(env, auth.envVar)}`);
    case "basic": {
      const creds = Buffer.from(
        `${need(env, auth.userEnvVar)}:${need(env, auth.passEnvVar)}`
      ).toString("base64");
      return withHeader(baseFetch, "Authorization", `Basic ${creds}`);
    }
    case "oauth2-client-credentials":
      return oauthClientCredentialsFetch(auth, baseFetch, env, now);
  }
}
