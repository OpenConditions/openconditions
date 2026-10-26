import { fileURLToPath } from "node:url";

const requiredJobs = ["source", "ci", "python-ci", "interop", "production-audit"];
const ordinaryJobs = new Set(["ci", "python-ci", "interop"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkCiResults(event: string, needs: unknown, fullMain = false): void {
  if (!["pull_request", "push", "workflow_dispatch", "schedule"].includes(event)) {
    throw new Error("unsupported CI event");
  }
  const expected = fullMain ? [...requiredJobs, "required-ci"] : requiredJobs;
  if (!object(needs) || Object.keys(needs).length !== expected.length) {
    throw new Error("missing or unexpected CI job");
  }
  for (const name of expected) {
    const job = needs[name];
    const result = event === "schedule" && ordinaryJobs.has(name) ? "skipped" : "success";
    if (!object(job) || job.result !== result) throw new Error(`CI job ${name} did not ${result}`);
  }
}

export function checkSource(event: string, ref: string, sha: string, expected: string): void {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("invalid immutable CI SHA");
  if (
    expected !== "" &&
    (event !== "workflow_dispatch" ||
      ref !== "refs/heads/main" ||
      !/^[a-f0-9]{40}$/.test(expected) ||
      sha !== expected)
  ) {
    throw new Error("main moved or recovery source is invalid; reconcile current main again");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env;
    const event = env.GITHUB_EVENT_NAME ?? "";
    const mode = process.argv[2];
    checkSource(event, env.GITHUB_REF ?? "", env.GITHUB_SHA ?? "", env.EXPECTED_MAIN_SHA ?? "");
    if (mode === "results" || mode === "full-main") {
      if (
        mode === "full-main" &&
        (env.GITHUB_REF !== "refs/heads/main" || !["push", "workflow_dispatch"].includes(event))
      )
        throw new Error("not a full main validation");
      checkCiResults(event, JSON.parse(env.CI_NEEDS ?? ""), mode === "full-main");
    } else if (mode !== "source")
      throw new Error("usage: check-ci-results source|results|full-main");
    console.log(`CI ${mode} accepted`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CI validation failed");
    process.exitCode = 1;
  }
}
