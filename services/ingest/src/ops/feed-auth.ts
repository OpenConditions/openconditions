import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  authorizationUrl,
  type CatalogFeed,
  type Env,
  feedGrantRequest,
  type GrantRequest,
  guardedFetch,
  guardOptionsFromEnv,
  type OAuthGrantStore,
  type OAuthGrants,
  oauthState,
  pastedAuthorization,
  pkcePair,
  requireCredential,
  type StoredGrant,
} from "@openconditions/ingest-framework";
import postgres from "postgres";
import { fetch as undiciFetch } from "undici";
import { loadIngestCatalog } from "../domains.js";
import { createOAuthGrants, pgOAuthGrantStore } from "../oauth-grants.js";

const USAGE = `usage: feed-auth login <grant>
       feed-auth import <grant>     (reads the refresh token from stdin)
       feed-auth status [<grant>...]`;

/** What the commands need: the grants, how to read them and the operator's terminal. */
export interface FeedAuthDeps {
  feeds: readonly CatalogFeed[];
  grants: OAuthGrants;
  store: Pick<OAuthGrantStore, "read">;
  /** The fetch token requests go through: the egress-guarded one in production. */
  fetch: typeof fetch;
  /** Asks the operator; a `secret` answer is not echoed. */
  ask: (question: string, opts: { secret: boolean }) => Promise<string>;
  out: (line: string) => void;
  env?: Env;
  now?: () => number;
}

/** Each grant the feeds read, with how it is obtained and the feeds that read it. */
function catalogGrants(
  feeds: readonly CatalogFeed[],
  fetchFn: typeof fetch,
  env: Env,
): Map<string, { request: GrantRequest; feeds: string[] }> {
  const grants = new Map<string, { request: GrantRequest; feeds: string[] }>();
  for (const feed of feeds) {
    const request = feedGrantRequest(feed, fetchFn, env);
    if (request === undefined) continue;
    const known = grants.get(request.key);
    if (known) known.feeds.push(feed.id);
    else grants.set(request.key, { request, feeds: [feed.id] });
  }
  return grants;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A span of milliseconds in its largest whole unit or two. */
function span(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** What `status` and the other commands say of a grant; never a token. */
function describe(
  key: string,
  grant: StoredGrant | undefined,
  request: GrantRequest | undefined,
  feeds: readonly string[],
  now: number,
): string[] {
  const lines = [
    `grant ${key}${feeds.length > 0 ? ` (feeds: ${feeds.join(", ")})` : " (read by no feed)"}`,
  ];
  if (grant === undefined) {
    lines.push("  no login stored");
    return lines;
  }
  if (grant.rejectedAt !== null) {
    lines.push(`  refused by the provider at ${iso(grant.rejectedAt)}: log in again`);
  }
  if (grant.accessToken !== null && grant.accessExpiresAt !== null) {
    const left = grant.accessExpiresAt - now;
    lines.push(
      `  access token ${left > 0 ? `valid until ${iso(grant.accessExpiresAt)} (${span(left)} left)` : `expired at ${iso(grant.accessExpiresAt)}`}`,
    );
  } else {
    lines.push("  no access token held");
  }
  const age = now - grant.refreshIssuedAt;
  const ttlSec = request?.auth.refreshTokenTtlSec;
  lines.push(
    `  refresh token issued ${iso(grant.refreshIssuedAt)} (${span(age)} ago${ttlSec ? `, honoured until ${iso(grant.refreshIssuedAt + ttlSec * 1000)}` : ""})`,
  );
  if (grant.lastError !== null && grant.lastErrorAt !== null) {
    lines.push(`  last error at ${iso(grant.lastErrorAt)}: ${grant.lastError}`);
  }
  return lines;
}

/**
 * The operator's commands for the OAuth2 grants feeds read
 * (`oauth2-authorization-code` auth):
 *  - `login <grant>` prints the provider's login URL, asks for the
 *    authorization code the provider shows after the login and exchanges it
 *    at once (the code lapses within minutes), replacing any stored grant;
 *  - `import <grant>` reads a refresh token obtained elsewhere from stdin and
 *    stores the grant after spending it on one refresh, which proves it;
 *  - `status [<grant>...]` shows each grant's state, never a token.
 * Returns the process exit code.
 */
export async function runFeedAuthCommand(
  args: readonly string[],
  deps: FeedAuthDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const known = catalogGrants(deps.feeds, deps.fetch, env);
  const [command, ...names] = args;

  if (command === "status") {
    const keys = names.length > 0 ? names : [...known.keys()];
    if (keys.length === 0) deps.out("no feed reads an OAuth2 grant");
    for (const key of keys) {
      const entry = known.get(key);
      for (const line of describe(
        key,
        await deps.store.read(key),
        entry?.request,
        entry?.feeds ?? [],
        now(),
      )) {
        deps.out(line);
      }
    }
    return 0;
  }

  if ((command === "login" || command === "import") && names.length === 1) {
    const key = names[0] as string;
    const entry = known.get(key);
    if (!entry) {
      const listed = [...known.keys()];
      deps.out(
        `no feed reads an OAuth2 grant named ${key}${listed.length > 0 ? `; the grants are: ${listed.join(", ")}` : ""}`,
      );
      return 1;
    }
    let grant: StoredGrant;
    if (command === "login") {
      const { verifier, challenge } = pkcePair();
      const state = oauthState();
      deps.out("Open this URL in a browser, log in, and paste the authorization code shown:");
      deps.out(authorizationUrl(entry.request.auth, entry.request.clientId, state, challenge));
      const pasted = pastedAuthorization(await deps.ask("Authorization code: ", { secret: false }));
      if (pasted === undefined) {
        deps.out("no authorization code given");
        return 1;
      }
      if (pasted.state !== undefined && pasted.state !== state) {
        deps.out("the pasted redirect belongs to another login: start again");
        return 1;
      }
      grant = await deps.grants.login(entry.request, pasted.code, verifier);
    } else {
      const token = (await deps.ask("Refresh token: ", { secret: true })).trim();
      if (token === "" || /\s/.test(token)) {
        deps.out("no refresh token on stdin");
        return 1;
      }
      grant = await deps.grants.import(entry.request, token);
    }
    deps.out(`stored ${key}`);
    for (const line of describe(key, grant, entry.request, entry.feeds, now()).slice(1)) {
      deps.out(line);
    }
    return 0;
  }

  deps.out(USAGE);
  return 2;
}

/**
 * Reads one answer from stdin. On a terminal the question is shown and a
 * secret answer is not echoed; from a pipe the first line is the answer.
 */
async function ask(question: string, opts: { secret: boolean }): Promise<string> {
  const tty = process.stdin.isTTY === true;
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: tty });
  try {
    const answer = rl.question(question);
    muted = opts.secret && tty;
    return await answer;
  } finally {
    muted = false;
    if (opts.secret && tty) process.stderr.write("\n");
    rl.close();
  }
}

async function main(): Promise<void> {
  const sql = postgres(requireCredential(process.env, "DATABASE_URL"), { max: 1 });
  try {
    const catalog = await loadIngestCatalog();
    process.exitCode = await runFeedAuthCommand(process.argv.slice(2), {
      feeds: [...catalog.feeds, ...catalog.disabled],
      grants: createOAuthGrants(sql),
      store: pgOAuthGrantStore(sql),
      fetch: guardedFetch(undiciFetch as unknown as typeof fetch, guardOptionsFromEnv()),
      ask,
      out: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
