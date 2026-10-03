import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hasCredentials, makeAuthorizedFetch, missingCredentials, normalizePem } from "../auth.js";
import type { CatalogFeed } from "../catalog/types.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

// mTLS must route through undici's OWN fetch (version-matched to its Agent), not
// the injected base fetch. Mock undici.fetch (keeping the real Agent) so the test
// can assert the dispatcher is passed without opening a real TLS connection.
const { undiciFetchMock } = vi.hoisted(() => ({ undiciFetchMock: vi.fn() }));
vi.mock("undici", async (orig) => {
  const actual = await orig<typeof import("undici")>();
  return { ...actual, fetch: undiciFetchMock };
});

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

/** A feed `xx-test-events` with the given auth; its credential env vars are `XX_TEST_EVENTS_<FIELD>`. */
function authFeed(
  auth?: CatalogFeed["auth"],
  credentials: CatalogFeed["credentials"] = {},
  extra: Partial<CatalogFeed> = {},
): CatalogFeed {
  return catalogFeed({ ...(auth ? { auth } : {}), credentials, ...extra });
}

const field = (title: string, more: { optional?: boolean; default?: string } = {}) => ({
  title,
  ...more,
});

const ohgoFlowFeed = catalogFeed({
  region: "us",
  subdivision: "oh",
  operator: "ohgo",
  product: "flow",
  auth: { kind: "query-key", param: "api-key", credential: "@us-oh-ohgo.api_key" },
});

