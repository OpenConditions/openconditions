import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = "OpenConditions/openconditions";
const sha = "a".repeat(40);
const other = "b".repeat(40);
const prefix = `/repos/${repo}`;
const wallClock = Date.parse("2026-10-26T12:00:00Z");
const sourceCommit = {
  sha,
  committer: { login: "web-flow" },
  commit: {
    committer: { date: "2026-10-26T11:00:00Z" },
    verification: { verified: true, reason: "valid" },
  },
};
const coverage = [
  "validate CI source",
  "typecheck / test",
  "python lint / test (openlr-resolver)",
  "interop (libtraff, python-tuf)",
  "production dependency audit",
  "required CI",
  "full main qualification",
];
type Row = Record<string, unknown>;
function run(overrides: Row = {}): Row {
  return {
    id: 11,
    workflow_id: 7,
    path: ".github/workflows/ci.yml",
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    display_title: "push main",
    repository: { id: 1, full_name: repo },
    head_repository: { id: 1, full_name: repo },
    actor: { login: "maintainer" },
    ...overrides,
  };
}
function jobs(attempt = 1, runId = 11): Row[] {
  return coverage.map((name, i) => ({
    id: i + 1,
    run_id: runId,
    run_attempt: attempt,
    head_sha: sha,
    name,
    status: "completed",
    conclusion: "success",
  }));
}
interface Fixture {
  commit?: Row;
  wallClock?: number;
  runs?: Row[];
  jobs?: Row[];
  detail?: Row;
  branch?: string;
  dispatchStatus?: number;
  readback?: Row;
  advance?: boolean;
  transient?: number;
  alwaysTransient?: boolean;
  denied?: boolean;
  wrongWorkflow?: boolean;
  changedAttempt?: boolean;
  paginated?: boolean;
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

// A real child process drives the production HTTP adapter against a stateful API
// fixture; assertions observe requests and retained run records across invocations.
async function fixture(options: Fixture = {}) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const state = [...(options.runs ?? [])];
  let refs = 0;
  let transients = options.transient ?? 0;
  let detailReads = 0;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const url = new URL(req.url!, "http://localhost");
    const body: unknown = text ? JSON.parse(text) : null;
    requests.push({ method: req.method!, path: req.url!, body });
    res.setHeader("content-type", "application/json");
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (
      req.headers.authorization !== "Bearer fixture-token" ||
      req.headers["x-github-api-version"] !== "2026-03-10"
    )
      return send({}, 401);
    if (options.alwaysTransient || transients-- > 0) return send({}, 503);
    if (options.denied) return send({}, 403);
    if (url.pathname === prefix)
      return send({ id: 1, full_name: repo, default_branch: options.branch ?? "main" });
    if (url.pathname === `${prefix}/git/ref/heads/main`)
      return send({
        ref: "refs/heads/main",
        object: { type: "commit", sha: options.advance && refs++ > 0 ? other : sha },
      });
    if (url.pathname === `${prefix}/commits/${sha}`) return send(options.commit ?? sourceCommit);
    if (url.pathname === `${prefix}/actions/workflows/ci.yml`)
      return send({
        id: 7,
        name: "CI",
        path: options.wrongWorkflow ? ".github/workflows/evil.yml" : ".github/workflows/ci.yml",
        state: "active",
      });
    if (url.pathname === `${prefix}/actions/workflows/7/runs`) {
      if (url.searchParams.get("head_sha") !== sha) return send({}, 400);
      const page = Number(url.searchParams.get("page") ?? 1);
      return send({
        total_count: state.length,
        workflow_runs: options.paginated ? state.slice((page - 1) * 100, page * 100) : state,
      });
    }
    if (url.pathname === `${prefix}/actions/workflows/7/dispatches` && req.method === "POST") {
      if (
        JSON.stringify(body) !== JSON.stringify({ ref: "main", inputs: { expected_main_sha: sha } })
      )
        return send({}, 422);
      const created = run({
        id: 22,
        event: "workflow_dispatch",
        status: "queued",
        conclusion: null,
        display_title: `Main validation recovery ${sha}`,
        actor: { login: "github-actions[bot]" },
      });
      state.push(created);
      return send(
        {
          workflow_run_id: 22,
          run_url: `https://api.github.com${prefix}/actions/runs/22`,
          html_url: `https://github.com/${repo}/actions/runs/22`,
        },
        options.dispatchStatus ?? 200,
      );
    }
    if (url.pathname === `${prefix}/actions/runs/22`)
      return send(options.readback ?? state.find((r) => r.id === 22));
    if (url.pathname === `${prefix}/actions/runs/11`) {
      detailReads++;
      return send(
        options.changedAttempt && detailReads > 1
          ? run({ run_attempt: 2 })
          : (options.detail ?? state.find((r) => r.id === 11)),
      );
    }
    if (url.pathname === `${prefix}/actions/runs/11/attempts/1/jobs`)
      return send({ total_count: (options.jobs ?? jobs()).length, jobs: options.jobs ?? jobs() });
    return send({ error: `unexpected request ${req.method} ${req.url}` }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const base = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "oc-reconcile-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const bootstrap = path.join(dir, "adapter.mjs");
  const helper = new URL("../reconcile-main-validation.mjs", import.meta.url).href;
  writeFileSync(
    bootstrap,
    `import { createGithubApi, reconcileMainValidation } from ${JSON.stringify(helper)};
let elapsed = 0;
const api = createGithubApi('fixture-token', { fetch: (url, init) => fetch(url.replace('https://api.github.com', ${JSON.stringify(base)}), init), sleep: async (ms) => { elapsed += ms; }, now: () => elapsed });
try { console.log(JSON.stringify(await reconcileMainValidation({ api, repository: '${repo}', now: () => Number(process.env.FIXTURE_NOW) }))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`,
  );
  async function execute(at = options.wallClock ?? wallClock) {
    const child = spawn(process.execPath, [bootstrap], {
      env: {
        ...process.env,
        FIXTURE_NOW: String(at),
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: path.join(dir, "untrusted.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(
      path.join(dir, "untrusted.json"),
      JSON.stringify({
        workflow_run: {
          head_repository: { full_name: "attacker/fork" },
          head_sha: other,
          artifacts_url: "https://attacker.invalid",
        },
      }),
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { status, stdout, stderr };
  }
  return { execute, requests, state };
}

describe("trusted main reconciliation command adapter", () => {
  it.each([undefined, null, {}, { login: "maintainer" }, { login: 42 }])(
    "never resets a retained recovery budget for ambiguous actor %j",
    async (actor) => {
      const f = await fixture({
        runs: [
          run({
            event: "workflow_dispatch",
            display_title: `Main validation recovery ${sha}`,
            actor,
            conclusion: "failure",
          }),
        ],
      });
      for (let i = 0; i < 2; i++) {
        const out = await f.execute();
        expect(out.status).toBe(1);
        expect(out.stderr).toContain("automatic recovery already attempted");
      }
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    },
  );
  it.each([{ runs: [] }, { runs: [run({ event: "schedule" })] }])(
    "fails closed when expired recovery history leaves only %j",
    async ({ runs }) => {
      const f = await fixture({ runs, wallClock: wallClock + 24 * 60 * 60 * 1000 });
      for (let i = 0; i < 2; i++) {
        const out = await f.execute();
        expect(out.status).toBe(1);
        expect(out.stderr).toContain("recovery history may have expired");
      }
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    },
  );
  it("allows recent first recovery but does not refresh its budget after history expires", async () => {
    const f = await fixture();
    expect((await f.execute()).status).toBe(0);
    f.state.length = 0;
    // An immutable commit date, rather than a fresh workflow event/run, anchors the window.
    expect((await f.execute(wallClock + 24 * 60 * 60 * 1000)).status).toBe(1);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it.each([
    { ...sourceCommit, sha: other },
    { ...sourceCommit, committer: { login: "maintainer" } },
    {
      ...sourceCommit,
      commit: {
        committer: { date: "2026-10-26T11:00:00Z" },
        verification: { verified: false, reason: "unsigned" },
      },
    },
    {
      ...sourceCommit,
      commit: {
        committer: { date: "2026-10-27T11:00:00Z" },
        verification: { verified: true, reason: "valid" },
      },
    },
    {
      ...sourceCommit,
      commit: { committer: { date: "invalid" }, verification: { verified: true, reason: "valid" } },
    },
  ])("fails closed without a trustworthy recent source timestamp: %j", async (commit) => {
    const f = await fixture({ commit });
    expect((await f.execute()).status).toBe(1);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
  it.each([
    { advance: 21 * 60 * 60 * 1000 + 59 * 60 * 1000, status: 0 },
    { advance: 22 * 60 * 60 * 1000, status: 1 },
  ])("enforces the conservative pre-retention boundary: %j", async ({ advance, status }) => {
    const f = await fixture({ wallClock: wallClock + advance });
    expect((await f.execute()).status).toBe(status);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(status === 0 ? 1 : 0);
  });
  it("still accepts retained full qualification and active manual retries for old main", async () => {
    for (const candidate of [
      run(),
      run({ event: "workflow_dispatch", status: "queued", conclusion: null }),
    ]) {
      const f = await fixture({ runs: [candidate], wallClock: wallClock + 24 * 60 * 60 * 1000 });
      expect((await f.execute()).status).toBe(0);
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    }
  });
  it("fails schema errors in listed run metadata instead of dispatching from incomplete evidence", async () => {
    const f = await fixture({ runs: [{}] });
    expect((await f.execute()).status).toBe(1);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
  it("dispatches current main after a PR completes before merge, reads back the created run, then deduplicates", async () => {
    const f = await fixture({ runs: [run({ event: "pull_request", head_branch: "feature" })] });
    const first = await f.execute();
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "dispatched",
      sha,
      runId: 22,
      attempt: 1,
    });
    expect((await f.execute()).status).toBe(0);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(f.requests.some((r) => r.path === `${prefix}/actions/runs/22`)).toBe(true);
    expect(f.requests.every((r) => r.path.startsWith(prefix))).toBe(true);
  });
  it("backstops a delayed bot merge with no remaining completion event", async () => {
    const f = await fixture();
    expect((await f.execute()).status).toBe(0);
    expect(f.requests.filter((r) => r.method === "POST")[0]?.body).toEqual({
      ref: "main",
      inputs: { expected_main_sha: sha },
    });
  });
  it.each(["queued", "in_progress", "waiting", "pending"])(
    "deduplicates equivalent %s full coverage",
    async (status) => {
      const f = await fixture({ runs: [run({ status, conclusion: null })] });
      const out = await f.execute();
      expect(out.status, out.stderr).toBe(0);
      expect(JSON.parse(out.stdout).status).toBe("pending");
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    },
  );
  it("accepts only complete successful exact-attempt full main coverage", async () => {
    const f = await fixture({ runs: [run()] });
    const out = await f.execute();
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      status: "qualified",
      sha,
      runId: 11,
      attempt: 1,
    });
  });
  it.each(["schedule", "pull_request"])(
    "does not mistake a successful %s run for full main qualification",
    async (event) => {
      const f = await fixture({ runs: [run({ event })] });
      expect((await f.execute()).status).toBe(0);
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    },
  );
  it.each(["failure", "cancelled"])(
    "allows one recovery of a %s push, then reports persistent red",
    async (conclusion) => {
      const f = await fixture({ runs: [run({ conclusion })] });
      expect((await f.execute()).status).toBe(0);
      Object.assign(f.state[1]!, { status: "completed", conclusion });
      const again = await f.execute();
      expect(again.status).toBe(1);
      expect(again.stderr).toContain("automatic recovery already attempted (run 22, attempt 1)");
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    },
  );
  it.each(
    coverage.flatMap((name) => [
      { name, mode: "missing" },
      { name, mode: "skipped" },
    ]),
  )("rejects $mode $name as full qualification", async ({ name, mode }) => {
    const rows =
      mode === "missing"
        ? jobs().filter((j) => j.name !== name)
        : jobs().map((j) => (j.name === name ? { ...j, conclusion: "skipped" } : j));
    const f = await fixture({ runs: [run()], jobs: rows });
    expect((await f.execute()).status).toBe(0);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it.each([
    { repository: { id: 2, full_name: "attacker/fork" } },
    { head_repository: { id: 2, full_name: "attacker/fork" } },
    { head_branch: "feature" },
    { head_sha: other },
    { workflow_id: 8 },
    {
      display_title: `Main validation recovery ${other}`,
      event: "workflow_dispatch",
      status: "queued",
      conclusion: null,
    },
  ])("ignores unrelated or stale listed runs: %j", async (change) => {
    const f = await fixture({ runs: [run(change)] });
    expect((await f.execute()).status).toBe(0);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it.each([{ run_attempt: 2 }, { run_id: 12 }, { head_sha: other }])(
    "does not qualify invalid job metadata: %j",
    async (change) => {
      const rows = jobs();
      Object.assign(rows[0]!, change);
      const f = await fixture({ runs: [run()], jobs: rows });
      const out = await f.execute();
      expect(out.stdout).not.toContain('"qualified"');
      expect(out.status).toBe(1);
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    },
  );
  it("fails visibly if the latest attempt changes during qualification readback", async () => {
    const f = await fixture({ runs: [run()], changedAttempt: true });
    expect((await f.execute()).status).toBe(1);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
  it("rejects SHA advancement between independent GET and dispatch", async () => {
    const f = await fixture({ advance: true });
    expect((await f.execute()).status).toBe(1);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
  it("rejects advancement in the final API/dispatch race through created-run readback", async () => {
    const f = await fixture({
      readback: run({ id: 22, event: "workflow_dispatch", head_sha: other }),
    });
    expect((await f.execute()).status).toBe(1);
  });
  it("never retries an ambiguous POST and discovers its retained attempt next time", async () => {
    const f = await fixture({ dispatchStatus: 503 });
    expect((await f.execute()).status).toBe(1);
    expect((await f.execute()).status).toBe(0);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it("retries transient reads at most three times, and fails schema/permission errors without dispatch", async () => {
    const transient = await fixture({ transient: 3 });
    expect((await transient.execute()).status).toBe(0);
    const broken = await fixture({ alwaysTransient: true });
    expect((await broken.execute()).status).toBe(1);
    expect(broken.requests).toHaveLength(4);
    for (const options of [{ denied: true }, { wrongWorkflow: true }, { branch: "other" }]) {
      const f = await fixture(options);
      expect((await f.execute()).status).toBe(1);
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    }
  });
  it("finds an older retained recovery beyond the first page instead of redispatching forever", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => run({ id: 100 + i, event: "schedule" }));
    rows.push(
      run({
        event: "workflow_dispatch",
        display_title: `Main validation recovery ${sha}`,
        actor: { login: "github-actions[bot]" },
        conclusion: "failure",
      }),
    );
    const f = await fixture({ runs: rows, paginated: true });
    const out = await f.execute();
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("automatic recovery already attempted");
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});
