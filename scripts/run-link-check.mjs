import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = "OpenConditions/openconditions";
const root = `/repos/${repo}`;
const title = "Broken links found by lychee";
const output = "lychee";
// curl manual: HTTP/transport failures are endpoint diagnostics; unknown/local failures stop.
const transportExits = new Set([
  5, 6, 7, 8, 16, 18, 28, 35, 47, 52, 55, 56, 60, 61, 80, 83, 90, 91, 92, 95, 96,
]);
const endpoints = [
  "https://registry.npmjs.org/hyparquet-writer",
  "https://registry.npmjs.org/@divviup%2Fprio3",
  "https://registry.npmjs.org/@divviup%2Fvdaf",
];
const start = "<!-- openconditions:links:managed:start -->";
const end = "<!-- openconditions:links:managed:end -->";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => natural(value) && value > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function assert(value, message) {
  if (!value) throw new Error(message);
}
function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd, { bigint: true });
    assert(a.isFile() && a.size <= 5_000_000n, "invalid or excessive evidence file");
    const bytes = readFileSync(fd);
    const b = fstatSync(fd, { bigint: true });
    assert(
      a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs,
      "evidence changed during read",
    );
    return bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
const load = (path) => JSON.parse(read(path));
const save = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
function childEnvironment(env) {
  const child = { ...env };
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"])
    delete child[key];
  return child;
}
function authority(env) {
  assert(
    env.GITHUB_REPOSITORY === repo &&
      env.GITHUB_REPOSITORY_ID === "1276024943" &&
      env.GITHUB_REF === "refs/heads/main",
    "trusted owning main required",
  );
  assert(
    ["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) &&
      env.GITHUB_WORKFLOW_REF === `${repo}/.github/workflows/links.yml@refs/heads/main`,
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
      env: childEnvironment(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  assert(
    realpathSync(git(["rev-parse", "--show-toplevel"])) === realpathSync(process.cwd()) &&
      git(["rev-parse", "HEAD"]) === env.GITHUB_SHA &&
      git(["status", "--porcelain", "--untracked-files=no"]) === "",
    "source checkout changed",
  );
  return {
    repository: repo,
    sourceSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}
function stateOf(env) {
  const context = authority(env);
  assert(
    realpathSync(output) === join(realpathSync(process.cwd()), output),
    "unexpected output directory",
  );
  const state = load(join(output, "started.json"));
  assert(
    state.version === 1 &&
      same(state.context, context) &&
      state.exclusions === read(".lycheeignore") &&
      state.exclusionsSha256 === digest(state.exclusions),
    "stale or changed input evidence",
  );
  const age = Date.now() - Date.parse(state.startedAt);
  assert(
    Number.isFinite(age) && age >= 0 && age <= 6 * 60 * 60 * 1000,
    "expired or invalid start evidence",
  );
  return state;
}
function prepare(env) {
  const context = authority(env);
  const exclusions = read(".lycheeignore");
  mkdirSync(output, { mode: 0o700 }); // Existing output is ambiguous; never reuse it.
  save(join(output, "started.json"), {
    version: 1,
    context,
    startedAt: new Date().toISOString(),
    exclusions,
    exclusionsSha256: digest(exclusions),
    scope: "./**/*.md; Git-ignored/hidden paths follow lychee defaults",
    cache: "enabled; maximum age1d; cached responses need not be freshly requested",
    tool: "lychee0.24.2 via action e7477775783ea5526144ba13e8db5eec57747ce8",
  });
}
function registry(env) {
  const state = stateOf(env);
  const rows = [];
  for (const url of endpoints) {
    const result = spawnSync(
      "curl",
      [
        "--silent",
        "--show-error",
        "--location",
        "--retry",
        "2",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        url,
      ],
      { env: childEnvironment(env), encoding: "utf8", maxBuffer: 1_000_000 },
    );
    assert(
      !result.error &&
        result.signal === null &&
        Number.isInteger(result.status) &&
        result.status >= 0 &&
        result.status <= 99,
      "registry tool failed to execute",
    );
    assert(
      result.status === 0 || transportExits.has(result.status),
      "registry tool/configuration failure",
    );
    assert(result.status !== 0 || /^\d{3}$/.test(result.stdout), "malformed curl status");
    if (result.stderr) console.error(result.stderr);
    rows.push({
      url,
      exit: result.status,
      diagnostic: result.stderr,
      httpStatus: result.status === 0 ? result.stdout : "000",
      healthy: result.status === 0 && /^2\d\d$/.test(result.stdout),
    });
  }
  authority(env);
  save(join(output, "registry.json"), {
    version: 1,
    context: state.context,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    complete: true,
    checked: rows.length,
    rows,
  });
}
function validateLychee(stats, exit) {
  const names = [
    "total",
    "unique",
    "successful",
    "unknown",
    "unsupported",
    "timeouts",
    "redirects",
    "remaps",
    "excludes",
    "errors",
    "cached",
  ];
  assert(
    names.every((key) => natural(stats?.[key])),
    "missing/invalid lychee coverage",
  );
  assert(
    stats.total > 0 &&
      stats.unique > 0 &&
      stats.unique <= stats.total &&
      stats.cached <= stats.total &&
      stats.redirects <= stats.total &&
      stats.remaps <= stats.total,
    "empty or impossible lychee coverage",
  );
  assert(
    stats.successful +
      stats.unknown +
      stats.unsupported +
      stats.timeouts +
      stats.excludes +
      stats.errors ===
      stats.total && stats.unknown === 0,
    "partial/unknown lychee coverage",
  );
  for (const key of ["error_map", "timeout_map"]) {
    assert(
      stats[key] && typeof stats[key] === "object" && !Array.isArray(stats[key]),
      "missing lychee diagnostics",
    );
    const entries = Object.values(stats[key]);
    assert(
      entries.every(
        (rows) =>
          Array.isArray(rows) &&
          rows.every((row) => typeof row?.url === "string" && typeof row.status?.text === "string"),
      ),
      "invalid lychee diagnostics",
    );
    const count = entries.reduce((n, rows) => n + rows.length, 0);
    const expected = key === "error_map" ? stats.errors : stats.timeouts;
    assert(
      expected === 0 ? count === 0 : count > 0 && count <= expected,
      "incomplete lychee diagnostics",
    );
  }
  const unhealthy = stats.errors + stats.timeouts > 0;
  assert(exit === (unhealthy ? "2" : "0"), "lychee exit/report disagreement");
  return unhealthy;
}
function validateRegistry(value, state) {
  assert(
    value?.version === 1 &&
      same(value.context, state.context) &&
      value.startedAt === state.startedAt &&
      value.complete === true &&
      value.checked === 3 &&
      Array.isArray(value.rows) &&
      value.rows.length === 3,
    "incomplete registry evidence",
  );
  assert(
    Date.parse(value.finishedAt) >= Date.parse(state.startedAt) &&
      Date.parse(value.finishedAt) <= Date.now(),
    "invalid registry completion time",
  );
  for (let i = 0; i < 3; i++) {
    const row = value.rows[i];
    assert(
      row.url === endpoints[i] &&
        natural(row.exit) &&
        (row.exit === 0 || transportExits.has(row.exit)) &&
        typeof row.diagnostic === "string" &&
        row.diagnostic.length <= 1_000_000 &&
        /^\d{3}$/.test(row.httpStatus) &&
        (row.exit === 0 || row.httpStatus === "000") &&
        row.healthy === (row.exit === 0 && /^2\d\d$/.test(row.httpStatus)),
      "invalid registry result",
    );
  }
  return value.rows.some((row) => !row.healthy);
}
function managedBody(previous, report) {
  const a = [...previous.matchAll(/^<!-- openconditions:links:managed:start -->$/gm)];
  const b = [...previous.matchAll(/^<!-- openconditions:links:managed:end -->$/gm)];
  const section = `${start}\n${report}\n<!-- sha256:${digest(report)} -->\n${end}`;
  if (!a.length && !b.length)
    return previous
      ? `${section}\n\nEarlier diagnostics retained below; not evidence from this run.\n\n${previous}`
      : `${section}\n`;
  assert(
    a.length === 1 && b.length === 1 && b[0].index > a[0].index,
    "ambiguous managed diagnostics",
  );
  const inside = previous.slice(a[0].index + start.length, b[0].index);
  const match = /^\n([\s\S]*)\n<!-- sha256:([a-f0-9]{64}) -->\n$/.exec(inside);
  assert(
    match && digest(match[1]) === match[2],
    "managed diagnostics changed; preserve for review",
  );
  return previous.slice(0, a[0].index) + section + previous.slice(b[0].index + end.length);
}
function owned(value) {
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
    "report ownership/state changed",
  );
  return {
    id: value.id,
    number: value.number,
    node_id: value.node_id,
    body: value.body,
    updated_at: value.updated_at,
  };
}
function apiOf(token) {
  assert(typeof token === "string" && token.length > 0, "report token missing");
  const deadline = Date.now() + 60_000;
  return async (method, path, body) => {
    assert(
      ["GET", "POST", "PATCH"].includes(method) && (path === root || path.startsWith(`${root}/`)),
      "invalid reporting route",
    );
    assert(Date.now() < deadline, "report deadline exceeded");
    const response = await fetch(`https://api.github.com${path}`, {
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
    assert(response.ok, `report API ${method} failed (${response.status}); no write retry`);
    const text = await response.text();
    assert(Buffer.byteLength(text) <= 5_000_000, "excessive API response");
    return JSON.parse(text);
  };
}
async function pages(api, path) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await api(
      "GET",
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    assert(Array.isArray(rows) && rows.length <= 100, "invalid API inventory");
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error("incomplete API inventory");
}
async function publish(token, report) {
  const api = apiOf(token);
  const repository = await api("GET", root);
  assert(
    repository?.id === 1276024943 &&
      repository.full_name === repo &&
      repository.default_branch === "main",
    "wrong reporting repository",
  );
  const labels = await pages(api, `${root}/labels`);
  assert(
    labels.some((x) => positive(x.id) && x.name === "documentation" && x.archived_at == null),
    "activation blocked: missing documentation label",
  );
  const issues = (await pages(api, `${root}/issues?state=open`)).filter(
    (x) => !x.pull_request && x.title === title,
  );
  assert(issues.length <= 1, "ambiguous report issues");
  let previous = issues[0] ? owned(issues[0]) : null;
  if (previous) {
    const fresh = owned(await api("GET", `${root}/issues/${previous.number}`));
    assert(same(previous, fresh), "report changed since inventory");
    previous = fresh;
  }
  const body = managedBody(previous?.body ?? "", report);
  assert(Buffer.byteLength(body) <= 65_536, "report too large; no diagnostic truncation");
  if (previous)
    assert(
      same(previous, owned(await api("GET", `${root}/issues/${previous.number}`))),
      "report changed before write",
    );
  const response = owned(
    await api(
      previous ? "PATCH" : "POST",
      previous ? `${root}/issues/${previous.number}` : `${root}/issues`,
      previous ? { body } : { title, body, labels: ["documentation"] },
    ),
  );
  assert(
    response.body === body &&
      (!previous ||
        (response.id === previous.id &&
          response.number === previous.number &&
          response.node_id === previous.node_id)),
    "uncertain report write",
  );
  const readback = owned(await api("GET", `${root}/issues/${response.number}`));
  assert(same(response, readback), "uncertain report readback; no retry/rollback");
  return { attempted: true, success: true, issue: response.number, bodySha256: digest(body) };
}
async function finish(env) {
  const receipt = {
    version: 1,
    complete: false,
    checksComplete: false,
    outcome: "unknown",
    reporting: { attempted: false },
  };
  let code = 1;
  try {
    const state = stateOf(env);
    receipt.context = state.context;
    receipt.startedAt = state.startedAt;
    receipt.scope = state.scope;
    receipt.cache = state.cache;
    receipt.tool = state.tool;
    receipt.exclusions = state.exclusions;
    for (const key of [
      "CHECKOUT_OUTCOME",
      "SETUP_OUTCOME",
      "PREPARE_OUTCOME",
      "LYCHEE_OUTCOME",
      "VERSION_OUTCOME",
      "REGISTRY_OUTCOME",
    ])
      assert(env[key] === "success", `${key} did not succeed`);
    assert(
      ["0", "2"].includes(env.LYCHEE_EXIT_CODE),
      "lychee execution/configuration failed or exit missing",
    );
    const version = read(join(output, "version.txt")).trim();
    assert(version === "lychee 0.24.2", "unexpected runtime lychee version");
    receipt.runtimeVersion = version;
    const raw = read(join(output, "out.json"));
    const stats = JSON.parse(raw);
    const broken = validateLychee(stats, env.LYCHEE_EXIT_CODE);
    const registryBytes = read(join(output, "registry.json"));
    const npm = JSON.parse(registryBytes);
    const registryBroken = validateRegistry(npm, state);
    receipt.coverage = Object.fromEntries(
      [
        "total",
        "unique",
        "successful",
        "errors",
        "timeouts",
        "excludes",
        "unsupported",
        "cached",
      ].map((key) => [key, stats[key]]),
    );
    receipt.coverage.registryChecked = npm.checked;
    receipt.evidence = {
      lycheeSha256: digest(raw),
      registrySha256: digest(registryBytes),
      exclusionsSha256: state.exclusionsSha256,
    };
    receipt.checksComplete = true;
    receipt.outcome = broken || registryBroken ? "unhealthy" : "healthy";
    const report = `# Link check\n\n${JSON.stringify({ ...receipt, checksComplete: true, checkedAt: new Date().toISOString() }, null, 2)}\n\n## Lychee diagnostics\n\n\`\`\`json\n${raw}\n\`\`\`\n\n## Direct npm metadata\n\n\`\`\`json\n${registryBytes}\n\`\`\`\n\nCoverage follows the existing Markdown scope and exclusions. Cached and unsupported/excluded links are not fresh network acceptance. Healthy evidence permits manual resolution review only.`;
    writeFileSync(join(output, "combined-out.md"), report, { flag: "wx", mode: 0o600 });
    authority(env);
    if (receipt.outcome === "unhealthy") {
      receipt.reporting = { attempted: true };
      receipt.reporting = await publish(env.GITHUB_TOKEN, report);
    } else receipt.reporting = { attempted: false, recoveryReview: true };
    receipt.complete = true;
    code = 0;
  } catch (error) {
    receipt.error = error.message;
    console.error(`link check failed: ${error.message}`);
  }
  receipt.finishedAt = new Date().toISOString();
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `## Link check completion\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`,
      );
    } catch {
      receipt.complete = false;
      receipt.error = "cannot retain summary";
      code = 1;
    }
  }
  try {
    save(join(output, "execution.json"), receipt);
  } catch {
    console.error("cannot retain execution receipt");
    code = 1;
  }
  return code;
}
export async function main(args, env = process.env) {
  try {
    assert(args.length === 1, "expected prepare, registry or finish");
    if (args[0] === "prepare") prepare(env);
    else if (args[0] === "registry") registry(env);
    else if (args[0] === "finish") return await finish(env);
    else throw new Error("unknown link-check command");
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
