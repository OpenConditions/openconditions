import { SecretsKey } from "@openconditions/core/server";
import type { CatalogFeed, StoredGrant } from "@openconditions/ingest-framework";
import {
  createTestDatabase,
  dumpHolds,
  dumpTable,
  TEST_SECRETS_KEY,
  type TestDatabase,
} from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertGrantsOpen, createOAuthGrants, pgOAuthGrantStore } from "../oauth-grants.js";
import { runFeedAuthCommand } from "../ops/feed-auth.js";
import { repoFeed } from "./helpers/catalog.js";

/**
 * The OAuth2 grants in the database: two ingest processes that find the
 * access token expired together spend the refresh token once, a refused
 * refresh token stops the grant until a new login, and the operator's
 * commands store and report a grant without ever printing a token. The
 * tokens are stored sealed with the secrets key, never in clear.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const KEY = "eumetsat";
const TOKEN_URL = "https://user.eumetsat.int/cas/oauth2.0/accessToken";
const secrets = SecretsKey.parse(TEST_SECRETS_KEY);
const OTHER_KEY = SecretsKey.parse("ab".repeat(32));

let db: TestDatabase;
let sql: postgres.Sql;
/** A second pool, as another ingest process holds. */
let other: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  other = postgres(db.url, { max: 2 });
}, 120_000);

