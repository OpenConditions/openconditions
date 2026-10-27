import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = fileURLToPath(new URL("../run-link-check.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/link-monitor/", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(mode = "healthy") {
  const dir = mkdtempSync(join(tmpdir(), "oc-link-monitor-"));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  let issue: Record<string, unknown> | null =
    mode.startsWith("existing") || mode === "human"
      ? {
          id: 55,
          number: 7,
          node_id: "I_7",
          state: "open",
          title: "Broken links found by lychee",
          body: "Earlier diagnostics\n\n```text\n404 preserved exactly\n```\n",
          updated_at: "2026-01-01T00:00:00Z",
          user: {
            id: mode === "human" ? 1 : 41898282,
            login: mode === "human" ? "human" : "github-actions[bot]",
            type: mode === "human" ? "User" : "Bot",
          },
        }
      : null;
  let issueReads = 0;
  const server = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (!path.startsWith("/repos/")) {
      res.writeHead(mode === "registry-broken" ? 404 : 200);
      res.end("metadata");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    let result: unknown;
    let status = 200;
    if (req.method === "POST" || req.method === "PATCH") {
      const data = JSON.parse(body);
      writes.push({ method: req.method, body: data });
      issue = {
        id: 55,
        number: 7,
        node_id: "I_7",
        state: "open",
        title: "Broken links found by lychee",
        user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
        updated_at: "2026-01-02T00:00:00Z",
        body: data.body,
      };
      if (mode === "unknown-write") {
        req.socket.destroy();
        return;
      }
      result = issue;
    } else if (path === "/repos/OpenConditions/openconditions") {
      result = {
        id: 1276024943,
        full_name: "OpenConditions/openconditions",
        default_branch: "main",
      };
      if (mode === "api-error") {
        status = 503;
        result = {};
      }
    } else if (path.includes("/labels?"))
      result = mode === "missing-label" ? [] : [{ id: 1, name: "documentation" }];
    else if (path.includes("/issues?")) result = issue ? [issue] : [];
    else if (path.endsWith("/issues/7")) {
      issueReads++;
      result =
        mode === "existing-concurrent" && issueReads === 2
          ? { ...issue, body: "human change" }
          : mode === "readback-error"
            ? { ...issue, body: "unexpected" }
            : issue;
    } else {
      status = 404;
      result = {};
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server");
  const origin = `http://127.0.0.1:${address.port}`;
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const curl = execFileSync("which", ["curl"], { encoding: "utf8" }).trim();
  mkdirSync(join(dir, "bin"));
  for (const name of ["git", "curl"]) {
    copyFileSync(join(fixtures, `${name}.mjs`), join(dir, "bin", name));
    chmodSync(join(dir, "bin", name), 0o755);
  }
  const data = join(dir, "fixture.json");
  writeFileSync(data, JSON.stringify({ mode, origin, git, curl }));
  writeFileSync(join(dir, "README.md"), "# Fixture\n");
  writeFileSync(join(dir, ".lycheeignore"), "# preserved exclusions\n");
  execFileSync(git, ["init", "-q"], { cwd: dir });
  execFileSync(git, ["add", "."], { cwd: dir });
  execFileSync(
    git,
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: dir },
  );
  const sha = execFileSync(git, ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const env: Record<string, string> = {
    PATH: [join(dir, "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    OC_LINK_FIXTURE_DATA: data,
    GITHUB_REPOSITORY: "OpenConditions/openconditions",
    GITHUB_REPOSITORY_ID: "1276024943",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF:
      "OpenConditions/openconditions/.github/workflows/links.yml@refs/heads/main",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: "fixture-writer",
    GH_TOKEN: "fixture-alternative",
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    CHECKOUT_OUTCOME: "success",
    SETUP_OUTCOME: "success",
    PREPARE_OUTCOME: "success",
    LYCHEE_OUTCOME: "success",
    VERSION_OUTCOME: "success",
    REGISTRY_OUTCOME: "success",
    LYCHEE_EXIT_CODE: mode === "healthy" ? "0" : "2",
  };
  const run = (command: string) =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", join(fixtures, "transport.mjs"), script, command],
        { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (x) => (output += x));
      child.stderr.on("data", (x) => (output += x));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  const result = () => JSON.parse(readFileSync(join(dir, "lychee/execution.json"), "utf8"));
  const raw = (name: string) => {
    copyFileSync(join(fixtures, `${name}.json`), join(dir, "lychee/out.json"));
    writeFileSync(join(dir, "lychee/version.txt"), "lychee 0.24.2\n");
  };
  return {
    dir,
    env,
    run,
    result,
    raw,
    writes,
    previous: issue?.body,
    setBody: (body: string) => {
      if (!issue) throw new Error("issue missing");
      issue.body = body;
    },
  };
}
async function prepared(mode = "healthy") {
  const f = await fixture(mode);
  expect(await f.run("prepare")).toMatchObject({ code: 0 });
  f.raw(mode === "healthy" ? "healthy" : "unhealthy");
  expect(await f.run("registry")).toMatchObject({ code: 0 });
  return f;
}
test("complete healthy coverage records recovery review without any issue mutation", async () => {
  const f = await prepared();
  expect(await f.run("finish")).toMatchObject({ code: 0 });
  expect(f.result()).toMatchObject({
    complete: true,
    outcome: "healthy",
    reporting: { attempted: false, recoveryReview: true },
    coverage: { total: 1, successful: 1, registryChecked: 3 },
  });
  expect(f.writes).toEqual([]);
});
test.each(["unhealthy", "registry-broken", "curl-error"])(
  "complete %s reports diagnostics without changing issue lifecycle",
  async (mode) => {
    const f = await prepared(mode);
    expect(await f.run("finish")).toMatchObject({ code: 0 });
    expect(f.result().complete).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].body).not.toHaveProperty("state");
    expect(f.writes[0].body).toHaveProperty("labels", ["documentation"]);
  },
);
test("all real Git and curl subprocesses reject both reporting tokens", async () => {
  const f = await prepared("unhealthy");
  expect(await f.run("finish")).toMatchObject({ code: 0 });
  const rows = readFileSync(join(f.dir, "git-checks.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  expect(rows.length).toBeGreaterThanOrEqual(9);
  expect(rows.every((x) => !x.tokenPresent)).toBe(true);
  expect(readFileSync(join(f.dir, "curl-checks.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
});
test.each([
  "CHECKOUT_OUTCOME",
  "SETUP_OUTCOME",
  "PREPARE_OUTCOME",
  "LYCHEE_OUTCOME",
  "VERSION_OUTCOME",
  "REGISTRY_OUTCOME",
])("%s failure cannot become healthy or report", async (key) => {
  const f = await prepared();
  f.env[key] = "failure";
  expect((await f.run("finish")).code).toBe(1);
  expect(f.result().complete).toBe(false);
  expect(f.writes).toEqual([]);
});
test.each(["", "1", "3", "137", "unknown"])(
  "lychee exit %s rejects even a plausible result",
  async (exit) => {
    const f = await prepared();
    f.env.LYCHEE_EXIT_CODE = exit;
    expect((await f.run("finish")).code).toBe(1);
    expect(f.writes).toEqual([]);
  },
);
test.each(["missing", "partial", "empty", "count-drift", "exit-drift", "unknown-status"])(
  "%s lychee evidence never means zero failures",
  async (mode) => {
    const f = await prepared();
    const path = join(f.dir, "lychee/out.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (mode === "missing") rmSync(path);
    else if (mode === "partial") writeFileSync(path, '{"total":');
    else if (mode === "empty") f.raw("empty");
    else {
      if (mode === "count-drift") value.total++;
      if (mode === "unknown-status") {
        value.successful = 0;
        value.unknown = 1;
      }
      if (mode === "exit-drift") f.env.LYCHEE_EXIT_CODE = "2";
      writeFileSync(path, JSON.stringify(value));
    }
    expect((await f.run("finish")).code).toBe(1);
    expect(f.writes).toEqual([]);
  },
);
test.each([
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_EVENT_NAME",
])("rejects wrong %s authority before mutation", async (key) => {
  const f = await prepared("unhealthy");
  f.env[key] = "wrong";
  expect((await f.run("finish")).code).toBe(1);
  expect(f.writes).toEqual([]);
});
test.each([
  "missing-label",
  "human",
  "existing-concurrent",
  "api-error",
  "unknown-write",
  "readback-error",
])("%s stops reporting visibly without repeated mutation", async (mode) => {
  const f = await prepared(mode);
  expect((await f.run("finish")).code).toBe(1);
  expect(f.result().complete).toBe(false);
  expect(f.writes.length).toBe(mode === "unknown-write" || mode === "readback-error" ? 1 : 0);
});
test("bot-owned legacy diagnostics are retained byte-for-byte and no lifecycle keys are sent", async () => {
  const f = await prepared("existing");
  expect((await f.run("finish")).code).toBe(0);
  expect(String(f.writes[0].body.body)).toContain(f.previous);
  expect(Object.keys(f.writes[0].body)).toEqual(["body"]);
});
test("missing registry receipt cannot turn into healthy", async () => {
  const f = await prepared();
  rmSync(join(f.dir, "lychee/registry.json"));
  expect((await f.run("finish")).code).toBe(1);
  expect(f.writes).toEqual([]);
});
test("missing curl executable is infrastructure failure, not a provider warning", async () => {
  const f = await fixture();
  expect((await f.run("prepare")).code).toBe(0);
  rmSync(join(f.dir, "bin/curl"));
  f.env.PATH = `${join(f.dir, "bin")}:${dirname(process.execPath)}`;
  expect((await f.run("registry")).code).toBe(1);
  expect(existsSync(join(f.dir, "lychee/registry.json"))).toBe(false);
});

test("check completion is separate from report API failure", async () => {
  const f = await prepared("api-error");
  expect((await f.run("finish")).code).toBe(1);
  expect(f.result()).toMatchObject({ checksComplete: true, complete: false, outcome: "unhealthy" });
});
test("curl configuration failure cannot masquerade as a broken provider", async () => {
  const f = await fixture("curl-config");
  expect((await f.run("prepare")).code).toBe(0);
  expect((await f.run("registry")).code).toBe(1);
  expect(existsSync(join(f.dir, "lychee/registry.json"))).toBe(false);
});
test("malformed curl output is infrastructure failure", async () => {
  const f = await fixture("curl-malformed");
  expect((await f.run("prepare")).code).toBe(0);
  expect((await f.run("registry")).code).toBe(1);
});
test("registry-only failures retain healthy lychee coverage and report", async () => {
  const f = await prepared("registry-broken");
  f.raw("healthy");
  f.env.LYCHEE_EXIT_CODE = "0";
  expect((await f.run("finish")).code).toBe(0);
  expect(f.result()).toMatchObject({
    outcome: "unhealthy",
    coverage: { errors: 0, registryChecked: 3 },
  });
});
test.each(["context", "partial", "time", "row"])("rejects %s registry evidence", async (mode) => {
  const f = await prepared();
  const path = join(f.dir, "lychee/registry.json");
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (mode === "context") data.context.runAttempt = "2";
  if (mode === "partial") data.rows.pop();
  if (mode === "time") data.finishedAt = "1970-01-01T00:00:00Z";
  if (mode === "row") data.rows[0].url = "https://untrusted.invalid";
  writeFileSync(path, JSON.stringify(data));
  expect((await f.run("finish")).code).toBe(1);
  expect(f.writes).toEqual([]);
});
test("a subsequent managed refresh preserves human outside text and legacy bytes", async () => {
  const first = await prepared("existing");
  expect((await first.run("finish")).code).toBe(0);
  const second = await prepared("existing");
  second.setBody(`Human before\n${first.writes[0].body.body}\nHuman after`);
  expect((await second.run("finish")).code).toBe(0);
  const body = String(second.writes[0].body.body);
  expect(body.startsWith("Human before\n")).toBe(true);
  expect(body.endsWith("\nHuman after")).toBe(true);
  expect(body).toContain(first.previous);
});
test("edited managed diagnostics are preserved for human review, never overwritten", async () => {
  const first = await prepared("existing");
  expect((await first.run("finish")).code).toBe(0);
  const second = await prepared("existing");
  second.setBody(String(first.writes[0].body.body).replace("# Link check", "# Human edited"));
  expect((await second.run("finish")).code).toBe(1);
  expect(second.writes).toEqual([]);
});
test("report generation failure cannot reach the API", async () => {
  const f = await prepared("unhealthy");
  mkdirSync(join(f.dir, "lychee/combined-out.md"));
  expect((await f.run("finish")).code).toBe(1);
  expect(f.writes).toEqual([]);
});
test("summary failure remains incomplete even after healthy checks", async () => {
  const f = await prepared();
  mkdirSync(join(f.dir, "summary-directory"));
  f.env.GITHUB_STEP_SUMMARY = join(f.dir, "summary-directory");
  expect((await f.run("finish")).code).toBe(1);
  expect(f.result().complete).toBe(false);
  expect(f.writes).toEqual([]);
});
test("pre-existing output cannot be reused as new run evidence", async () => {
  const f = await fixture();
  mkdirSync(join(f.dir, "lychee"));
  expect((await f.run("prepare")).code).toBe(1);
});
test("changed tracked source fails before reporting", async () => {
  const f = await prepared("unhealthy");
  writeFileSync(join(f.dir, "README.md"), "changed source");
  expect((await f.run("finish")).code).toBe(1);
  expect(f.writes).toEqual([]);
});

test.each(["missing", "wrong"])(
  "%s runtime tool version cannot qualify its output",
  async (mode) => {
    const f = await prepared();
    const path = join(f.dir, "lychee/version.txt");
    if (mode === "missing") rmSync(path);
    else writeFileSync(path, "lychee 999.0.0\n");
    expect((await f.run("finish")).code).toBe(1);
    expect(f.writes).toEqual([]);
  },
);
test("cached output exposes its limitation instead of claiming fresh network coverage", async () => {
  const f = await prepared();
  f.raw("cached");
  expect((await f.run("finish")).code).toBe(0);
  expect(f.result().coverage.cached).toBe(1);
  expect(f.result().cache).toContain("need not be freshly requested");
});
