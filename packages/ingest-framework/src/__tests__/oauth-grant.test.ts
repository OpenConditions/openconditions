import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeAuthorizedFetch } from "../auth.js";
import type { CatalogFeed } from "../catalog/types.js";
import {
  type AuthorizationCodeAuth,
  authorizationUrl,
  type GrantRequest,
  type OAuthGrantStore,
  OAuthGrants,
  pastedAuthorization,
  pkcePair,
  type StoredGrant,
} from "../oauth-grant.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const TOKEN_URL = "https://login.example/token";

const AUTH: AuthorizationCodeAuth = {
  kind: "oauth2-authorization-code",
  authorizeUrl: "https://login.example/authorize",
  tokenUrl: TOKEN_URL,
  redirectUri: "https://api.example/cli",
  clientId: "@acme.client_id",
  scope: "openid profile",
  responseMode: "fragment",
  refreshTokenTtlSec: 30 * 24 * 3600,
};

/**
 * Grants in memory with the store's contract: `locked` runs one holder per
 * key at a time, and what it wrote is kept only once it returns.
 */
function memoryStore(initial: Record<string, StoredGrant> = {}) {
  const rows = new Map(Object.entries(initial));
  const queues = new Map<string, Promise<unknown>>();
  let reads = 0;
  const store: OAuthGrantStore = {
    async read(key) {
      reads++;
      const row = rows.get(key);
      return row ? { ...row } : undefined;
    },
    locked(key, fn) {
      const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
        let pending: StoredGrant | undefined;
        const current = rows.get(key);
        const result = await fn(current ? { ...current } : undefined, async (next) => {
          pending = { ...next };
        });
        if (pending) rows.set(key, pending);
        return result;
      });
      queues.set(
        key,
        run.catch(() => undefined),
      );
      return run;
    },
  };
  return { store, rows, reads: () => reads };
}

const grant = (over: Partial<StoredGrant> = {}): StoredGrant => ({
  refreshToken: "refresh-1",
  refreshIssuedAt: NOW - HOUR,
  accessToken: "access-1",
  accessExpiresAt: NOW + 7 * HOUR,
  rejectedAt: null,
  lastError: null,
  lastErrorAt: null,
  updatedAt: NOW - HOUR,
  ...over,
});