describe("normalizePem", () => {
  // 130 base64 chars → must re-wrap onto 3 lines (64+64+2).
  const b64 = "A".repeat(64) + "B".repeat(64) + "C".repeat(2);

  it("reconstructs canonical PEM from a single-line value with a Bag Attributes preamble", () => {
    const mangled = `Bag Attributes friendlyName: x localKeyID: 01 02 -----BEGIN CERTIFICATE----- ${b64} -----END CERTIFICATE-----`;
    const out = normalizePem(mangled);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN CERTIFICATE-----");
    expect(lines.at(-1)).toBe("-----END CERTIFICATE-----");
    expect(out).not.toContain("Bag Attributes");
    // body re-wrapped at <=64 cols and byte-identical to the source base64
    const body = lines.slice(1, -1);
    expect(body.every((l) => l.length <= 64)).toBe(true);
    expect(body.join("")).toBe(b64);
  });

  it("normalizes a key whose newlines were collapsed to spaces", () => {
    const out = normalizePem(`-----BEGIN PRIVATE KEY----- ${b64} -----END PRIVATE KEY-----`);
    expect(out.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    expect(out.trimEnd().endsWith("\n-----END PRIVATE KEY-----")).toBe(true);
  });

  it("returns input unchanged when no PEM block is present", () => {
    expect(normalizePem("not-a-pem")).toBe("not-a-pem");
  });
});

describe("missingCredentials", () => {
  it("missing credentials name the derived env vars", () => {
    expect(missingCredentials(ohgoFlowFeed, {})).toEqual(["US_OH_OHGO_API_KEY"]);
    expect(missingCredentials(ohgoFlowFeed, { US_OH_OHGO_API_KEY: "k" })).toEqual([]);
  });

  it("lists the env vars each auth kind needs", () => {
    expect(missingCredentials(authFeed(), {})).toEqual([]);
    expect(missingCredentials(authFeed({ kind: "none" }), {})).toEqual([]);
    expect(
      missingCredentials(authFeed({ kind: "query-key", param: "key", credential: "key" }), {}),
    ).toEqual(["XX_TEST_EVENTS_KEY"]);
    expect(
      missingCredentials(authFeed({ kind: "basic", user: "user", password: "pass" }), {}),
    ).toEqual(["XX_TEST_EVENTS_USER", "XX_TEST_EVENTS_PASS"]);
    expect(
      missingCredentials(
        authFeed({
          kind: "oauth2-client-credentials",
          tokenUrl: "https://t",
          clientId: "client_id",
          clientSecret: "client_secret",
        }),
        {},
      ),
    ).toEqual(["XX_TEST_EVENTS_CLIENT_ID", "XX_TEST_EVENTS_CLIENT_SECRET"]);
    expect(
      missingCredentials(authFeed({ kind: "mtls", cert: "cert", key: "key", ca: "ca" }), {}),
    ).toEqual(["XX_TEST_EVENTS_CERT", "XX_TEST_EVENTS_KEY"]);
  });

  it("never lists an optional field or a field with a default", () => {
    const auth = { kind: "query-key", param: "apikey", credential: "key" } as const;
    expect(
      missingCredentials(authFeed(auth, { key: field("Key", { default: "pub" }) }), {}),
    ).toEqual([]);
    expect(
      missingCredentials(authFeed(auth, { key: field("Key", { optional: true }) }), {}),
    ).toEqual([]);
  });

  it("includes credentials an endpoint names (e.g. a key embedded in a POST body)", () => {
    const feed = authFeed(
      undefined,
      { key: field("Key") },
      {
        endpoints: {
          main: { url: "https://x/", method: "POST", body: "<k>${key}</k>", cadenceSec: 60 },
        },
      },
    );
    expect(missingCredentials(feed, {})).toEqual(["XX_TEST_EVENTS_KEY"]);
    expect(missingCredentials(feed, { XX_TEST_EVENTS_KEY: "x" })).toEqual([]);
  });

  it("a catalogue child needs its parent's env vars", () => {
    const child = authFeed(
      { kind: "bearer", credential: "token" },
      {},
      {
        id: "xx-test-a1-events",
        parentSourceId: "xx-test-events",
      },
    );
    expect(missingCredentials(child, {})).toEqual(["XX_TEST_EVENTS_TOKEN"]);
  });
});

describe("hasCredentials", () => {
  const bearer = authFeed({ kind: "bearer", credential: "token" });

  it("is true for keyless feeds and when all env vars are set, false otherwise", () => {
    expect(hasCredentials(authFeed(), {})).toBe(true);
    expect(hasCredentials(authFeed({ kind: "none" }), {})).toBe(true);
    expect(hasCredentials(bearer, { XX_TEST_EVENTS_TOKEN: "x" })).toBe(true);
    expect(hasCredentials(bearer, {})).toBe(false);
    expect(hasCredentials(bearer, { XX_TEST_EVENTS_TOKEN: "" })).toBe(false);
    expect(
      hasCredentials(authFeed({ kind: "basic", user: "user", password: "pass" }), {
        XX_TEST_EVENTS_USER: "u",
      }),
    ).toBe(false);
  });

  it("also gates on credentials an endpoint names", () => {
    const both = authFeed(
      { kind: "bearer", credential: "token" },
      {},
      {
        endpoints: { main: { url: "https://x/?k=${key}", cadenceSec: 60 } },
      },
    );
    // both auth and the endpoint's credential must be satisfied
    expect(hasCredentials(both, { XX_TEST_EVENTS_TOKEN: "t" })).toBe(false);
    expect(hasCredentials(both, { XX_TEST_EVENTS_TOKEN: "t", XX_TEST_EVENTS_KEY: "k" })).toBe(true);
  });
});

describe("makeAuthorizedFetch", () => {
  it("returns the base fetch unchanged for keyless feeds", () => {
    const { fn } = recorder();
    expect(makeAuthorizedFetch(authFeed(), fn)).toBe(fn);
    expect(makeAuthorizedFetch(authFeed({ kind: "none" }), fn)).toBe(fn);
  });

  it("query-key appends the secret as a URL query parameter", async () => {
    const { fn, calls } = recorder();
    const feed = authFeed({ kind: "query-key", param: "key", credential: "key" });
    await makeAuthorizedFetch(feed, fn, { XX_TEST_EVENTS_KEY: "secret123" })(
      "https://api.example/get/event",
    );
    expect(calls[0]!.url).toBe("https://api.example/get/event?key=secret123");
  });

  it("query-key falls back to the field's default when the env var is unset, and the env var overrides it", async () => {
    const feed = authFeed(
      { kind: "query-key", param: "apikey", credential: "key" },
      { key: field("Key", { default: "pub" }) },
    );
    const pub = recorder();
    // No env var → the built-in default key is used.
    await makeAuthorizedFetch(feed, pub.fn, {})("https://api.example/v1/events");
    expect(pub.calls[0]!.url).toBe("https://api.example/v1/events?apikey=pub");

    // Env var set → it overrides the default.
    const own = recorder();
    await makeAuthorizedFetch(feed, own.fn, { XX_TEST_EVENTS_KEY: "registered" })(
      "https://api.example/v1/events",
    );
    expect(own.calls[0]!.url).toBe("https://api.example/v1/events?apikey=registered");
  });

  it("a shared credential reads its group's env var", async () => {
    const { fn, calls } = recorder();
    await makeAuthorizedFetch(ohgoFlowFeed, fn, { US_OH_OHGO_API_KEY: "shared" })("https://o/x");
    expect(calls[0]!.url).toBe("https://o/x?api-key=shared");
  });

  it("header-key sets the configured header (with optional prefix)", async () => {
    const { fn, calls } = recorder();
    const feed = authFeed({
      kind: "header-key",
      header: "X-Api-Key",
      credential: "key",
      valuePrefix: "Token ",
    });
    await makeAuthorizedFetch(feed, fn, { XX_TEST_EVENTS_KEY: "abc" })("https://api.example/");
    expect(header(calls[0]!.init, "X-Api-Key")).toBe("Token abc");
  });

  it("bearer and basic set the Authorization header", async () => {
    const r1 = recorder();
    await makeAuthorizedFetch(authFeed({ kind: "bearer", credential: "token" }), r1.fn, {
      XX_TEST_EVENTS_TOKEN: "tok",
    })("https://x/");
    expect(header(r1.calls[0]!.init, "Authorization")).toBe("Bearer tok");

    const r2 = recorder();
    await makeAuthorizedFetch(authFeed({ kind: "basic", user: "user", password: "pass" }), r2.fn, {
      XX_TEST_EVENTS_USER: "user",
      XX_TEST_EVENTS_PASS: "pass",
    })("https://x/");
    expect(header(r2.calls[0]!.init, "Authorization")).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
  });

  const pemEnv = {
    XX_TEST_EVENTS_CERT: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
    XX_TEST_EVENTS_KEY: "-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----",
  };

  it("mtls builds an undici Agent dispatcher and routes via undici's fetch (not the base fetch)", async () => {
    undiciFetchMock.mockReset();
    undiciFetchMock.mockResolvedValue(new Response("ok"));
    const { fn } = recorder();
    // Public IP literal so the (now guard-wrapped) fetch resolves it locally, no network.
    await makeAuthorizedFetch(
      authFeed({ kind: "mtls", cert: "cert", key: "key" }),
      fn,
      pemEnv,
    )("https://93.184.216.34/pull");
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    const init = undiciFetchMock.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init?.dispatcher).toBeDefined();
    // the injected base fetch (Node's global) must NOT be used for mtls
    expect(fn).not.toHaveBeenCalled();
  });

  it("mtls routes through the egress guard, rejecting a redirect to the metadata IP", async () => {
    undiciFetchMock.mockReset();
    undiciFetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );
    const authed = makeAuthorizedFetch(
      authFeed({ kind: "mtls", cert: "cert", key: "key" }),
      recorder().fn,
      pemEnv,
    );
    // Public IP literal so the guard's DNS check resolves it locally, no network.
    await expect(authed("http://93.184.216.34/")).rejects.toThrow(/internal\/private/);
  });

  it("throws when a required static secret is missing", () => {
    expect(() =>
      makeAuthorizedFetch(authFeed({ kind: "bearer", credential: "token" }), recorder().fn, {}),
    ).toThrow(/missing credential env var XX_TEST_EVENTS_TOKEN/);
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

    const feed = authFeed({
      kind: "oauth2-client-credentials",
      tokenUrl: "https://token/",
      clientId: "client_id",
      clientSecret: "client_secret",
    });
    const authed = makeAuthorizedFetch(
      feed,
      fn,
      { XX_TEST_EVENTS_CLIENT_ID: "id", XX_TEST_EVENTS_CLIENT_SECRET: "sec" },
      () => 1_000,
    );
    await authed("https://data/1");
    await authed("https://data/2");

    const tokenCalls = calls.filter((c) => c.url === "https://token/");
    expect(tokenCalls).toHaveLength(1); // cached: only one token request
    expect(String(tokenCalls[0]!.init?.body)).toContain("client_id=id");
    const dataCalls = calls.filter((c) => c.url.startsWith("https://data/"));
    expect(dataCalls).toHaveLength(2);
    expect(header(dataCalls[0]!.init, "Authorization")).toBe("Bearer AT");
    expect(header(dataCalls[1]!.init, "Authorization")).toBe("Bearer AT");
  });
});

