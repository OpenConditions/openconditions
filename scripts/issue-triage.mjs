import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = "OpenConditions/openconditions";
const repositoryId = 1276024943;
const root = `/repos/${repository}`;
const owned = ["needs-triage", "needs-info", "blocked"];
const targets = [
  ...owned,
  "dependencies",
  "documentation",
  "feed",
  "ci",
  "docker",
  "good first issue",
  "help wanted",
];
const actions = new Set(["opened", "reopened", "closed"]);
function assert(value, message) {
  if (!value) throw new Error(message);
}
const positive = (value) => Number.isSafeInteger(value) && value > 0;
function timestamp(value) {
  assert(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "invalid timestamp",
  );
  return Date.parse(value);
}
function labels(rows) {
  assert(Array.isArray(rows), "invalid labels");
  const result = rows
    .map((row) => {
      assert(
        positive(row?.id) && typeof row.name === "string" && row.name.length > 0,
        "invalid label identity",
      );
      return { id: row.id, name: row.name };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  assert(
    new Set(result.map((x) => x.id)).size === result.length &&
      new Set(result.map((x) => x.name)).size === result.length,
    "duplicate labels",
  );
  return result;
}
function issue(value) {
  assert(
    positive(value?.id) &&
      positive(value.number) &&
      typeof value.node_id === "string" &&
      value.node_id.length > 0 &&
      !value.pull_request,
    "invalid issue identity or PR record",
  );
  assert(["open", "closed"].includes(value.state), "invalid issue state");
  timestamp(value.created_at);
  timestamp(value.updated_at);
  assert(
    value.state === "open"
      ? value.closed_at === null
      : timestamp(value.closed_at) <= timestamp(value.updated_at),
    "invalid issue closure",
  );
  return {
    id: value.id,
    node_id: value.node_id,
    number: value.number,
    state: value.state,
    created_at: value.created_at,
    updated_at: value.updated_at,
    closed_at: value.closed_at,
    labels: labels(value.labels),
  };
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The production CLI has no API-origin selector. The adapter permits loopback HTTP fixtures. */
export function createApi(token, { origin = "https://api.github.com", readOnly = false } = {}) {
  assert(typeof token === "string" && token.length > 0, "missing Actions token");
  assert(
    origin === "https://api.github.com" || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin),
    "invalid API origin",
  );
  const deadline = Date.now() + 60_000;
  return async (method, route, body) => {
    assert(route.startsWith(`${root}/`) || route === root, "invalid owning repository route");
    assert(
      method === "GET" || (!readOnly && ["POST", "DELETE"].includes(method)),
      "read-only adapter forbids mutation",
    );
    assert(Date.now() < deadline, "API deadline exceeded");
    const response = await fetch(`${origin}${route}`, {
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
    assert(response.ok, `GitHub API ${method} failed (${response.status})`);
    const text = await response.text();
    assert(Buffer.byteLength(text) <= 5_000_000, "excessive API response");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("invalid API JSON");
    }
  };
}
async function pages(api, route) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const values = await api(
      "GET",
      `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    assert(Array.isArray(values) && values.length <= 100, "invalid paginated API array");
    rows.push(...values);
    if (values.length < 100) return rows;
  }
  throw new Error("pagination limit exceeded; inventory incomplete");
}
async function repoAndLabels(api) {
  const repo = await api("GET", root);
  assert(
    repo?.id === repositoryId && repo.full_name === repository && repo.default_branch === "main",
    "wrong repository authority",
  );
  const rows = await pages(api, `${root}/labels`);
  labels(rows);
  for (const row of rows) if (row.archived_at != null) timestamp(row.archived_at);
  return labels(rows.filter((row) => row.archived_at == null));
}
async function history(api, route) {
  const rows = (await pages(api, `${route}/events`))
    .map((row) => {
      assert(positive(row?.id) && typeof row.event === "string", "invalid event identity");
      timestamp(row.created_at);
      if (["labeled", "unlabeled"].includes(row.event))
        assert(typeof row.label?.name === "string", "invalid label event");
      return {
        id: row.id,
        event: row.event,
        created_at: row.created_at,
        actor: row.actor?.id ?? null,
        label: row.label?.name ?? null,
      };
    })
    .sort((a, b) => a.id - b.id);
  assert(new Set(rows.map((x) => x.id)).size === rows.length, "duplicate event pagination");
  return rows;
}

export async function lifecycle({ api, event, now = Date.now }) {
  assert(
    event?.repository?.id === repositoryId && event.repository.full_name === repository,
    "wrong event repository",
  );
  assert(
    actions.has(event.action) &&
      positive(event.number) &&
      event.number === event.issue?.number &&
      positive(event.sender?.id),
    "invalid event action, issue number or sender",
  );
  if (event.issue.pull_request) return { status: "excluded-PR" };
  const source = issue(event.issue);
  const time = timestamp(source.updated_at);
  assert((event.action === "closed") === (source.state === "closed"), "event state mismatch");
  assert(
    event.action !== "opened" || source.created_at === source.updated_at,
    "opened event timestamp mismatch",
  );
  if (time > now() || now() - time > 10 * 60_000)
    return { status: "stale", reason: "event outside ten-minute freshness bound" };
  const available = await repoAndLabels(api);
  const missing = targets.filter((name) => !available.some((x) => x.name === name));
  assert(!missing.length, `activation blocked: missing target labels: ${missing.join(", ")}`);
  const route = `${root}/issues/${source.number}`;
  async function current() {
    const value = issue(await api("GET", route));
    assert(
      value.id === source.id &&
        value.node_id === source.node_id &&
        value.number === source.number &&
        value.created_at === source.created_at,
      "issue binding changed",
    );
    return value;
  }
  async function observe() {
    const first = await current();
    const events = await history(api, route);
    const second = await current();
    assert(same(first, second), "issue changed during observation; race requires review");
    return { issue: second, events };
  }
  let snapshot = await observe();
  const transitions = snapshot.events.filter((x) => ["closed", "reopened"].includes(x.event));
  let anchor = 0;
  if (event.action !== "opened") {
    const matches = transitions.filter(
      (x) =>
        x.event === event.action &&
        x.created_at === source.updated_at &&
        x.actor === event.sender.id,
    );
    if (matches.length !== 1)
      return { status: "stale", reason: "missing or ambiguous transition authority" };
    anchor = matches[0].id;
  }
  const newer = (row) => row.id !== anchor && timestamp(row.created_at) >= time;
  if (
    transitions.some(newer) ||
    snapshot.issue.state !== source.state ||
    snapshot.issue.closed_at !== source.closed_at
  )
    return { status: "stale", reason: "later state transition" };
  if (
    snapshot.events.some(
      (x) => newer(x) && ["labeled", "unlabeled"].includes(x.event) && owned.includes(x.label),
    )
  )
    return { status: "preserved", reason: "workflow-label decision after event" };
  if (snapshot.issue.updated_at !== source.updated_at)
    return { status: "preserved", reason: "issue updated after event" };
  const changes =
    source.state === "open"
      ? snapshot.issue.labels.some((x) => x.name === "needs-triage")
        ? []
        : [{ method: "POST", name: "needs-triage" }]
      : owned
          .filter((name) => snapshot.issue.labels.some((x) => x.name === name))
          .map((name) => ({ method: "DELETE", name }));
  let applied = 0;
  for (const change of changes) {
    // No full-label replacement. Re-read before every individual owned-label operation.
    assert(
      same(await repoAndLabels(api), available),
      "repository label identity changed; activation blocked",
    );
    const before = await current();
    const events = await history(api, route);
    assert(
      same(before, snapshot.issue) && same(events, snapshot.events),
      "issue/history changed before mutation; race requires review",
    );
    const expected =
      change.method === "POST"
        ? labels([...before.labels, available.find((x) => x.name === change.name)])
        : before.labels.filter((x) => x.name !== change.name);
    try {
      const result = await api(
        change.method,
        change.method === "POST"
          ? `${route}/labels`
          : `${route}/labels/${encodeURIComponent(change.name)}`,
        change.method === "POST" ? { labels: [change.name] } : undefined,
      );
      assert(same(labels(result), expected), "label response mismatch");
    } catch (error) {
      throw new Error(`write outcome uncertain; no retry or rollback: ${error.message}`);
    }
    const after = await observe();
    assert(
      same({ ...after.issue, updated_at: before.updated_at, labels: before.labels }, before) &&
        same(after.issue.labels, expected),
      "issue changed after write; outcome requires review",
    );
    const added = after.events.filter((x) => !events.some((old) => old.id === x.id));
    assert(
      same(
        after.events.filter((x) => events.some((old) => old.id === x.id)),
        events,
      ) &&
        added.length === 1 &&
        added[0].actor === 41898282 &&
        timestamp(added[0].created_at) >= timestamp(before.updated_at) &&
        added[0].created_at === after.issue.updated_at &&
        added[0].event === (change.method === "POST" ? "labeled" : "unlabeled") &&
        added[0].label === change.name,
      "history changed or write event uncertain; stop for review",
    );
    snapshot = after;
    applied++;
  }
  return { status: applied ? "applied" : "no-op", issue: source.number, operations: applied };
}

export async function driftReport({ api }) {
  const available = await repoAndLabels(api);
  const rows = await pages(api, `${root}/issues?state=all&sort=created&direction=asc`);
  const seen = new Set();
  const issues = [];
  for (const row of rows) {
    assert(
      positive(row?.id) && positive(row.number) && !seen.has(row.id),
      "invalid or duplicate issue inventory",
    );
    seen.add(row.id);
    if (!row.pull_request) issues.push(issue(row));
  }
  return {
    mode: "read-only-observation",
    repository,
    issueCount: issues.length,
    missingTargets: targets.filter((name) => !available.some((x) => x.name === name)),
    closedActive: issues
      .filter((x) => x.state === "closed")
      .map((x) => ({
        number: x.number,
        labels: x.labels.filter((l) => owned.includes(l.name)).map((l) => l.name),
      }))
      .filter((x) => x.labels.length),
    repairsPerformed: 0,
  };
}

async function main() {
  // These commands run directly in Actions, outside the Turbo task cache.
  const env = process.env;
  const mode = process.argv[2];
  assert(
    process.argv.length === 3 && ["lifecycle", "drift"].includes(mode),
    "usage: node scripts/issue-triage.mjs lifecycle|drift",
  );
  assert(
    env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_REPOSITORY_ID === String(repositoryId) &&
      env.GITHUB_REF === "refs/heads/main",
    "trusted owning main required",
  );
  const path = mode === "lifecycle" ? "issue-label-lifecycle.yml" : "issue-triage-drift.yml";
  assert(
    env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/${path}@refs/heads/main` &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_WORKFLOW_SHA ?? ""),
    "unexpected trusted workflow identity",
  );
  const api = createApi(env.GITHUB_TOKEN, { readOnly: mode === "drift" });
  let result;
  if (mode === "lifecycle") {
    assert(
      env.GITHUB_EVENT_NAME === "issues" && env.ISSUE_TRIAGE_LIFECYCLE_ENABLED === "true",
      "issue lifecycle activation blocked",
    );
    result = await lifecycle({
      api,
      event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    });
  } else {
    assert(
      ["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
      "invalid drift event",
    );
    result = await driftReport({ api });
    writeFileSync("issue-triage-drift.json", `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
  }
  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Issue triage ${mode}\n\n\`\`\`json\n${text}\n\`\`\`\n`,
    );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
