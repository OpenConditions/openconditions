import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";
import type { FeedAuth, FeedSourceBase } from "./feed-source.js";

/**
 * Per-feed authentication. Turns a feed's declared {@link FeedAuth} into a
 * `fetch` wrapper that injects the right credential (from env) on every request,
 * and exposes credential-presence helpers so the scheduler can skip a feed whose
 * secrets are not configured. Keeping this here (not in the parser package) keeps
 * secrets and HTTP concerns out of the pure feed registry.
 */

type Env = Record<string, string | undefined>;

/**
 * Resolve a credential value, supporting the `*_FILE` convention used by
 * file-based secret delivery (Docker `secrets:` mounts at `/run/secrets/<KEY>`).
 * Prefers a non-empty env var; otherwise reads the file named by `<KEY>_FILE`.
 * An empty/whitespace env var falls through to the file, so a blank placeholder
 * never shadows a mounted secret. Returns `undefined` when neither yields a
 * non-empty value.
 */
export function resolveCredential(env: Env, key: string): string | undefined {
  const direct = env[key]?.trim();
  if (direct) return direct;
  const filePath = env[`${key}_FILE`]?.trim();
  if (filePath) {
    try {
      const contents = readFileSync(filePath, "utf8").trim();
      if (contents) return contents;
    } catch {
      // Missing/unreadable secret file → treated as "not set".
    }
  }
  return undefined;
}

/**
 * An env-like view that transparently applies the `*_FILE` fallback on every
 * lookup. Pass this (instead of raw `process.env`) to a feed's url/body builder
 * so credentials embedded in a request URL or body — e.g. Trafikverket's
 * POST-body key, Buenos Aires' client_id/secret, NRW's subscription id — also
 * resolve from mounted secret files. Non-credential keys fall back to the raw
 * env value unchanged.
 */
export function resolvedEnv(env: Env = process.env): Env {
  return new Proxy({} as Env, {
    get: (_t, prop) =>
      typeof prop === "string" ? (resolveCredential(env, prop) ?? env[prop]) : undefined,
    has: (_t, prop) => typeof prop === "string" && (prop in env || `${prop}_FILE` in env),
  });
}

/** The env-var names a given auth config needs to be usable. */
export function requiredEnvVars(auth: FeedAuth | undefined): string[] {
  if (!auth) return [];
  switch (auth.kind) {
    case "none":
      return [];
    case "query-key":
      // A built-in default (e.g. a public API key) makes the env var optional.
      return auth.defaultValue ? [] : [auth.envVar];
    case "header-key":
    case "bearer":
      return [auth.envVar];
    case "basic":
      return [auth.userEnvVar, auth.passEnvVar];
    case "oauth2-client-credentials":
      return [auth.clientIdEnvVar, auth.clientSecretEnvVar];
    case "mtls":
      return [auth.certEnvVar, auth.keyEnvVar];
  }
}

/** True when the feed needs no credentials, or all its required env vars are set.
 * Covers both `auth`-derived vars and any extra `requiredEnv` (e.g. a key the
 * feed embeds in its POST body). */
export function hasCredentials(
  src: Pick<FeedSourceBase, "auth" | "requiredEnv">,
  env: Env = process.env
): boolean {
  const required = [...requiredEnvVars(src.auth), ...(src.requiredEnv ?? [])];
  return required.every((k) => resolveCredential(env, k) !== undefined);
}

function need(env: Env, key: string): string {
  const v = resolveCredential(env, key);
  if (!v) throw new Error(`missing credential env var ${key} (or ${key}_FILE)`);
  return v;
}

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
  src: Pick<FeedSourceBase, "auth">,
  baseFetch: typeof fetch,
  env: Env = process.env,
  now: () => number = Date.now
): typeof fetch {
  const auth = src.auth;
  if (!auth || auth.kind === "none") return baseFetch;

  switch (auth.kind) {
    case "query-key": {
      // Env var (or `*_FILE`) wins when set; otherwise fall back to a built-in
      // default (e.g. a public key). `||` (not `??`) so an empty value also falls back.
      const value =
        resolveCredential(env, auth.envVar) || auth.defaultValue || need(env, auth.envVar);
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
    case "mtls": {
      // Build one undici Agent carrying the client certificate and reuse it for
      // every request (handshake material is set once). The `dispatcher` must be
      // consumed by undici's OWN fetch: passing this Agent (from the `undici`
      // package) as `dispatcher` to Node's BUILT-IN fetch throws "invalid
      // onRequestStart method" — the two ship different undici versions whose
      // internal request handlers are incompatible. Using undici's fetch keeps the
      // Agent and the fetch implementation version-matched.
      const ca = auth.caEnvVar ? env[auth.caEnvVar] : undefined;
      const dispatcher = new Agent({
        connect: {
          cert: normalizePem(need(env, auth.certEnvVar)),
          key: normalizePem(need(env, auth.keyEnvVar)),
          ...(ca ? { ca: normalizePem(ca) } : {}),
        },
      });
      return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher,
        })) as unknown as typeof fetch;
    }
  }
}