afterAll(async () => {
  await other?.end();
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.oauth_grant`;
});

/** EUMETSAT's token endpoint: rotates the refresh token on every answer, slowly, or answers `status`. */
function tokenEndpoint(answer: { status?: number; body?: unknown } = {}) {
  const requests: URLSearchParams[] = [];
  let issued = 1;
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== TOKEN_URL) throw new Error(`unexpected request ${String(input)}`);
    requests.push(new URLSearchParams(String(init?.body)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (answer.status !== undefined) {
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    }
    issued++;
    return new Response(
      JSON.stringify({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        expires_in: 28800,
        token_type: "Bearer",
      }),
    );
  }) as typeof fetch;
  return { fn, requests };
}

function grant(over: Partial<StoredGrant> = {}): StoredGrant {
  return {
    refreshToken: "refresh-1",
    refreshIssuedAt: NOW - HOUR,
    accessToken: "access-1",
    accessExpiresAt: NOW + 7 * HOUR,
    rejectedAt: null,
    lastError: null,
    lastErrorAt: null,
    updatedAt: NOW - HOUR,
    ...over,
  };
}

async function storeGrant(over: Partial<StoredGrant> = {}, key = KEY) {
  await pgOAuthGrantStore(sql, secrets).locked(key, (_stored, write) => write(grant(over)));
}

/** The grant's tokens as the store reads them. */
async function storedTokens(store = pgOAuthGrantStore(sql, secrets)) {
  const stored = await store.read(KEY);
  return { refresh_token: stored?.refreshToken, access_token: stored?.accessToken };
}

const feed = () => repoFeed("eumetsat-slstr-fires") as CatalogFeed;

function grantRequest(fetchFn: typeof fetch) {
  const auth = feed().auth;
  if (auth?.kind !== "oauth2-authorization-code") throw new Error("not a grant feed");
  return { key: KEY, auth, clientId: "api-public-auth-code", fetch: fetchFn };
}

describe("the grants in conditions.oauth_grant", () => {
  it("is refreshed once by two processes that find the access token expired together", async () => {
    await storeGrant({ accessExpiresAt: NOW - 1 });
    const endpoint = tokenEndpoint();
    const process1 = createOAuthGrants(sql, secrets, () => NOW);
    const process2 = createOAuthGrants(other, secrets, () => NOW);
    const tokens = await Promise.all([
      process1.accessToken(grantRequest(endpoint.fn)),
      process2.accessToken(grantRequest(endpoint.fn)),
    ]);
    expect(tokens).toEqual(["access-2", "access-2"]);
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.get("refresh_token")).toBe("refresh-1");
    expect(await storedTokens()).toEqual({ refresh_token: "refresh-2", access_token: "access-2" });
  });

  it("persists the rotated refresh token sealed, never in clear", async () => {
    await storeGrant({ accessExpiresAt: NOW - 1 });
    const endpoint = tokenEndpoint();
    await createOAuthGrants(sql, secrets, () => NOW).accessToken(grantRequest(endpoint.fn));
    const dump = await dumpTable(sql, "oauth_grant");
    for (const token of ["refresh-1", "refresh-2", "access-1", "access-2"]) {
      expect(dumpHolds(dump, token)).toBe(false);
    }
    const [row] = await sql`
      SELECT octet_length(refresh_token_iv) AS iv, octet_length(refresh_token_tag) AS tag,
             octet_length(access_token_iv) AS access_iv
      FROM conditions.oauth_grant`;
    expect(row).toEqual({ iv: 12, tag: 16, access_iv: 12 });
    expect(await storedTokens()).toEqual({ refresh_token: "refresh-2", access_token: "access-2" });
  });

  it("reads the tokens back after a restart: a new pool and the key read anew", async () => {
    await storeGrant();
    const restarted = postgres(db.url, { max: 1 });
    try {
      const store = pgOAuthGrantStore(restarted, SecretsKey.parse(TEST_SECRETS_KEY));
      expect(await storedTokens(store)).toEqual({
        refresh_token: "refresh-1",
        access_token: "access-1",
      });
    } finally {
      await restarted.end();
    }
  });

  it("stores a grant with no access token as nulls, and reads it back so", async () => {
    await storeGrant({ accessToken: null, accessExpiresAt: null });
    const [row] = await sql`
      SELECT access_token_ciphertext, access_token_iv, access_token_tag FROM conditions.oauth_grant`;
    expect(row).toEqual({
      access_token_ciphertext: null,
      access_token_iv: null,
      access_token_tag: null,
    });
    expect(await storedTokens()).toEqual({ refresh_token: "refresh-1", access_token: null });
  });

  it("refuses at start a key that cannot open the stored grants, naming the grant", async () => {
    await storeGrant();
    await expect(assertGrantsOpen(sql, secrets)).resolves.toBeUndefined();
    const failure = assertGrantsOpen(sql, OTHER_KEY);
    await expect(failure).rejects.toThrow(
      /^wrong key: OPENCONDITIONS_SECRETS_KEY cannot decrypt conditions\.oauth_grant\.refresh_token of the row eumetsat/,
    );
    await expect(failure).rejects.not.toThrow(/refresh-1|access-1/);
  });

  it("does not open a token copied into another grant's row", async () => {
    await storeGrant();
    await storeGrant({ refreshToken: "refresh-acme", accessToken: null }, "acme");
    await sql`
      UPDATE conditions.oauth_grant AS acme SET
        refresh_token_ciphertext = e.refresh_token_ciphertext,
        refresh_token_iv = e.refresh_token_iv,
        refresh_token_tag = e.refresh_token_tag
      FROM conditions.oauth_grant AS e
      WHERE acme.grant_key = 'acme' AND e.grant_key = ${KEY}`;
    await expect(pgOAuthGrantStore(sql, secrets).read("acme")).rejects.toThrow(
      /wrong key: .*conditions\.oauth_grant\.refresh_token of the row acme/,
    );
    await expect(assertGrantsOpen(sql, secrets)).rejects.toThrow(/of the row acme/);
  });

  it("does not open an access token copied into the refresh token's columns", async () => {
    await storeGrant();
    await sql`
      UPDATE conditions.oauth_grant SET
        refresh_token_ciphertext = access_token_ciphertext,
        refresh_token_iv = access_token_iv,
        refresh_token_tag = access_token_tag`;
    await expect(pgOAuthGrantStore(sql, secrets).read(KEY)).rejects.toThrow(
      /wrong key: .*conditions\.oauth_grant\.refresh_token of the row eumetsat/,
    );
  });

  it("refuses an IV or tag of the wrong length, or a token stored only in part", async () => {
    const value = Buffer.alloc(16);
    await expect(
      sql`
        INSERT INTO conditions.oauth_grant
          (grant_key, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
           refresh_issued_at)
        VALUES ('short', ${value}, ${Buffer.alloc(11)}, ${value}, now())`,
    ).rejects.toThrow(/oauth_grant_refresh_token_check/);
    await expect(
      sql`
        INSERT INTO conditions.oauth_grant
          (grant_key, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
           refresh_issued_at, access_token_ciphertext)
        VALUES ('partial', ${value}, ${Buffer.alloc(12)}, ${value}, now(), ${value})`,
    ).rejects.toThrow(/oauth_grant_access_token_check/);
  });

  it("stops a grant whose refresh token is refused until it is logged in again", async () => {
    await storeGrant({ accessExpiresAt: NOW - 1 });
    const endpoint = tokenEndpoint({ status: 400, body: { error: "invalid_grant" } });
    const login = 'log in with "node dist/feed-auth.js login eumetsat" in the ingest container';
    await expect(
      createOAuthGrants(sql, secrets, () => NOW).accessToken(grantRequest(endpoint.fn)),
    ).rejects.toThrow(login);
    await expect(
      createOAuthGrants(other, secrets, () => NOW).accessToken(grantRequest(endpoint.fn)),
    ).rejects.toThrow(login);
    expect(endpoint.requests).toHaveLength(1);
    expect(await storedTokens()).toEqual({ refresh_token: "refresh-1", access_token: null });
    const [row] = await sql`SELECT rejected_at, last_error FROM conditions.oauth_grant`;
    expect(row).toEqual({ rejected_at: new Date(NOW), last_error: "HTTP 400 invalid_grant" });
  });
});

describe("feed-auth", () => {
  async function run(args: string[], answers: string[], fetchFn: typeof fetch) {
    const lines: string[] = [];
    const asked: { question: string; secret: boolean }[] = [];
    const code = await runFeedAuthCommand(args, {
      feeds: [feed()],
      grants: createOAuthGrants(sql, secrets, () => NOW),
      store: pgOAuthGrantStore(sql, secrets),
      fetch: fetchFn,
      ask: async (question, opts) => {
        asked.push({ question, secret: opts.secret });
        return answers.shift() ?? "";
      },
      out: (line) => lines.push(line),
      now: () => NOW,
    });
    return { code, lines, asked };
  }

  it("status names a grant no login was stored for", async () => {
    const { code, lines } = await run(["status"], [], tokenEndpoint().fn);
    expect(code).toBe(0);
    expect(lines).toEqual(["grant eumetsat (feeds: eumetsat-slstr-fires)", "  no login stored"]);
  });

  it("import reads the refresh token unechoed, spends it once and stores the rotated one", async () => {
    const endpoint = tokenEndpoint();
    const { code, lines, asked } = await run(["import", KEY], ["refresh-elsewhere\n"], endpoint.fn);
    expect(code).toBe(0);
    expect(asked).toEqual([{ question: "Refresh token: ", secret: true }]);
    expect(Object.fromEntries(endpoint.requests[0]!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-elsewhere",
      client_id: "api-public-auth-code",
    });
    expect(await storedTokens()).toEqual({ refresh_token: "refresh-2", access_token: "access-2" });
    expect(dumpHolds(await dumpTable(sql, "oauth_grant"), "refresh-2")).toBe(false);
    expect(lines[0]).toBe("stored eumetsat");
    expect(lines.join("\n")).toMatch(/access token valid until .* \(8 h 0 min left\)/);
    expect(lines.join("\n")).not.toMatch(/refresh-|access-\d/);

    const status = await run(["status", KEY], [], endpoint.fn);
    expect(status.lines[0]).toBe("grant eumetsat (feeds: eumetsat-slstr-fires)");
    expect(status.lines.join("\n")).toMatch(/refresh token issued .* honoured until /);
    expect(status.lines.join("\n")).not.toMatch(/refresh-|access-\d/);
  });

  it("login prints the authorization URL and exchanges the pasted code with its verifier", async () => {
    const endpoint = tokenEndpoint();
    let state = "";
    const lines: string[] = [];
    const code = await runFeedAuthCommand(["login", KEY], {
      feeds: [feed()],
      grants: createOAuthGrants(sql, secrets),
      store: pgOAuthGrantStore(sql, secrets),
      fetch: endpoint.fn,
      ask: async () => `https://api.eumetsat.int/cli#code=OC-42&state=${state}`,
      out: (line) => {
        lines.push(line);
        if (line.startsWith("https://")) state = new URL(line).searchParams.get("state") ?? "";
      },
    });
    expect(code).toBe(0);
    const url = new URL(lines[1]!);
    expect(url.origin + url.pathname).toBe("https://user.eumetsat.int/cas/oidc/oidcAuthorize");
    expect(url.searchParams.get("client_id")).toBe("api-public-auth-code");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.eumetsat.int/cli");
    expect(url.searchParams.get("response_mode")).toBe("fragment");
    const sent = endpoint.requests[0]!;
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("OC-42");
    expect(sent.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect((await storedTokens()).refresh_token).toBe("refresh-2");
  });

  it("refuses a pasted redirect of another login, and an unknown grant", async () => {
    const endpoint = tokenEndpoint();
    const stale = await run(
      ["login", KEY],
      ["https://api.eumetsat.int/cli#code=OC-1&state=someone-else"],
      endpoint.fn,
    );
    expect(stale.code).toBe(1);
    expect(stale.lines.at(-1)).toBe("the pasted redirect belongs to another login: start again");
    const unknown = await run(["login", "acme"], [], endpoint.fn);
    expect(unknown.code).toBe(1);
    expect(unknown.lines).toEqual([
      "no feed reads an OAuth2 grant named acme; the grants are: eumetsat",
    ]);
    expect(endpoint.requests).toEqual([]);
  });
});
