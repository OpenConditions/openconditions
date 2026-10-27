import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "OpenConditions/openconditions";
const root = `/repos/${repository}`;
const title = "Keyless feed liveness check found failing feeds";
const startMarker = "<!-- openconditions:feed-liveness:managed:start -->";
const endMarker = "<!-- openconditions:feed-liveness:managed:end -->";
const hash = (text) => createHash("sha256").update(text).digest("hex");
function assert(value, message) {
  if (!value) throw new Error(message);
}
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
function readRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile() && before.size <= 5_000_000n, "invalid evidence file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    assert(
      before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      "evidence changed during read",
    );
    return bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function contextOf(cwd, env) {
  assert(
    env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_REPOSITORY_ID === "1276024943" &&
      env.GITHUB_REF === "refs/heads/main",
    "trusted owning main required",
  );
  assert(
    ["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) &&
      env.GITHUB_WORKFLOW_REF ===
        `${repository}/.github/workflows/feed-liveness.yml@refs/heads/main`,
    "unexpected workflow authority",
  );
  assert(
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") &&
      env.GITHUB_SHA === env.GITHUB_WORKFLOW_SHA &&
      /^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") &&
      /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? ""),
    "invalid source/run/attempt",
  );
  const git = (args) =>
    execFileSync("git", ["--no-replace-objects", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  assert(
    realpathSync(git(["rev-parse", "--show-toplevel"])) === realpathSync(cwd) &&
      git(["rev-parse", "HEAD"]) === env.GITHUB_SHA &&
      git(["status", "--porcelain", "--untracked-files=no"]) === "",
    "source checkout identity/bytes changed",
  );
  return {
    sourceSha: env.GITHUB_SHA,
    repository,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function createApi(token) {
  assert(typeof token === "string" && token.length > 0, "missing reporting token");
  const deadline = Date.now() + 60_000;
  return async (method, route, body) => {
    assert(
      ["GET", "POST", "PATCH"].includes(method) && (route === root || route.startsWith(`${root}/`)),
      "invalid reporting API route/method",
    );
    assert(Date.now() < deadline, "report API deadline exceeded");
    const response = await fetch(`https://api.github.com${route}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(
      response.ok,
      `report API ${method} failed (${response.status}); write outcomes are not retried`,
    );
    const text = await response.text();
    assert(Buffer.byteLength(text) <= 5_000_000, "excessive API response");
    return JSON.parse(text);
  };
}
async function pages(api, route) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const values = await api(
      "GET",
      `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    assert(Array.isArray(values) && values.length <= 100, "invalid API pagination");
    rows.push(...values);
    if (values.length < 100) return rows;
  }
  throw new Error("incomplete report inventory; pagination bound exceeded");
}
function managedBody(previous, report) {
  const section = `${startMarker}\n${report}\n<!-- sha256:${hash(report)} -->\n${endMarker}`;
  const starts = [...previous.matchAll(/^<!-- openconditions:feed-liveness:managed:start -->$/gm)];
  const ends = [...previous.matchAll(/^<!-- openconditions:feed-liveness:managed:end -->$/gm)];
  if (starts.length === 0 && ends.length === 0) {
    assert(
      previous === "" || previous.startsWith("Automated feed-liveness check found "),
      "unrecognized existing report body; preserve for review",
    );
    return previous
      ? `${section}\n\nEarlier diagnostics retained below; they are not evidence from this run.\n\n${previous}`
      : `${section}\n`;
  }
  assert(
    starts.length === 1 && ends.length === 1 && ends[0].index > starts[0].index,
    "ambiguous managed report boundaries",
  );
  const inside = previous.slice(starts[0].index + startMarker.length, ends[0].index);
  const match = /^\n([\s\S]*)\n<!-- sha256:([a-f0-9]{64}) -->\n$/.exec(inside);
  assert(match && hash(match[1]) === match[2], "managed diagnostics edited; preserve for review");
  return `${previous.slice(0, starts[0].index)}${section}${previous.slice(ends[0].index + endMarker.length)}`;
}
function ownedIssue(value) {
  assert(
    positive(value?.id) &&
      positive(value.number) &&
      typeof value.node_id === "string" &&
      !value.pull_request &&
      value.state === "open" &&
      value.title === title &&
      value.user?.id === 41898282 &&
      value.user.login === "github-actions[bot]" &&
      value.user.type === "Bot" &&
      typeof value.body === "string" &&
      typeof value.updated_at === "string",
    "report ownership/state changed; no human issue mutation",
  );
  return {
    id: value.id,
    number: value.number,
    node_id: value.node_id,
    state: value.state,
    title: value.title,
    body: value.body,
    updated_at: value.updated_at,
    userId: value.user.id,
  };
}
async function publish(api, report) {
  const repo = await api("GET", root);
  assert(
    repo?.id === 1276024943 && repo.full_name === repository && repo.default_branch === "main",
    "wrong reporting repository",
  );
  const labels = await pages(api, `${root}/labels`);
  assert(
    labels.some((x) => positive(x.id) && x.name === "feed" && x.archived_at == null),
    "reporting activation blocked: missing active feed label",
  );
  const matching = (await pages(api, `${root}/issues?state=open`)).filter(
    (x) => !x.pull_request && x.title === title,
  );
  assert(matching.length <= 1, "ambiguous existing report; no duplicate creation");
  let existing = matching[0] ? ownedIssue(matching[0]) : null;
  if (existing) {
    const fresh = ownedIssue(await api("GET", `${root}/issues/${existing.number}`));
    assert(same(fresh, existing), "existing report changed; preserve for review");
    existing = fresh;
  }
  const body = managedBody(existing?.body ?? "", report);
  assert(
    Buffer.byteLength(body) <= 65_536,
    "report exceeds API body bound; no diagnostic truncation",
  );
  const response = await api(
    existing ? "PATCH" : "POST",
    existing ? `${root}/issues/${existing.number}` : `${root}/issues`,
    existing ? { body } : { title, body, labels: ["feed"] },
  );
  const written = ownedIssue(response);
  assert(
    written.body === body &&
      (!existing || (written.id === existing.id && written.number === existing.number)),
    "report response identity/body mismatch; outcome uncertain",
  );
  const readback = ownedIssue(await api("GET", `${root}/issues/${written.number}`));
  assert(
    readback.id === written.id && readback.body === body,
    "report readback mismatch; no retry/rollback",
  );
  return { success: true, issue: written.number, bodySha256: hash(body) };
}
function validateChecker(value, context, startedAt, report, exit) {
  assert(
    value?.version === 1 &&
      same(value.context, context) &&
      value.complete === true &&
      value.checksComplete === true &&
      value.reportComplete === true &&
      value.failureStage === null &&
      value.selection === "catalogue" &&
      value.keylessOnly === true &&
      value.applicableComplete === true,
    "incomplete/partial or wrong-authority checker evidence",
  );
  assert(
    Date.parse(value.startedAt) >= Date.parse(startedAt) &&
      Date.parse(value.checkedAt) >= Date.parse(value.startedAt) &&
      Date.parse(value.finishedAt) >= Date.parse(value.checkedAt) &&
      Date.parse(value.finishedAt) <= Date.now(),
    "stale or invalid checker times",
  );
  const coverage = value.coverage;
  const outcomes = value.outcomes;
  assert(
    coverage &&
      outcomes &&
      Array.isArray(value.results) &&
      positive(coverage.planned) &&
      coverage.planned === coverage.completed &&
      coverage.completed === value.results.length &&
      positive(coverage.checked) &&
      natural(coverage.onDemandProbes) &&
      coverage.onDemandProbes <= coverage.checked,
    "incomplete checker inventory",
  );
  const counts = { ok: 0, warning: 0, error: 0, skipped: 0 };
  const skips = { keyed: 0, disabled: 0, configuration: 0 };
  const ids = new Set();
  for (const row of value.results) {
    assert(
      typeof row?.feedId === "string" &&
        row.feedId.length > 0 &&
        !ids.has(row.feedId) &&
        Object.hasOwn(counts, row.level),
      "invalid/duplicate feed outcome",
    );
    ids.add(row.feedId);
    counts[row.level]++;
    if (row.level === "skipped") {
      assert(Object.hasOwn(skips, row.skipReason), "unknown skipped scope");
      skips[row.skipReason]++;
    } else assert(row.skipReason === undefined, "invalid checked skip reason");
  }
  assert(
    same(outcomes, counts) &&
      same(coverage.skipped, skips) &&
      skips.configuration === 0 &&
      coverage.checked === counts.ok + counts.warning + counts.error &&
      counts.skipped === skips.keyed + skips.disabled,
    "inconsistent/partial coverage",
  );
  const unhealthy = counts.warning + counts.error > 0;
  assert(
    value.providerOutcome === (unhealthy ? "unhealthy" : "healthy") &&
      value.recoveryReview === !unhealthy &&
      value.reportSha256 === hash(report) &&
      exit === (counts.error ? 1 : 0),
    "checker exit/outcome/report hash mismatch",
  );
  return value;
}
function runProcess(command, args, { cwd, env, log }) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(log, { flags: "wx", mode: 0o600 });
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let failed;
    output.on("error", (error) => {
      failed = error;
      child.kill();
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output.write(chunk);
        process.stdout.write(chunk);
      });
    child.on("error", (error) => {
      failed = error;
    });
    child.on("close", (code, signal) =>
      output.end(() => (failed ? reject(failed) : resolve(signal ? -1 : (code ?? -1)))),
    );
  });
}
export async function runLiveness({ cwd = process.cwd(), env = process.env } = {}) {
  const childEnv = { ...env };
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"])
    delete childEnv[key];
  let output;
  let context;
  let stage = "authority";
  const execution = {
    version: 1,
    startedAt: new Date().toISOString(),
    context: null,
    complete: false,
    stage,
    checker: null,
    checkerValidated: false,
    reporting: { success: false, attempted: false },
  };
  let code = 1;
  try {
    context = contextOf(cwd, childEnv);
    execution.context = context;
    const directory = join(cwd, "liveness");
    mkdirSync(directory, { mode: 0o700 });
    output = directory;
    stage = "install";
    const install = await runProcess("pnpm", ["install", "--frozen-lockfile"], {
      cwd,
      env: childEnv,
      log: join(output, "install.log"),
    });
    assert(install === 0, "dependency installation failed");
    stage = "build";
    const build = await runProcess("pnpm", ["build:domains"], {
      cwd,
      env: childEnv,
      log: join(output, "build.log"),
    });
    assert(build === 0, "domain build failed");
    contextOf(cwd, childEnv);
    stage = "checker";
    const exit = await runProcess(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/feeds-check.ts",
        "--keyless",
        "--report",
        "liveness/out.md",
        "--result",
        "liveness/check.json",
      ],
      { cwd, env: childEnv, log: join(output, "check.log") },
    );
    const raw = JSON.parse(readRegular(join(output, "check.json")));
    execution.checker = raw;
    stage = "validation";
    const report = readRegular(join(output, "out.md"));
    validateChecker(raw, context, execution.startedAt, report, exit);
    contextOf(cwd, childEnv);
    execution.checkerValidated = true;
    if (raw.providerOutcome === "unhealthy") {
      stage = "report";
      execution.reporting.attempted = true;
      execution.reporting = {
        attempted: true,
        ...(await publish(createApi(env.GITHUB_TOKEN), report)),
      };
    } else execution.reporting = { success: true, attempted: false, recoveryReview: true };
    execution.complete = true;
    stage = "complete";
    code = exit;
  } catch (error) {
    execution.error = error.message;
    console.error(`feed liveness ${stage} failed: ${error.message}`);
  }
  execution.stage = stage;
  execution.finishedAt = new Date().toISOString();
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `## Feed liveness execution\n\n\`\`\`json\n${JSON.stringify({ ...execution, checker: execution.checkerValidated ? { context: execution.checker.context, complete: execution.checker.complete, providerOutcome: execution.checker.providerOutcome, coverage: execution.checker.coverage } : { validated: false, coverage: "unqualified" } }, null, 2)}\n\`\`\`\n`,
      );
    } catch {
      code = 1;
      execution.complete = false;
      execution.stage = "summary";
      execution.error = "cannot retain job summary";
      console.error("cannot retain job summary");
    }
  }
  if (output) {
    try {
      writeFileSync(join(output, "execution.json"), `${JSON.stringify(execution, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      console.error("cannot retain execution receipt");
      code = 1;
    }
  }
  return code;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) {
    console.error("usage: node scripts/run-feed-liveness.mjs");
    process.exitCode = 1;
  } else process.exitCode = await runLiveness();
}