/** A token endpoint that rotates the refresh token on every refresh, or answers `status`. */
function tokenEndpoint(answer: { status?: number; body?: unknown } = {}) {
  const requests: URLSearchParams[] = [];
  let issued = 1;
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url !== TOKEN_URL) return new Response("data", { status: 200 });
    const params = new URLSearchParams(String(init?.body));
    requests.push(params);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (answer.status !== undefined) {
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    }
    issued++;
    return new Response(
      JSON.stringify({
        access_token: `access-${issued}`,
        expires_in: 28800,
        refresh_token: `refresh-${issued}`,
        token_type: "Bearer",
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fn, requests };
}

const request = (fetchFn: typeof fetch): GrantRequest => ({
  key: "acme",
  auth: AUTH,
  clientId: "public-client",
  fetch: fetchFn,
});

const grants = (store: OAuthGrantStore, now = () => NOW) =>
  new OAuthGrants(store, { now, loginHint: (key) => `run "login ${key}"` });

describe("OAuthGrants.accessToken", () => {
  it("fails naming the login when no grant is stored, and asks the provider nothing", async () => {
    const { store } = memoryStore();
    const endpoint = tokenEndpoint();
    await expect(grants(store).accessToken(request(endpoint.fn))).rejects.toThrow(
      'OAuth2 grant acme has no stored login: run "login acme"',
    );
    expect(endpoint.requests).toEqual([]);
  });

  it("hands out a stored access token that is still valid, then from memory", async () => {
    const memory = memoryStore({ acme: grant() });
    const endpoint = tokenEndpoint();
    const holder = grants(memory.store);
    expect(await holder.accessToken(request(endpoint.fn))).toBe("access-1");
    expect(await holder.accessToken(request(endpoint.fn))).toBe("access-1");
    expect(endpoint.requests).toEqual([]);
    expect(memory.reads()).toBe(1);
  });

  it("refreshes a token about to expire, storing the rotated refresh token before using it", async () => {
    const memory = memoryStore({ acme: grant({ accessExpiresAt: NOW + 60_000 }) });
    const endpoint = tokenEndpoint();
    expect(await grants(memory.store).accessToken(request(endpoint.fn))).toBe("access-2");
    expect(endpoint.requests).toHaveLength(1);
    expect(Object.fromEntries(endpoint.requests[0]!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "public-client",
    });
    expect(memory.rows.get("acme")).toEqual({
      refreshToken: "refresh-2",
      refreshIssuedAt: NOW,
      accessToken: "access-2",
      accessExpiresAt: NOW + 8 * HOUR,
      rejectedAt: null,
      lastError: null,
      lastErrorAt: null,
      updatedAt: NOW,
    });
  });

  it("renews a refresh token at half its life even while the access token is valid", async () => {
    const memory = memoryStore({ acme: grant({ refreshIssuedAt: NOW - 15 * 24 * HOUR }) });
    const endpoint = tokenEndpoint();
    expect(await grants(memory.store).accessToken(request(endpoint.fn))).toBe("access-2");
    expect(memory.rows.get("acme")?.refreshIssuedAt).toBe(NOW);
  });

  it("refreshes once when two processes find the token expired together", async () => {
    const memory = memoryStore({ acme: grant({ accessExpiresAt: NOW - 1 }) });
    const endpoint = tokenEndpoint();
    const tokens = await Promise.all([
      grants(memory.store).accessToken(request(endpoint.fn)),
      grants(memory.store).accessToken(request(endpoint.fn)),
    ]);
    expect(tokens).toEqual(["access-2", "access-2"]);
    expect(endpoint.requests).toHaveLength(1);
    expect(memory.rows.get("acme")?.refreshToken).toBe("refresh-2");
  });

  it("marks a refused refresh token, fails with the login, and never asks again", async () => {
    const memory = memoryStore({ acme: grant({ accessExpiresAt: NOW - 1 }) });
    const endpoint = tokenEndpoint({
      status: 400,
      body: { error: "invalid_grant", error_description: "refresh-1 expired" },
    });
    const holder = grants(memory.store);
    const refused =
      'OAuth2 grant acme: the provider refused its refresh token (HTTP 400 invalid_grant); run "login acme"';
    await expect(holder.accessToken(request(endpoint.fn))).rejects.toThrow(refused);
    expect(memory.rows.get("acme")).toMatchObject({
      refreshToken: "refresh-1",
      accessToken: null,
      rejectedAt: NOW,
      lastError: "HTTP 400 invalid_grant",
      lastErrorAt: NOW,
    });
    await expect(holder.accessToken(request(endpoint.fn))).rejects.toThrow(refused);
    await expect(grants(memory.store).accessToken(request(endpoint.fn))).rejects.toThrow(refused);
    expect(endpoint.requests).toHaveLength(1);
  });

  it("keeps the grant on a failure that may pass, and tries again at the next request", async () => {
    const memory = memoryStore({ acme: grant({ accessExpiresAt: NOW - 1 }) });
    const endpoint = tokenEndpoint({ status: 503 });
    const holder = grants(memory.store);
    await expect(holder.accessToken(request(endpoint.fn))).rejects.toThrow(
      "OAuth2 grant acme: token request failed: HTTP 503",
    );
    expect(memory.rows.get("acme")).toMatchObject({
      refreshToken: "refresh-1",
      rejectedAt: null,
      lastError: "token request failed: HTTP 503",
    });
    await expect(holder.accessToken(request(endpoint.fn))).rejects.toThrow("HTTP 503");
    expect(endpoint.requests).toHaveLength(2);
  });
});

describe("OAuthGrants.login and import", () => {
  it("exchanges the code with its verifier and replaces a refused grant", async () => {
    const memory = memoryStore({ acme: grant({ rejectedAt: NOW - HOUR, accessToken: null }) });
    const endpoint = tokenEndpoint();
    const stored = await grants(memory.store).login(request(endpoint.fn), "the-code", "verifier");
    expect(Object.fromEntries(endpoint.requests[0]!)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: "verifier",
      redirect_uri: "https://api.example/cli",
      client_id: "public-client",
    });
    expect(stored).toMatchObject({ refreshToken: "refresh-2", rejectedAt: null });
    expect(memory.rows.get("acme")).toEqual(stored);
  });

  it("spends an imported refresh token on one refresh and stores what it was rotated to", async () => {
    const memory = memoryStore();
    const endpoint = tokenEndpoint();
    const stored = await grants(memory.store).import(request(endpoint.fn), "refresh-elsewhere");
    expect(endpoint.requests[0]?.get("refresh_token")).toBe("refresh-elsewhere");
    expect(memory.rows.get("acme")).toEqual(stored);
    expect(stored).toMatchObject({ refreshToken: "refresh-2", accessToken: "access-2" });
  });

  it("stores nothing when the provider refuses the import", async () => {
    const memory = memoryStore();
    const endpoint = tokenEndpoint({ status: 401, body: { error: "invalid_grant" } });
    await expect(grants(memory.store).import(request(endpoint.fn), "refresh-dead")).rejects.toThrow(
      "OAuth2 grant acme: the provider refused it (HTTP 401 invalid_grant)",
    );
    expect(memory.rows.size).toBe(0);
  });
});

