import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = ".github/workflows/ci.yml";
const coverage = [
  "validate CI source",
  "typecheck / test",
  "python lint / test (openlr-resolver)",
  "interop (libtraff, python-tuf)",
  "production dependency audit",
  "required CI",
  "full main qualification",
];
const activeStatuses = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const shaPattern = /^[a-f0-9]{40}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Only GET is retried: a failed POST may already have created a recovery run. */
export function createGithubApi(token, adapter = {}) {
  assert(typeof token === "string" && token.length > 0, "missing Actions token");
  const fetchRequest = adapter.fetch ?? globalThis.fetch;
  const sleep = adapter.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = adapter.now ?? Date.now;
  const deadline = now() + 60_000;
  let retries = 0;
  return async (route, body) => {
    assert(route.startsWith("/repos/"), "invalid API route");
    for (;;) {
      assert(now() < deadline, "reconciliation API deadline exceeded");
      let response;
      try {
        response = await fetchRequest(`https://api.github.com${route}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2026-03-10",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - now()))),
          redirect: "error",
        });
      } catch {
        if (body !== undefined || retries >= 3) throw new Error("GitHub API request failed");
      }
      const transient = !response || [429, 500, 502, 503, 504].includes(response.status);
      if (transient && body === undefined && retries < 3) {
        const delay = 1000 * 2 ** retries++;
        assert(now() + delay < deadline, "reconciliation API deadline exceeded");
        await sleep(delay);
        continue;
      }
      assert(response?.ok, `GitHub API failed (${response?.status ?? "network"})`);
      try {
        return await response.json();
      } catch {
        throw new Error("GitHub API returned invalid JSON");
      }
    }
  };
}

export async function reconcileMainValidation({ api, repository }) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "invalid repository");
  const root = `/repos/${repository}`;
  const repo = await api(root);
  assert(
    repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
      positiveInteger(repo.id) &&
      repo.default_branch === "main",
    "unexpected repository or default branch",
  );
  const currentSha = async () => {
    const ref = await api(`${root}/git/ref/heads/main`);
    assert(
      ref?.ref === "refs/heads/main" &&
        ref.object?.type === "commit" &&
        shaPattern.test(ref.object.sha),
      "invalid main ref",
    );
    return ref.object.sha;
  };
  const sha = await currentSha();
  const workflow = await api(`${root}/actions/workflows/ci.yml`);
  assert(
    positiveInteger(workflow?.id) &&
      workflow.name === "CI" &&
      workflow.path === workflowPath &&
      workflow.state === "active",
    "unexpected CI workflow identity",
  );
  const recoveryTitle = `Main validation recovery ${sha}`;

  async function pages(route, field) {
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const value = await api(
        `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      assert(
        Number.isSafeInteger(value?.total_count) &&
          value.total_count >= 0 &&
          value.total_count <= 1000 &&
          Array.isArray(value[field]),
        "invalid or excessive paginated API response",
      );
      rows.push(...value[field]);
      if (rows.length >= value.total_count) return rows;
      assert(value[field].length > 0, "incomplete paginated API response");
    }
    throw new Error("incomplete paginated API response");
  }
  function runSchema(run) {
    assert(
      positiveInteger(run?.id) &&
        positiveInteger(run.workflow_id) &&
        positiveInteger(run.run_attempt) &&
        typeof run.path === "string" &&
        typeof run.head_sha === "string" &&
        shaPattern.test(run.head_sha) &&
        (typeof run.head_branch === "string" || run.head_branch === null) &&
        typeof run.event === "string" &&
        typeof run.display_title === "string" &&
        (activeStatuses.has(run.status) || run.status === "completed") &&
        positiveInteger(run.repository?.id) &&
        typeof run.repository.full_name === "string" &&
        (run.head_repository === null ||
          (positiveInteger(run.head_repository?.id) &&
            typeof run.head_repository.full_name === "string")),
      "invalid CI run schema",
    );
  }
  function equivalent(run) {
    return (
      run?.repository?.id === repo.id &&
      run?.head_repository?.id === repo.id &&
      run.repository.full_name?.toLowerCase() === repo.full_name.toLowerCase() &&
      run.head_repository.full_name?.toLowerCase() === repo.full_name.toLowerCase() &&
      run.workflow_id === workflow.id &&
      run.path === workflowPath &&
      run.head_sha === sha &&
      run.head_branch === "main" &&
      ["push", "workflow_dispatch"].includes(run.event) &&
      (run.event !== "workflow_dispatch" ||
        !run.display_title?.startsWith("Main validation recovery ") ||
        run.display_title === recoveryTitle)
    );
  }
  function validateRun(run, id) {
    runSchema(run);
    assert(
      equivalent(run) && run.id === id && positiveInteger(id) && positiveInteger(run.run_attempt),
      "invalid CI run readback",
    );
    assert(activeStatuses.has(run.status) || run.status === "completed", "invalid CI run status");
    return run;
  }
  async function qualified(run) {
    if (run.status !== "completed" || run.conclusion !== "success") return false;
    const rows = await pages(
      `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      "jobs",
    );
    for (const job of rows) {
      assert(
        positiveInteger(job?.id) &&
          job.run_id === run.id &&
          job.run_attempt === run.run_attempt &&
          job.head_sha === sha &&
          typeof job.name === "string" &&
          typeof job.status === "string",
        "invalid CI job attempt metadata",
      );
    }
    const complete = coverage.every((name) => {
      const matches = rows.filter((job) => job.name === name);
      return (
        matches.length === 1 &&
        matches[0].run_id === run.id &&
        matches[0].run_attempt === run.run_attempt &&
        matches[0].head_sha === sha &&
        matches[0].status === "completed" &&
        matches[0].conclusion === "success"
      );
    });
    const latest = validateRun(await api(`${root}/actions/runs/${run.id}`), run.id);
    assert(
      latest.run_attempt === run.run_attempt &&
        latest.status === run.status &&
        latest.conclusion === run.conclusion,
      "CI attempt changed during qualification",
    );
    return complete;
  }
  function receipt(status, run) {
    return { status, sha, runId: run.id, attempt: run.run_attempt };
  }

  const runs = await pages(
    `${root}/actions/workflows/${workflow.id}/runs?head_sha=${sha}`,
    "workflow_runs",
  );
  let recoveryAttempt;
  let pending;
  for (const listed of runs) {
    runSchema(listed);
    if (!equivalent(listed)) continue;
    const run = validateRun(await api(`${root}/actions/runs/${listed.id}`), listed.id);
    if (await qualified(run)) return receipt("qualified", run);
    if (activeStatuses.has(run.status)) pending = run;
    if (
      run.event === "workflow_dispatch" &&
      run.display_title === recoveryTitle &&
      run.actor?.login === "github-actions[bot]"
    )
      recoveryAttempt = run;
  }
  if (pending) return receipt("pending", pending);
  assert(
    !recoveryAttempt,
    `main ${sha}: automatic recovery already attempted (run ${recoveryAttempt?.id}, attempt ${recoveryAttempt?.run_attempt}); inspect the red run and use explicit maintainer CI dispatch`,
  );
  assert((await currentSha()) === sha, "main advanced before dispatch; retry reconciliation");

  // The returned ID is read back through a fixed API route. Never follow URLs
  // from event payloads, artifacts, or even the dispatch response.
  const created = await api(`${root}/actions/workflows/${workflow.id}/dispatches`, {
    ref: "main",
    inputs: { expected_main_sha: sha },
  });
  assert(
    positiveInteger(created?.workflow_run_id),
    "dispatch did not return a run identity; next backstop must reconcile",
  );
  const run = validateRun(
    await api(`${root}/actions/runs/${created.workflow_run_id}`),
    created.workflow_run_id,
  );
  assert(
    run.event === "workflow_dispatch" &&
      run.display_title === recoveryTitle &&
      run.actor?.login === "github-actions[bot]",
    "dispatch readback did not match automatic recovery",
  );
  return receipt("dispatched", run);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env;
    const result = await reconcileMainValidation({
      api: createGithubApi(env.GH_TOKEN),
      repository: env.GITHUB_REPOSITORY,
    });
    const text = JSON.stringify(result);
    console.log(text);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, `Main validation: ${text}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "main reconciliation failed");
    process.exitCode = 1;
  }
}
