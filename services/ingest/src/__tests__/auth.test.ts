import { describe, expect, it, vi } from "vitest";
import type { FeedAuth } from "@openconditions/roads";
import { hasCredentials, makeAuthorizedFetch, requiredEnvVars } from "../pipeline/auth.js";

/** A fake fetch that records the (url, init) it was called with and returns 200. */
function recorder(body = "{}") {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe("requiredEnvVars", () => {
  it("lists the env vars each auth kind needs", () => {
    expect(requiredEnvVars(undefined)).toEqual([]);
    expect(requiredEnvVars({ kind: "none" })).toEqual([]);
    expect(requiredEnvVars({ kind: "query-key", param: "key", envVar: "K" })).toEqual(["K"]);
    expect(requiredEnvVars({ kind: "basic", userEnvVar: "U", passEnvVar: "P" })).toEqual([
      "U",
      "P",
    ]);
    expect(
      requiredEnvVars({
        kind: "oauth2-client-credentials",
        tokenUrl: "https://t",
        clientIdEnvVar: "ID",
        clientSecretEnvVar: "SEC",
      })
    ).toEqual(["ID", "SEC"]);
    expect(requiredEnvVars({ kind: "mtls", certEnvVar: "C", keyEnvVar: "K" })).toEqual(["C", "K"]);
  });
});

describe("hasCredentials", () => {
  it("is true for keyless feeds and when all env vars are set, false otherwise", () => {
    expect(hasCredentials({}, {})).toBe(true);
    expect(hasCredentials({ auth: { kind: "none" } }, {})).toBe(true);
    expect(hasCredentials({ auth: { kind: "bearer", envVar: "T" } }, { T: "x" })).toBe(true);
    expect(hasCredentials({ auth: { kind: "bearer", envVar: "T" } }, {})).toBe(false);
    expect(hasCredentials({ auth: { kind: "bearer", envVar: "T" } }, { T: "" })).toBe(false);
    expect(
      hasCredentials({ auth: { kind: "basic", userEnvVar: "U", passEnvVar: "P" } }, { U: "u" })
    ).toBe(false);
  });

  it("also gates on requiredEnv (e.g. a key embedded in a POST body)", () => {
    expect(hasCredentials({ requiredEnv: ["K"] }, {})).toBe(false);
    expect(hasCredentials({ requiredEnv: ["K"] }, { K: "x" })).toBe(true);
    // both auth and requiredEnv must be satisfied
    expect(
      hasCredentials({ auth: { kind: "bearer", envVar: "T" }, requiredEnv: ["K"] }, { T: "t" })
    ).toBe(false);
  });
});

describe("makeAuthorizedFetch", () => {
  it("returns the base fetch unchanged for keyless feeds", () => {
    const { fn } = recorder();
    expect(makeAuthorizedFetch({}, fn)).toBe(fn);
    expect(makeAuthorizedFetch({ auth: { kind: "none" } }, fn)).toBe(fn);
  });

  it("query-key appends the secret as a URL query parameter", async () => {
    const { fn, calls } = recorder();
    const auth: FeedAuth = { kind: "query-key", param: "key", envVar: "K" };
    await makeAuthorizedFetch({ auth }, fn, { K: "secret123" })("https://api.example/get/event");
    expect(calls[0]!.url).toBe("https://api.example/get/event?key=secret123");
  });

  it("header-key sets the configured header (with optional prefix)", async () => {
    const { fn, calls } = recorder();
    const auth: FeedAuth = {
      kind: "header-key",
      header: "X-Api-Key",
      envVar: "K",
      valuePrefix: "Token ",
    };
    await makeAuthorizedFetch({ auth }, fn, { K: "abc" })("https://api.example/");
    expect(header(calls[0]!.init, "X-Api-Key")).toBe("Token abc");
  });

  it("bearer and basic set the Authorization header", async () => {
    const r1 = recorder();
    await makeAuthorizedFetch({ auth: { kind: "bearer", envVar: "T" } }, r1.fn, { T: "tok" })(
      "https://x/"
    );
    expect(header(r1.calls[0]!.init, "Authorization")).toBe("Bearer tok");

    const r2 = recorder();
    const basic: FeedAuth = { kind: "basic", userEnvVar: "U", passEnvVar: "P" };
    await makeAuthorizedFetch({ auth: basic }, r2.fn, { U: "user", P: "pass" })("https://x/");
    expect(header(r2.calls[0]!.init, "Authorization")).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`
    );
  });

  it("mtls injects an undici dispatcher built from the cert/key env vars", async () => {
    const { fn, calls } = recorder();
    const auth: FeedAuth = { kind: "mtls", certEnvVar: "CERT", keyEnvVar: "KEY" };
    await makeAuthorizedFetch({ auth }, fn, {
      CERT: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
      KEY: "-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----",
    })("https://mobilithek.example/pull");
    const init = calls[0]!.init as (RequestInit & { dispatcher?: unknown }) | undefined;
    expect(init?.dispatcher).toBeDefined();
  });

  it("throws when a required static secret is missing", () => {
    expect(() =>
      makeAuthorizedFetch({ auth: { kind: "bearer", envVar: "T" } }, recorder().fn, {})
    ).toThrow(/missing credential env var T/);
  });

  it("oauth2 fetches a token once, caches it, and sends it as a bearer", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      if (url === "https://token/") {
        return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const auth: FeedAuth = {
      kind: "oauth2-client-credentials",
      tokenUrl: "https://token/",
      clientIdEnvVar: "ID",
      clientSecretEnvVar: "SEC",
    };
    const authed = makeAuthorizedFetch({ auth }, fn, { ID: "id", SEC: "sec" }, () => 1_000);
    await authed("https://data/1");
    await authed("https://data/2");

    const tokenCalls = calls.filter((c) => c.url === "https://token/");
    expect(tokenCalls).toHaveLength(1); // cached: only one token request
    const dataCalls = calls.filter((c) => c.url.startsWith("https://data/"));
    expect(dataCalls).toHaveLength(2);
    expect(header(dataCalls[0]!.init, "Authorization")).toBe("Bearer AT");
    expect(header(dataCalls[1]!.init, "Authorization")).toBe("Bearer AT");
  });
});
