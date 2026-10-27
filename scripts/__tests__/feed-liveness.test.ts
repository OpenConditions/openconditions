import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const moduleUrl = new URL("../run-feed-liveness.mjs", import.meta.url).href;
const checkerUrl = new URL("../feeds-check.ts", import.meta.url).href;
const require = createRequire(import.meta.url);
const tsx = join(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
type RequestRow = { method: string; path: string; body: Record<string, unknown> | null };
const legacy =
  "Automated feed-liveness check found 1 failing feed(s).\n\nEach feed below could not be fetched or did not parse.\n\nKeep these original diagnostics and @maintainer provenance.\n";

async function fixture(mode = "healthy", existing = "none", previousBody?: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oc-liveness-")));
  cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
  const requests: RequestRow[] = [];
  const bot = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
  let issue =
    existing === "none"
      ? null
      : {
          id: 900,
          node_id: "I_900",
          number: 99,
          state: "open",
          title: "Keyless feed liveness check found failing feeds",
          user: existing === "human" ? { id: 99, login: "person", type: "User" } : bot,
          body: previousBody ?? legacy,
          updated_at: "2026-10-27T05:00:00Z",
        };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const row = {
      method: req.method ?? "GET",
      path: req.url ?? "",
      body: text ? JSON.parse(text) : null,
    };
    requests.push(row);
    const pathname = new URL(row.path, "http://localhost").pathname;
    let status = 200;
    let body: unknown = {};
    if (pathname.startsWith("/feed/")) {
      if (
        [
          "provider-warning",
          "api-failure",
          "lost-response",
          "missing-label",
          "wrong-api-repository",
        ].includes(mode)
      ) {
        status = 503;
        body = {};
      } else if (mode === "parse-error") {
        res.writeHead(200);
        res.end("<<< broken provider payload >>>");
        return;
      } else
        body = {
          type: "FeatureCollection",
          features:
            mode === "empty-warning"
              ? []
              : [
                  {
                    type: "Feature",
                    id: "one",
                    geometry: { type: "Point", coordinates: [6.13, 49.61] },
                    properties: { id: "one", headline: "Roadworks" },
                  },
                ],
        };
    } else if (pathname === "/repos/OpenConditions/openconditions")
      body = {
        id: mode === "wrong-api-repository" ? 1 : 1276024943,
        full_name: "OpenConditions/openconditions",
        default_branch: "main",
      };
    else if (pathname.endsWith("/labels"))
      body = mode === "missing-label" ? [] : [{ id: 300, name: "feed" }];
    else if (pathname.endsWith("/issues") && row.method === "GET") body = issue ? [issue] : [];
    else if (pathname.endsWith("/issues/99") && row.method === "GET") body = issue;
    else if (row.method === "POST" || row.method === "PATCH") {
      if (mode === "api-failure") {
        status = 503;
        body = {};
      } else {
        issue = {
          id: 900,
          node_id: "I_900",
          number: 99,
          state: "open",
          title: "Keyless feed liveness check found failing feeds",
          user: bot,
          body: String(row.body?.body),
          updated_at: "2026-10-27T05:01:00Z",
        };
        if (mode === "lost-response") {
          req.socket.destroy();
          return;
        }
        body = issue;
      }
    } else {
      status = 404;
      body = {};
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  mkdirSync(join(dir, "feeds/roads"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "bin"));
  const one = {
    operator: "test",
    product: "events",
    name: "Test feed",
    homepage: "https://example.org/",
    tier: "authoritative",
    format: "geojson",
    endpoints: { main: { url: "https://provider.example.org/feed/good", cadenceSec: 300 } },
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "fixture",
    privacyUrl: "https://example.org/privacy",
  };
  const keyed = {
    ...one,
    operator: "keyed",
    endpoints: { main: { url: "https://provider.example.org/feed/keyed", cadenceSec: 300 } },
    credentials: { api_key: { title: "Key" } },
    auth: { kind: "query-key", param: "key", credential: "api_key" },
  };
  writeFileSync(
    join(dir, "feeds/roads/lu.jsonc"),
    mode === "catalogue-error"
      ? "{invalid"
      : JSON.stringify({
          $schema: "../schema/roads.schema.json",
          maintainers: [{ name: "Ada", github: "ada" }],
          feeds: [one, keyed],
        }),
  );
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  const mutation =
    mode === "partial"
      ? "x.coverage.completed=0;x.results=[];"
      : mode === "wrong-source"
        ? "x.context.sourceSha='b'.repeat(40);"
        : mode === "wrong-run"
          ? "x.context.runId='999';"
          : mode === "wrong-attempt"
            ? "x.context.runAttempt='9';"
            : mode === "wrong-hash"
              ? "x.reportSha256='b'.repeat(64);"
              : "";
  writeFileSync(
    join(dir, "scripts/feeds-check.ts"),
    `import {runFeedsCheck} from ${JSON.stringify(checkerUrl)};import{readFileSync,writeFileSync,mkdirSync}from'node:fs';
if(${JSON.stringify(mode)}==='checker-crash')process.exit(1);
if(${JSON.stringify(mode)}==='report-generation')mkdirSync('liveness/out.md');
const testFetch=(input,init)=>{const u=new URL(String(input));if(u.hostname!=='provider.example.org')throw Error('unexpected fixture provider');return globalThis.fetch(${JSON.stringify(origin)}+u.pathname+u.search,init)};
const code=await runFeedsCheck(process.argv.slice(2),{feedsDir:${JSON.stringify(join(dir, "feeds"))},fetch:testFetch,env:process.env});
${mutation ? `const x=JSON.parse(readFileSync('liveness/check.json','utf8'));${mutation}writeFileSync('liveness/check.json',JSON.stringify(x));` : ""}
process.exitCode=code;`,
  );
  const shim = join(dir, "bin/pnpm");
  writeFileSync(
    shim,
    `#!${process.execPath}\nimport{appendFileSync}from'node:fs';import{spawn}from'node:child_process';const a=process.argv.slice(2);appendFileSync('commands.jsonl',JSON.stringify(a)+'\\n');
if(process.env.GITHUB_TOKEN||process.env.GH_TOKEN)throw Error('writer token reached provider child');
if(a[0]==='install')process.exit(${mode === "install-error" ? 1 : 0});
if(a[0]==='build:domains')process.exit(${mode === "build-error" ? 1 : 0});
const c=spawn(process.execPath,[${JSON.stringify(tsx)},'scripts/feeds-check.ts',...a.slice(3)],{stdio:'inherit',env:process.env});c.on('exit',code=>process.exit(code??1));`,
  );
  chmodSync(shim, 0o755);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  git(["init", "-q"]);
  git(["add", "package.json", "feeds", "scripts"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const sha = git(["rev-parse", "HEAD"]);
  if (mode === "stale-output") mkdirSync(join(dir, "liveness"));
  if (mode === "summary-error") mkdirSync(join(dir, "summary-directory"));
  const env = {
    PATH: [join(dir, "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    GITHUB_REPOSITORY: "OpenConditions/openconditions",
    GITHUB_REPOSITORY_ID: "1276024943",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF:
      "OpenConditions/openconditions/.github/workflows/feed-liveness.yml@refs/heads/main",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_EVENT_NAME: "schedule",
    ...(mode === "summary-error" ? { GITHUB_STEP_SUMMARY: join(dir, "summary-directory") } : {}),
    GITHUB_TOKEN: "fixture-token",
    LU_KEYED_EVENTS_API_KEY: "NEVER_RECORD_THIS_KEY",
  };
  if (mode === "wrong-authority") env.GITHUB_REPOSITORY_ID = "1";
  if (mode === "wrong-ref") env.GITHUB_REF = "refs/heads/topic";
  if (mode === "dirty-source") writeFileSync(join(dir, "package.json"), '{"type":"module"}\n\n');
  const transport = join(dir, "api-fixture.mjs");
  writeFileSync(
    transport,
    `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(String(input));if(u.origin!=='https://api.github.com')throw Error('unexpected fixture API origin');return realFetch(${JSON.stringify(origin)}+u.pathname+u.search,init)};`,
  );
  const child = spawn(process.execPath, ["--import", transport, fileURLToPath(moduleUrl)], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (x) => {
    output += x;
  });
  child.stderr.on("data", (x) => {
    output += x;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const result = () => JSON.parse(readFileSync(join(dir, "liveness/execution.json"), "utf8"));
  return { code, dir, sha, requests, result, output, issue: () => issue };
}
const writes = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.requests.filter((x) => x.method !== "GET" && !x.path.startsWith("/feed/"));

test("healthy complete keyless run records scope/provenance and never changes issues", async () => {
  const f = await fixture();
  expect(f.code, f.output).toBe(0);
  expect(writes(f)).toHaveLength(0);
  expect(f.result()).toMatchObject({
    complete: true,
    context: { sourceSha: f.sha, runId: "123", runAttempt: "2" },
    checker: {
      providerOutcome: "healthy",
      recoveryReview: true,
      coverage: { planned: 2, completed: 2, checked: 1, skipped: { keyed: 1 } },
    },
  });
  expect(f.requests.some((x) => x.path.includes("/feed/keyed"))).toBe(false);
  expect(readFileSync(join(f.dir, "liveness/check.json"), "utf8")).not.toContain(
    "NEVER_RECORD_THIS_KEY",
  );
});
test.each([
  "install-error",
  "build-error",
  "catalogue-error",
  "checker-crash",
  "report-generation",
  "partial",
  "wrong-source",
  "wrong-run",
  "wrong-attempt",
  "wrong-hash",
])("%s cannot become a successful empty selection or public report", async (mode) => {
  const f = await fixture(mode);
  expect(f.code, f.output).toBe(1);
  expect(f.result().complete).toBe(false);
  expect(writes(f)).toHaveLength(0);
  expect(f.result().stage).toBe(
    mode === "install-error"
      ? "install"
      : mode === "build-error"
        ? "build"
        : mode === "checker-crash"
          ? "checker"
          : "validation",
  );
  if (!["install-error", "build-error", "catalogue-error", "checker-crash"].includes(mode))
    expect(f.requests.some((x) => x.path === "/feed/good")).toBe(true);
});
test.each(["provider-warning", "parse-error"])(
  "%s publishes bound diagnostics with its original gate semantics",
  async (mode) => {
    const f = await fixture(mode);
    expect(f.code, f.output).toBe(mode === "provider-warning" ? 0 : 1);
    expect(f.result()).toMatchObject({
      complete: true,
      checker: { providerOutcome: "unhealthy" },
      reporting: { success: true },
    });
    expect(writes(f)).toHaveLength(1);
    expect(writes(f)[0].body).toMatchObject({
      title: "Keyless feed liveness check found failing feeds",
      labels: ["feed"],
    });
    expect(f.issue()?.body).toContain(f.sha);
    expect(f.issue()?.body).toContain("@ada");
  },
);
test("refreshes only bot report content while retaining the original diagnostic bytes", async () => {
  const f = await fixture("provider-warning", "bot");
  expect(f.code, f.output).toBe(0);
  expect(writes(f).map((x) => x.method)).toEqual(["PATCH"]);
  expect(Object.keys(writes(f)[0].body ?? {})).toEqual(["body"]);
  expect(f.issue()?.body.endsWith(legacy)).toBe(true);
  expect(f.issue()?.state).toBe("open");
});
test.each(["api-failure", "lost-response"])(
  "report %s fails visibly without retrying writes",
  async (mode) => {
    // Valid provider warning forces the reporting path; the server failure is separate.
    const f = await fixture(mode);
    expect(f.code, f.output).toBe(1);
    expect(writes(f)).toHaveLength(1);
    expect(f.result().complete).toBe(false);
  },
);
test("does not overwrite or reopen a human issue with a matching report title", async () => {
  const f = await fixture("provider-warning", "human");
  expect(f.code, f.output).toBe(1);
  expect(writes(f)).toHaveLength(0);
  expect(f.issue()?.body).toBe(legacy);
});
test("missing target taxonomy blocks reporting rather than creating a label", async () => {
  const f = await fixture("missing-label");
  expect(f.code, f.output).toBe(1);
  expect(writes(f)).toHaveLength(0);
});
test("stale output directory is never treated as evidence from this run", async () => {
  const f = await fixture("stale-output");
  expect(f.code, f.output).toBe(1);
  expect(writes(f)).toHaveLength(0);
  expect(existsSync(join(f.dir, "liveness/execution.json"))).toBe(false);
});

test("literal inline markers in old diagnostic text are data, not managed boundaries", async () => {
  const previous =
    legacy +
    "\n- Error: <!-- openconditions:feed-liveness:managed:start --> inline <!-- openconditions:feed-liveness:managed:end -->\n";
  const f = await fixture("provider-warning", "bot", previous);
  expect(f.code, f.output).toBe(0);
  expect(f.issue()?.body.endsWith(previous)).toBe(true);
});

test("managed refresh preserves outside human notes and refuses edited diagnostics", async () => {
  const first = await fixture("provider-warning");
  expect(first.code, first.output).toBe(0);
  const body = first.issue()?.body;
  if (!body) throw new Error("missing first report");
  const notes = `Human note before\n${body}\nHuman note after`;
  const next = await fixture("provider-warning", "bot", notes);
  expect(next.code, next.output).toBe(0);
  expect(next.issue()?.body.startsWith("Human note before\n")).toBe(true);
  expect(next.issue()?.body.endsWith("\nHuman note after")).toBe(true);
  const edited = await fixture(
    "provider-warning",
    "bot",
    body.replace("Coverage:", "Human edited coverage:"),
  );
  expect(edited.code, edited.output).toBe(1);
  expect(writes(edited)).toHaveLength(0);
});

test("API repository identity cannot be replaced by a self-reported receipt", async () => {
  const f = await fixture("wrong-api-repository");
  expect(f.code, f.output).toBe(1);
  expect(f.result().stage).toBe("report");
  expect(f.result().checker.complete).toBe(true);
  expect(writes(f)).toHaveLength(0);
});

test("job summary failure is retained as incomplete execution rather than a healthy receipt", async () => {
  const f = await fixture("summary-error");
  expect(f.code, f.output).toBe(1);
  expect(f.result().complete).toBe(false);
  expect(f.result().stage).toBe("summary");
  expect(writes(f)).toHaveLength(0);
});

test("a well-formed empty provider response remains a warning without inventing a fetch failure", async () => {
  const f = await fixture("empty-warning");
  expect(f.code, f.output).toBe(0);
  expect(f.result().checker.outcomes).toMatchObject({ warning: 1, error: 0 });
  expect(f.issue()?.body).toContain("parsed 0 records from a well-formed payload");
  expect(f.issue()?.body).not.toContain("- Failure: fetch (network or HTTP)");
});

test.each(["wrong-authority", "wrong-ref", "dirty-source"])(
  "%s cannot build, fetch or report under another source identity",
  async (mode) => {
    const f = await fixture(mode);
    expect(f.code, f.output).toBe(1);
    expect(f.requests).toHaveLength(0);
    expect(existsSync(join(f.dir, "commands.jsonl"))).toBe(false);
    expect(existsSync(join(f.dir, "liveness"))).toBe(false);
  },
);
