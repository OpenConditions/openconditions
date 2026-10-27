import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const jobs = {
  source: { result: "success" },
  ci: { result: "success" },
  "python-ci": { result: "success" },
  interop: { result: "success" },
  images: { result: "success" },
  "production-audit": { result: "success" },
};
function run(
  mode = "results",
  changes: Record<string, string | undefined> = {},
  needs: unknown = jobs,
) {
  return spawnSync(process.execPath, ["scripts/check-ci-results.ts", mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/1/merge",
      GITHUB_SHA: "a".repeat(40),
      EXPECTED_MAIN_SHA: "",
      CI_NEEDS: JSON.stringify(needs),
      ...changes,
    },
  });
}

describe("required CI command", () => {
  it.each(["pull_request", "push", "workflow_dispatch"])(
    "accepts complete successful %s coverage",
    (event) => {
      expect(run("results", { GITHUB_EVENT_NAME: event }).status).toBe(0);
    },
  );
  it.each(["failure", "cancelled", "skipped", "unknown", ""])(
    "blocks %s in any required job",
    (result) => {
      for (const name of Object.keys(jobs)) {
        expect(run("results", {}, { ...jobs, [name]: { result } }).status).toBe(1);
      }
    },
  );
  it("rejects missing and unexpected jobs, malformed input and unsupported events", () => {
    const { interop: _interop, ...missing } = jobs;
    for (const needs of [missing, { ...jobs, surprise: { result: "success" } }, null, []])
      expect(run("results", {}, needs).status).toBe(1);
    expect(run("results", { CI_NEEDS: "not JSON" }).status).toBe(1);
    expect(run("results", { GITHUB_EVENT_NAME: "workflow_run" }).status).toBe(1);
  });
  it("accepts the weekly audit only when ordinary jobs deliberately skipped", () => {
    const scheduled = {
      ...jobs,
      ci: { result: "skipped" },
      "python-ci": { result: "skipped" },
      interop: { result: "skipped" },
      images: { result: "skipped" },
    };
    expect(run("results", { GITHUB_EVENT_NAME: "schedule" }, scheduled).status).toBe(0);
    expect(
      run(
        "results",
        { GITHUB_EVENT_NAME: "schedule" },
        { ...scheduled, "production-audit": { result: "failure" } },
      ).status,
    ).toBe(1);
    expect(run("results", {}, scheduled).status).toBe(1);
    expect(run("results", { GITHUB_EVENT_NAME: "schedule" }).status).toBe(1);
  });
});

describe("immutable dispatch source command", () => {
  it("accepts ordinary CI and exact main recovery", () => {
    expect(run("source").status).toBe(0);
    expect(
      run("source", {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        EXPECTED_MAIN_SHA: "a".repeat(40),
      }).status,
    ).toBe(0);
  });
  it.each([
    { EXPECTED_MAIN_SHA: "b".repeat(40) },
    { EXPECTED_MAIN_SHA: "A".repeat(40) },
    { EXPECTED_MAIN_SHA: "a".repeat(39) },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_EVENT_NAME: "push" },
  ])("rejects a stale or unauthorized recovery: %j", (changes) => {
    expect(
      run("source", {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        EXPECTED_MAIN_SHA: "a".repeat(40),
        ...changes,
      }).status,
    ).toBe(1);
  });
  it("does not qualify PR, schedule, feature dispatch, or incomplete main coverage", () => {
    const full = { ...jobs, "required-ci": { result: "success" } };
    expect(
      run("full-main", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, full).status,
    ).toBe(0);
    for (const changes of [
      {},
      { GITHUB_EVENT_NAME: "schedule", GITHUB_REF: "refs/heads/main" },
      { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature" },
    ])
      expect(run("full-main", changes, full).status).toBe(1);
    expect(
      run(
        "full-main",
        { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
        { ...full, interop: { result: "skipped" } },
      ).status,
    ).toBe(1);
  });
});
