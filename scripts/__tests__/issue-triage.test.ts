import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const moduleUrl = new URL("../issue-triage.mjs", import.meta.url).href;
const at = "2026-10-27T05:00:00Z";
const later = "2026-10-27T05:00:02Z";
const old = "2026-10-27T04:59:00Z";
const repo = { id: 1276024943, full_name: "OpenConditions/openconditions", default_branch: "main" };
const names = [
  "needs-triage",
  "needs-info",
  "blocked",
  "dependencies",
  "documentation",
  "feed",
  "ci",
  "docker",
  "good first issue",
  "help wanted",
];
const label = (name: string) => ({ id: names.indexOf(name) + 100, name });
const baseIssue = () => ({
  id: 800,
  node_id: "I_test800",
  number: 7,
  state: "open",
  created_at: at,
  updated_at: at,
  closed_at: null as string | null,
  labels: [label("documentation")],
});
type EventRow = {
  id: number;
  event: string;
  created_at: string;
  actor: { id: number };
  label?: { name: string };
};
type RequestRow = { method: string; path: string; body: unknown };
type Fixture = {
  issue: ReturnType<typeof baseIssue> & { pull_request?: object };
  event: {
    action: string;
    number: number | string;
    repository: typeof repo;
    sender: { id: number | null };
    issue: ReturnType<typeof baseIssue> & { pull_request?: object };
  };
  events: EventRow[];
  labels: ReturnType<typeof label>[];
  requests: RequestRow[];
  hook?: (
    request: RequestRow,
  ) => { status?: number; body?: unknown; disconnect?: boolean } | undefined;
  issues?: object[];
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function fixture(action = "opened"): Fixture {
  const issue = baseIssue();
  const events: EventRow[] = [];
  if (action !== "opened") {
    issue.created_at = old;
    issue.state = action === "closed" ? "closed" : "open";
    issue.closed_at = action === "closed" ? at : null;
    events.push({ id: 20, event: action, created_at: at, actor: { id: 99 } });
  }
  return {
    issue,
    event: {
      action,
      number: 7,
      repository: repo,
      sender: { id: 99 },
      issue: structuredClone(issue),
    },
    events,
    labels: names.map(label),
    requests: [],
  };
}

async function run(f: Fixture, mode = "lifecycle", readOnly = false) {
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = {
      method: req.method ?? "GET",
      path: req.url ?? "",
      body: text ? JSON.parse(text) : null,
    };
    f.requests.push(request);
    const custom = f.hook?.(request);
    if (custom?.disconnect) {
      req.socket.destroy();
      return;
    }
    const url = new URL(request.path, "http://localhost");
    const path = url.pathname.replace("/repos/OpenConditions/openconditions", "");
    let body: unknown = null;
    let status = custom?.status ?? 200;
    if (custom && "body" in custom) body = custom.body;
    else if (status !== 200) body = {};
    else if (path === "") body = repo;
    else if (path === "/labels") body = f.labels;
    else if (path === "/issues/7" && request.method === "GET") body = f.issue;
    else if (path === "/issues/7/events")
      body = Number(url.searchParams.get("page")) === 1 ? f.events : [];
    else if (path === "/issues") {
      const rows = f.issues ?? [f.issue];
      const page = Number(url.searchParams.get("page"));
      body = rows.slice((page - 1) * 100, page * 100);
    } else if (path === "/issues/7/labels" && request.method === "POST") {
      const additions = (request.body as { labels: string[] }).labels;
      for (const name of additions)
        if (!f.issue.labels.some((x) => x.name === name)) f.issue.labels.push(label(name));
      f.issue.updated_at = later;
      f.events.push({
        id: 100 + f.events.length,
        event: "labeled",
        created_at: later,
        actor: { id: 41898282 },
        label: { name: additions[0] },
      });
      body = f.issue.labels;
    } else if (path.startsWith("/issues/7/labels/") && request.method === "DELETE") {
      const name = decodeURIComponent(path.slice("/issues/7/labels/".length));
      f.issue.labels = f.issue.labels.filter((x) => x.name !== name);
      f.issue.updated_at = later;
      f.events.push({
        id: 100 + f.events.length,
        event: "unlabeled",
        created_at: later,
        actor: { id: 41898282 },
        label: { name },
      });
      body = f.issue.labels;
    } else {
      status = 404;
      body = {};
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const input = {
    origin: `http://127.0.0.1:${address.port}`,
    event: f.event,
    mode,
    readOnly,
    now: Date.parse(later),
  };
  const script = `import {createApi, lifecycle, driftReport} from ${JSON.stringify(moduleUrl)};
let text='';for await(const chunk of process.stdin) text+=chunk;
const x=JSON.parse(text);try{const api=createApi('fixture-token',{origin:x.origin,readOnly:x.readOnly});
const result=await(x.mode==='drift'?driftReport({api}):lifecycle({api,event:x.event,now:()=>x.now}));
process.stdout.write(JSON.stringify(result));}catch(e){process.stderr.write(e.message);process.exitCode=1;}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
    env: {},
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (x) => {
    stdout += x;
  });
  child.stderr.on("data", (x) => {
    stderr += x;
  });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stderr, result: stdout ? JSON.parse(stdout) : null };
}
const writes = (f: Fixture) => f.requests.filter((x) => x.method !== "GET");

test.each(["opened", "reopened"])(
  "%s adds only triage and duplicate delivery is idempotent",
  async (action) => {
    const f = fixture(action);
    expect((await run(f)).code).toBe(0);
    expect(f.issue.labels.map((x) => x.name).sort()).toEqual(["documentation", "needs-triage"]);
    expect(writes(f)).toHaveLength(1);
    expect(writes(f)[0].body).toEqual({ labels: ["needs-triage"] });
    expect((await run(f)).code).toBe(0);
    expect(writes(f)).toHaveLength(1);
  },
);
test("closed removes three owned labels and preserves unrelated labels and issue state", async () => {
  const f = fixture("closed");
  f.issue.labels.push(...names.slice(0, 3).map(label));
  f.events.unshift({
    id: 10,
    event: "labeled",
    created_at: old,
    actor: { id: 99 },
    label: { name: "needs-info" },
  });
  expect((await run(f)).code).toBe(0);
  expect(f.issue.labels).toEqual([label("documentation")]);
  expect(writes(f).map((x) => x.method)).toEqual(["DELETE", "DELETE", "DELETE"]);
  expect(f.issue.state).toBe("closed");
  expect((await run(f)).code).toBe(0);
  expect(writes(f)).toHaveLength(3);
});
test("PR payload and API PR record cannot acquire lifecycle labels", async () => {
  const f = fixture();
  f.event.issue.pull_request = {};
  expect((await run(f)).code).toBe(0);
  expect(f.requests).toHaveLength(0);
  const g = fixture();
  g.issue.pull_request = {};
  expect((await run(g)).code).toBe(1);
  expect(writes(g)).toHaveLength(0);
});
test.each(["repository", "number", "database ID", "sender", "action", "timestamp"])(
  "rejects incorrect %s binding",
  async (kind) => {
    const f = fixture();
    if (kind === "repository") f.event.repository = { ...repo, id: 1 };
    if (kind === "number") f.event.number = "7; echo bad";
    if (kind === "database ID") f.event.issue.id = 1;
    if (kind === "sender") f.event.sender = { id: null };
    if (kind === "action") f.event.action = "edited";
    if (kind === "timestamp") f.event.issue.updated_at = "not-a-date";
    expect((await run(f)).code).toBe(1);
    expect(writes(f)).toHaveLength(0);
  },
);
test.each([
  "expired",
  "human label removal",
  "human edit",
  "later close-reopen",
  "ambiguous same-second transition",
])("preserves decisions for %s", async (kind) => {
  const f = fixture("reopened");
  if (kind === "expired") f.event.issue.updated_at = "2026-10-27T04:00:00Z";
  if (kind === "human label removal")
    f.events.push({
      id: 21,
      event: "unlabeled",
      created_at: at,
      actor: { id: 88 },
      label: { name: "needs-triage" },
    });
  if (kind === "human edit") f.issue.updated_at = later;
  if (kind === "later close-reopen")
    f.events.push(
      { id: 21, event: "closed", created_at: at, actor: { id: 99 } },
      { id: 22, event: "reopened", created_at: later, actor: { id: 99 } },
    );
  if (kind === "ambiguous same-second transition")
    f.events.push({ id: 21, event: "reopened", created_at: at, actor: { id: 99 } });
  const out = await run(f);
  expect(out.code).toBe(0);
  expect(out.result.status).toMatch(/preserved|stale/);
  expect(writes(f)).toHaveLength(0);
});
test.each(["before", "after"])(
  "close race %s mutation stops further writes and reports uncertainty",
  async (when) => {
    const f = fixture();
    let issueReads = 0;
    f.hook = (r) => {
      if (r.path.endsWith("/issues/7") && ++issueReads === (when === "before" ? 3 : 4)) {
        f.issue.state = "closed";
        f.issue.closed_at = later;
        f.issue.updated_at = later;
        f.events.push({ id: 500, event: "closed", created_at: later, actor: { id: 99 } });
      }
      return undefined;
    };
    const out = await run(f);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/changed|race|uncertain/);
    expect(writes(f)).toHaveLength(when === "before" ? 0 : 1);
  },
);
test("reopen between closed-label deletions prevents subsequent deletion", async () => {
  const f = fixture("closed");
  f.issue.labels.push(...names.slice(0, 3).map(label));
  let changed = false;
  f.hook = (r) => {
    if (writes(f).length === 1 && !changed && r.method === "GET") {
      changed = true;
      f.issue.state = "open";
      f.issue.closed_at = null;
      f.issue.updated_at = later;
      f.events.push({ id: 500, event: "reopened", created_at: later, actor: { id: 99 } });
    }
    return undefined;
  };
  expect((await run(f)).code).toBe(1);
  expect(writes(f)).toHaveLength(1);
});
test("missing target labels blocks activation without label creation", async () => {
  const f = fixture();
  f.labels = f.labels.filter((x) => x.name !== "needs-triage");
  const out = await run(f);
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/missing.*needs-triage/);
  expect(writes(f)).toHaveLength(0);
});
test.each([403, 500, "disconnect"])("unknown/failed write %s is never retried", async (failure) => {
  const f = fixture();
  f.hook = (r) =>
    r.method === "POST"
      ? failure === "disconnect"
        ? { disconnect: true }
        : { status: Number(failure) }
      : undefined;
  const out = await run(f);
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/write.*uncertain/);
  expect(writes(f)).toHaveLength(1);
});
test("lost response after applied write fails and redelivery respects human removal", async () => {
  const f = fixture();
  f.hook = (r) => {
    if (r.method === "POST") {
      f.issue.labels.push(label("needs-triage"));
      return { disconnect: true };
    }
    return undefined;
  };
  expect((await run(f)).code).toBe(1);
  f.hook = undefined;
  f.issue.labels = [label("documentation")];
  f.events.push({
    id: 21,
    event: "unlabeled",
    created_at: later,
    actor: { id: 99 },
    label: { name: "needs-triage" },
  });
  expect((await run(f)).result.status).toMatch(/preserved/);
  expect(writes(f)).toHaveLength(1);
});
test.each(["malformed", "permission"])("read %s failure cannot mutate", async (kind) => {
  const f = fixture();
  f.hook = (r) =>
    r.path.endsWith("/issues/7")
      ? kind === "malformed"
        ? { body: {} }
        : { status: 403 }
      : undefined;
  expect((await run(f)).code).toBe(1);
  expect(writes(f)).toHaveLength(0);
});
test("human unrelated-label change during mutation is preserved and not overwritten", async () => {
  const f = fixture();
  let once = false;
  f.hook = (r) => {
    if (r.method === "POST" && !once) {
      once = true;
      f.issue.labels.push(label("feed"));
    }
    return undefined;
  };
  expect((await run(f)).code).toBe(1);
  expect(f.issue.labels.map((x) => x.name)).toContain("feed");
  expect(writes(f)).toHaveLength(1);
});
test("drift report paginates issue-only records, reports missing references and never writes", async () => {
  const f = fixture();
  const closed = {
    ...baseIssue(),
    state: "closed",
    closed_at: at,
    labels: [label("blocked")],
    number: 8,
    id: 801,
  };
  f.issues = [
    ...Array.from({ length: 100 }, (_, i) => ({
      ...baseIssue(),
      number: i + 10,
      id: i + 900,
      pull_request: {},
    })),
    f.issue,
    closed,
  ];
  f.labels = f.labels.filter((x) => x.name !== "feed");
  const out = await run(f, "drift", true);
  expect(out.code).toBe(0);
  expect(out.result.issueCount).toBe(2);
  expect(out.result.closedActive).toEqual([{ number: 8, labels: ["blocked"] }]);
  expect(out.result.missingTargets).toEqual(["feed"]);
  expect(writes(f)).toHaveLength(0);
  expect(f.requests.some((x) => x.path.includes("page=2"))).toBe(true);
});
test("read-only adapter refuses a lifecycle write before HTTP", async () => {
  const f = fixture();
  const out = await run(f, "lifecycle", true);
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/read-only/);
  expect(writes(f)).toHaveLength(0);
});

test("transition IDs are identities rather than an assumed event clock", async () => {
  const f = fixture("reopened");
  f.events.push(
    { id: 5, event: "closed", created_at: later, actor: { id: 99 } },
    { id: 6, event: "reopened", created_at: later, actor: { id: 99 } },
  );
  const out = await run(f);
  expect(out.code).toBe(0);
  expect(out.result.status).toBe("stale");
  expect(writes(f)).toHaveLength(0);
});

test.each(["closed", "reopened"])(
  "a %s event cannot erase later human workflow-label decisions",
  async (action) => {
    const f = fixture(action);
    if (action === "closed") f.issue.labels.push(label("blocked"));
    f.events.push({
      id: 22,
      event: "labeled",
      created_at: later,
      actor: { id: 99 },
      label: { name: "blocked" },
    });
    const out = await run(f);
    expect(out.result.status).toBe("preserved");
    expect(writes(f)).toHaveLength(0);
  },
);

test("read-only observation fails for truncated or duplicate pagination", async () => {
  const f = fixture();
  f.issues = Array.from({ length: 101 }, () => f.issue);
  expect((await run(f, "drift", true)).code).toBe(1);
  expect(writes(f)).toHaveLength(0);
  const g = fixture();
  g.hook = (r) =>
    r.path.includes("/events?")
      ? {
          body: [...Array(100)].map((_, i) => ({
            id: i + 1,
            event: "assigned",
            created_at: old,
            actor: { id: 99 },
          })),
        }
      : undefined;
  const out = await run(g);
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/pagination/);
  expect(writes(g)).toHaveLength(0);
});

test.each(["disabled", "wrong-ref", "wrong-workflow", "wrong-repository", "wrong-mode"])(
  "production command rejects %s before any authority is used",
  async (kind) => {
    const env = {
      GITHUB_REPOSITORY: repo.full_name,
      GITHUB_REPOSITORY_ID: String(repo.id),
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: `${repo.full_name}/.github/workflows/issue-label-lifecycle.yml@refs/heads/main`,
      GITHUB_WORKFLOW_SHA: "a".repeat(40),
      GITHUB_EVENT_NAME: "issues",
      ISSUE_TRIAGE_LIFECYCLE_ENABLED: "false",
      GITHUB_TOKEN: "fixture-token",
    };
    if (kind === "wrong-ref") env.GITHUB_REF = "refs/heads/feature";
    if (kind === "wrong-workflow") env.GITHUB_WORKFLOW_REF = "untrusted.yml@refs/heads/main";
    if (kind === "wrong-repository") env.GITHUB_REPOSITORY_ID = "1";
    const child = spawn(
      process.execPath,
      [fileURLToPath(moduleUrl), kind === "wrong-mode" ? "unknown" : "lifecycle"],
      { env },
    );
    let stderr = "";
    child.stderr.on("data", (x) => {
      stderr += x;
    });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    expect(stderr).toMatch(/blocked|required|unexpected|usage/);
  },
);

test("archived target labels block lifecycle and are reported unavailable", async () => {
  const f = fixture();
  f.hook = (r) =>
    r.path.startsWith("/repos/OpenConditions/openconditions/labels?")
      ? {
          body: f.labels.map((x) => ({ ...x, archived_at: x.name === "needs-triage" ? at : null })),
        }
      : undefined;
  expect((await run(f)).code).toBe(1);
  expect(writes(f)).toHaveLength(0);
  expect((await run(f, "drift", true)).result.missingTargets).toContain("needs-triage");
});

test("repository label identity is rechecked before mutation rather than recreated", async () => {
  const f = fixture();
  let reads = 0;
  f.hook = (r) => {
    if (r.path.startsWith("/repos/OpenConditions/openconditions/labels?") && ++reads === 2)
      f.labels = f.labels.filter((x) => x.name !== "needs-triage");
    return undefined;
  };
  expect((await run(f)).code).toBe(1);
  expect(writes(f)).toHaveLength(0);
});

test("read-only API failure cannot produce a successful clean report", async () => {
  const f = fixture();
  f.hook = (r) => (r.path.includes("/issues?") ? { status: 403 } : undefined);
  const out = await run(f, "drift", true);
  expect(out.code).toBe(1);
  expect(out.result).toBe(null);
  expect(writes(f)).toHaveLength(0);
});

test("a previously unseen old bot event cannot confirm the current write", async () => {
  const f = fixture();
  f.hook = (r) => {
    if (r.path.includes("/events?") && writes(f).length === 1) {
      return {
        body: [
          {
            id: 200,
            event: "labeled",
            created_at: old,
            actor: { id: 41898282 },
            label: { name: "needs-triage" },
          },
        ],
      };
    }
    return undefined;
  };
  const out = await run(f);
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/uncertain|history/);
  expect(writes(f)).toHaveLength(1);
});
