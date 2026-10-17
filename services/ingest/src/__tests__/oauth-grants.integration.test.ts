import type { CatalogFeed } from "@openconditions/ingest-framework";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOAuthGrants, pgOAuthGrantStore } from "../oauth-grants.js";
import { runFeedAuthCommand } from "../ops/feed-auth.js";
import { repoFeed } from "./helpers/catalog.js";

/**
 * The OAuth2 grants in the database: two ingest processes that find the
 * access token expired together spend the refresh token once, a refused
 * refresh token stops the grant until a new login, and the operator's
 * commands store and report a grant without ever printing a token.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const KEY = "eumetsat";
const TOKEN_URL = "https://user.eumetsat.int/cas/oauth2.0/accessToken";

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

async function storeGrant(over: { accessExpiresAt?: number } = {}) {
  await sql`
    INSERT INTO conditions.oauth_grant
      (grant_key, refresh_token, refresh_issued_at, access_token, access_expires_at, updated_at)
    VALUES (${KEY}, 'refresh-1', ${new Date(NOW - HOUR)}, 'access-1',
            ${new Date(over.accessExpiresAt ?? NOW + 7 * HOUR)}, ${new Date(NOW - HOUR)})`;
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
    const process1 = createOAuthGrants(sql, () => NOW);
    const process2 = createOAuthGrants(other, () => NOW);
    const tokens = await Promise.all([
      process1.accessToken(grantRequest(endpoint.fn)),
      process2.accessToken(grantRequest(endpoint.fn)),
    ]);
    expect(tokens).toEqual(["access-2", "access-2"]);
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.get("refresh_token")).toBe("refresh-1");
    const [row] = await sql`SELECT refresh_token, access_token FROM conditions.oauth_grant`;
    expect(row).toEqual({ refresh_token: "refresh-2", access_token: "access-2" });
  });

  it("stops a grant whose refresh token is refused until it is logged in again", async () => {
    await storeGrant({ accessExpiresAt: NOW - 1 });
    const endpoint = tokenEndpoint({ status: 400, body: { error: "invalid_grant" } });
    const login = 'log in with "node dist/feed-auth.js login eumetsat" in the ingest container';
    await expect(
      createOAuthGrants(sql, () => NOW).accessToken(grantRequest(endpoint.fn)),
    ).rejects.toThrow(login);
    await expect(
      createOAuthGrants(other, () => NOW).accessToken(grantRequest(endpoint.fn)),
    ).rejects.toThrow(login);
    expect(endpoint.requests).toHaveLength(1);
    const [row] = await sql`
      SELECT refresh_token, access_token, rejected_at, last_error FROM conditions.oauth_grant`;
    expect(row).toEqual({
      refresh_token: "refresh-1",
      access_token: null,
      rejected_at: new Date(NOW),
      last_error: "HTTP 400 invalid_grant",
    });
  });
});

describe("feed-auth", () => {
  async function run(args: string[], answers: string[], fetchFn: typeof fetch) {
    const lines: string[] = [];
    const asked: { question: string; secret: boolean }[] = [];
    const code = await runFeedAuthCommand(args, {
      feeds: [feed()],
      grants: createOAuthGrants(sql, () => NOW),
      store: pgOAuthGrantStore(sql),
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
    const [row] = await sql`SELECT refresh_token, access_token FROM conditions.oauth_grant`;
    expect(row).toEqual({ refresh_token: "refresh-2", access_token: "access-2" });
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
      grants: createOAuthGrants(sql),
      store: pgOAuthGrantStore(sql),
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
    const [row] = await sql`SELECT refresh_token FROM conditions.oauth_grant`;
    expect(row).toEqual({ refresh_token: "refresh-2" });
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