describe("*_FILE convention (file-based secret delivery)", () => {
  function secretFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "oc-auth-"));
    const path = join(dir, "secret");
    writeFileSync(path, contents);
    return path;
  }

  const queryKey = authFeed({ kind: "query-key", param: "key", credential: "key" });
  const bearer = authFeed({ kind: "bearer", credential: "token" });

  it("hasCredentials is true when only <KEY>_FILE is set", () => {
    expect(hasCredentials(queryKey, {})).toBe(false);
    expect(hasCredentials(queryKey, { XX_TEST_EVENTS_KEY_FILE: secretFile("from-file") })).toBe(
      true,
    );
  });

  it("reads the secret value from <KEY>_FILE (trimmed)", async () => {
    const { fn, calls } = recorder();
    const authed = makeAuthorizedFetch(queryKey, fn, {
      XX_TEST_EVENTS_KEY_FILE: secretFile("file-secret\n"),
    });
    await authed("https://x/");
    expect(new URL(calls[0]!.url).searchParams.get("key")).toBe("file-secret");
  });

  it("an empty env var falls through to the file (no shadowing)", async () => {
    const { fn, calls } = recorder();
    const authed = makeAuthorizedFetch(bearer, fn, {
      XX_TEST_EVENTS_TOKEN: "  ",
      XX_TEST_EVENTS_TOKEN_FILE: secretFile("real"),
    });
    await authed("https://x/");
    expect(header(calls[0]!.init, "Authorization")).toBe("Bearer real");
  });

  it("a non-empty env var still wins over the file", async () => {
    const { fn, calls } = recorder();
    const authed = makeAuthorizedFetch(bearer, fn, {
      XX_TEST_EVENTS_TOKEN: "env-wins",
      XX_TEST_EVENTS_TOKEN_FILE: secretFile("file"),
    });
    await authed("https://x/");
    expect(header(calls[0]!.init, "Authorization")).toBe("Bearer env-wins");
  });
});