describe("a feed reading an OAuth2 grant", () => {
  const feed: CatalogFeed = {
    ...catalogFeed({ auth: AUTH }),
    sharedFields: { "@acme.client_id": { title: "Client", default: "public-client" } },
  };

  it("sends the access token, and on a 401 drops it and asks once more with a fresh one", async () => {
    const memory = memoryStore({ acme: grant() });
    const sent: (string | null)[] = [];
    let refused = true;
    const endpoint = tokenEndpoint();
    const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) === TOKEN_URL) return endpoint.fn(input, init);
      sent.push(new Headers(init?.headers).get("Authorization"));
      if (refused) {
        refused = false;
        return new Response("expired", { status: 401 });
      }
      return new Response("data", { status: 200 });
    }) as typeof fetch;
    const authed = makeAuthorizedFetch(feed, fn, {}, () => NOW, grants(memory.store));
    const res = await authed("https://api.example/data");
    expect(res.status).toBe(200);
    expect(sent).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(memory.rows.get("acme")?.refreshToken).toBe("refresh-2");
  });

  it("fails where no grants are held", async () => {
    const authed = makeAuthorizedFetch(feed, tokenEndpoint().fn, {});
    await expect(authed("https://api.example/data")).rejects.toThrow(
      "no store of OAuth2 grants to read acme from",
    );
  });
});

describe("the login's parts", () => {
  it("asks for a code with an S256 challenge of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const url = new URL(authorizationUrl(AUTH, "public-client", "st4te", challenge));
    expect(url.origin + url.pathname).toBe("https://login.example/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: "https://api.example/cli",
      scope: "openid profile",
      state: "st4te",
      code_challenge: challenge,
      code_challenge_method: "S256",
      response_mode: "fragment",
    });
  });

  it("reads the code alone or out of the redirect URL", () => {
    expect(pastedAuthorization("  OC-123-abc \n")).toEqual({ code: "OC-123-abc" });
    expect(pastedAuthorization("https://api.example/cli#code=OC-9&state=st4te")).toEqual({
      code: "OC-9",
      state: "st4te",
    });
    expect(pastedAuthorization("https://api.example/cli?state=x&code=OC-7")).toEqual({
      code: "OC-7",
      state: "x",
    });
    expect(pastedAuthorization("")).toBeUndefined();
    expect(pastedAuthorization("two words")).toBeUndefined();
  });
});
