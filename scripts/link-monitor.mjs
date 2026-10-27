import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const endpoints = [
  "https://registry.npmjs.org/hyparquet-writer",
  "https://registry.npmjs.org/@divviup%2Fprio3",
  "https://registry.npmjs.org/@divviup%2Fvdaf",
];
// curl transport errors describe endpoint failures; local/tool errors fail execution.
const transportExits = new Set([
  5, 6, 7, 8, 16, 18, 28, 35, 47, 52, 55, 56, 60, 61, 80, 83, 90, 91, 92, 95, 96,
]);
const title = "Broken links found by lychee";
const start = "<!-- openconditions:links:managed:start -->";
const end = "<!-- openconditions:links:managed:end -->";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function assert(value, message) {
  if (!value) throw new Error(message);
}

export function checkRegistry(env = process.env, run = spawnSync) {
  const child = { ...env };
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"])
    delete child[key];
  return endpoints.map((url) => {
    const result = run(
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
      { env: child, encoding: "utf8", maxBuffer: 1_000_000 },
    );
    assert(
      !result.error && !result.signal && (result.status === 0 || transportExits.has(result.status)),
      "registry tool/configuration failure",
    );
    assert(result.status !== 0 || /^\d{3}$/.test(result.stdout), "invalid registry tool output");
    if (result.stderr) console.error(result.stderr);
    return { url, exit: result.status, status: result.status === 0 ? result.stdout : "000" };
  });
}

export function validate({ stats, exit, version, registry }) {
  assert(["0", "2"].includes(exit), "lychee execution failed or exit missing");
  assert(version === "lychee 0.24.2", "unexpected lychee version");
  const counts = [
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
    counts.every((key) => Number.isSafeInteger(stats?.[key]) && stats[key] >= 0),
    "missing/invalid lychee coverage",
  );
  assert(
    stats.total > 0 &&
      stats.unique > 0 &&
      stats.unique <= stats.total &&
      ["cached", "redirects", "remaps"].every((key) => stats[key] <= stats.total) &&
      stats.successful +
        stats.unknown +
        stats.unsupported +
        stats.timeouts +
        stats.excludes +
        stats.errors ===
        stats.total &&
      stats.unknown === 0,
    "empty/partial lychee coverage",
  );
  const diagnostics = [];
  for (const [key, count] of [
    ["error_map", stats.errors],
    ["timeout_map", stats.timeouts],
  ]) {
    const map = stats[key];
    assert(map && typeof map === "object" && !Array.isArray(map), "missing lychee diagnostics");
    const rows = Object.values(map);
    assert(
      rows.every(
        (list) =>
          Array.isArray(list) &&
          list.every((row) => typeof row?.url === "string" && typeof row.status?.text === "string"),
      ),
      "invalid lychee diagnostics",
    );
    const all = rows.flat();
    assert(
      count === 0 ? all.length === 0 : all.length > 0 && all.length <= count,
      "incomplete lychee diagnostics",
    );
    for (const [input, list] of Object.entries(map))
      for (const row of list) diagnostics.push(`${input}: ${row.url} — ${row.status.text}`);
  }
  const broken = stats.errors + stats.timeouts > 0;
  assert(exit === (broken ? "2" : "0"), "lychee exit/report disagreement");
  assert(
    Array.isArray(registry) &&
      registry.length === endpoints.length &&
      registry.every(
        (row, i) =>
          row.url === endpoints[i] &&
          (row.exit === 0 || transportExits.has(row.exit)) &&
          /^\d{3}$/.test(row.status) &&
          (row.exit === 0 || row.status === "000"),
      ),
    "incomplete/invalid registry checks",
  );
  const unhealthy = broken || registry.some((row) => row.exit !== 0 || !/^2\d\d$/.test(row.status));
  return {
    unhealthy,
    body: [
      `Link checks completed: ${unhealthy ? "unhealthy" : "healthy"}.`,
      counts.map((key) => `${key}: ${stats[key]}`).join("; "),
      "Scope: ./**/*.md; Git-ignore defaults and .lycheeignore apply. One-day cached, excluded and unsupported responses are not fresh network checks.",
      "Lychee diagnostics (input: URL — result):",
      ...diagnostics,
      "Direct npm metadata (3 endpoints):",
      ...registry.map((row) => `${row.url}: HTTP ${row.status}, curl exit ${row.exit}`),
      "Healthy recovery permits manual resolution review only. No issue is automatically closed or reopened.",
    ].join("\n\n"),
  };
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
  assert(match && digest(match[1]) === match[2], "managed diagnostics edited; preserve for review");
  return previous.slice(0, a[0].index) + section + previous.slice(b[0].index + end.length);
}
function owned(value) {
  assert(
    Number.isSafeInteger(value?.id) &&
      value.id > 0 &&
      Number.isSafeInteger(value.number) &&
      value.number > 0 &&
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
// Supplied by pinned actions/github-script; pagination and HTTP errors stay in Octokit.
// The workflow disables retries; an uncertain write is never repeated or rolled back.
export async function publish(github, report) {
  if (!report.unhealthy) return;
  const base = { owner: "OpenConditions", repo: "openconditions" };
  const issues = (
    await github.paginate(github.rest.issues.listForRepo, { ...base, state: "open", per_page: 100 })
  ).filter((issue) => !issue.pull_request && issue.title === title);
  assert(issues.length <= 1, "ambiguous report issues");
  const previous = issues[0] ? owned(issues[0]) : null;
  const body = managedBody(previous?.body ?? "", report.body);
  assert(
    Buffer.byteLength(body) <= 65_536,
    "report too large; raw diagnostics retained in artifact",
  );
  if (previous)
    assert(
      same(
        previous,
        owned((await github.rest.issues.get({ ...base, issue_number: previous.number })).data),
      ),
      "report changed before write",
    );
  const response = owned(
    (
      await (previous
        ? github.rest.issues.update({ ...base, issue_number: previous.number, body })
        : github.rest.issues.create({ ...base, title, body, labels: ["documentation"] }))
    ).data,
  );
  assert(
    response.body === body &&
      (!previous ||
        (response.id === previous.id &&
          response.number === previous.number &&
          response.node_id === previous.node_id)),
    "uncertain report write",
  );
  assert(
    same(
      response,
      owned((await github.rest.issues.get({ ...base, issue_number: response.number })).data),
    ),
    "uncertain report readback; no retry",
  );
}

function main(command, env) {
  const dir = "lychee";
  const path = (name) => join(dir, name);
  if (command === "registry") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path("registry.json"), JSON.stringify(checkRegistry(env)));
  } else {
    assert(command === "validate", "expected registry or validate");
    assert(env.CHECKS_OUTCOME === "success", "checkout/setup/checker/registry did not succeed");
    const report = validate({
      stats: JSON.parse(readFileSync(path("out.json"), "utf8")),
      exit: env.LYCHEE_EXIT_CODE,
      version: readFileSync(path("version.txt"), "utf8").trim(),
      registry: JSON.parse(readFileSync(path("registry.json"), "utf8")),
    });
    report.body = `# Link check\n\nSource: ${env.GITHUB_SHA ?? "local"}\nRun: https://github.com/OpenConditions/openconditions/actions/runs/${env.GITHUB_RUN_ID ?? "local"} (attempt ${env.GITHUB_RUN_ATTEMPT ?? "local"})\nChecked: ${new Date().toISOString()}\n\n${report.body}`;
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${report.body}\n`);
    writeFileSync(path("report.json"), JSON.stringify(report));
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main(process.argv[2], process.env);
  } catch (error) {
    console.error(`Link check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
