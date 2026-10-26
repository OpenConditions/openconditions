import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve("scripts/check-changed-feeds.mjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function put(root: string, name: string, body = "changed\n") {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), body);
}
function fixture(change: (root: string) => void = (root) => put(root, "feeds/roads/nl.jsonc")) {
  const root = mkdtempSync(join(tmpdir(), "oc-feed-selection-"));
  roots.push(root);
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  put(root, ".gitignore", "node_modules/\n");
  put(root, "package.json", '{"private":true,"packageManager":"pnpm@12.11.2"}\n');
  put(root, "scripts/feeds-check.ts", "// This fixture uses its local tsx process probe.\n");
  put(root, "feeds/roads/nl.jsonc", "original\n");
  put(root, "feeds/credentials.jsonc", "original\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  const initial = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "-qc", "feature"]);
  change(root);
  git(root, ["add", "-A"]);
  git(root, ["commit", "--allow-empty", "-qm", "head"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "-q", "main"]);
  put(root, "base-only.txt", "base advancement\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["merge", "--no-ff", "--no-edit", "feature"]);
  const merge = git(root, ["rev-parse", "HEAD"]);
  const event = {
    action: "synchronize",
    number: 7,
    repository: { full_name: "OpenConditions/openconditions" },
    pull_request: {
      number: 7,
      base: { sha: base, ref: "main", repo: { full_name: "OpenConditions/openconditions" } },
      head: { sha: head, ref: "feature", repo: { full_name: "contributor/openconditions" } },
    },
  };
  const eventPath = join(root, ".git/event.json");
  const outputPath = join(root, ".git/step-output");
  const receipt = join(root, ".git/checker.json");
  put(
    root,
    "node_modules/.bin/tsx",
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.FIXTURE_CHECKER_STATUS ?? '0'));
`,
  );
  // The tool is a real child executable found by pnpm exec, never a downloaded package.
  chmodSync(join(root, "node_modules/.bin/tsx"), 0o755);
  function run(mode = "select", extra: NodeJS.ProcessEnv = {}) {
    writeFileSync(eventPath, JSON.stringify(event));
    const index = readFileSync(join(root, ".git/index"));
    const result = spawnSync(process.execPath, [helper, mode], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "OpenConditions/openconditions",
        GITHUB_SHA: merge,
        GITHUB_REF: "refs/pull/7/merge",
        GITHUB_BASE_REF: "main",
        GITHUB_HEAD_REF: "feature",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        ...extra,
      },
    });
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    return { ...result, output: result.stdout + result.stderr };
  }
  return { root, initial, base, head, merge, event, eventPath, outputPath, receipt, run };
}

describe("changed-feed command with real Git histories", () => {
  it("selects a region-only catalogue change against the exact merge first parent", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      base: f.base,
      head: f.head,
      checkout: f.merge,
      files: ["feeds/roads/nl.jsonc"],
      reason: "regions-changed",
    });
    expect(readFileSync(f.outputPath, "utf8")).toBe("selected=true\n");
    expect(existsSync(f.receipt)).toBe(false);
  });
  it.each(["empty", "credentials", "docs"])("reports %s without running the checker", (kind) => {
    const f = fixture((root) => {
      if (kind === "credentials") put(root, "feeds/credentials.jsonc");
      if (kind === "docs") put(root, "README.md");
    });
    const result = f.run("run");
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      files: [],
      reason: kind === "empty" ? "no-changes" : "no-current-region-files",
    });
    expect(existsSync(f.receipt)).toBe(false);
    expect(readFileSync(f.outputPath, "utf8")).toBe("selected=false\n");
  });
  it("keeps NUL-delimited spaces, newlines, Unicode and dash names as literal tool arguments", () => {
    const names = ["space name", "line\nbreak", "東京-ß", "-dash"]
      .map((n) => `feeds/roads/${n}.jsonc`)
      .sort();
    const f = fixture((root) => {
      for (const name of names) put(root, name);
    });
    const result = f.run("run");
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(readFileSync(f.receipt, "utf8"))).toEqual([
      "scripts/feeds-check.ts",
      ...names,
    ]);
  });
  it("checks the destination of a rename and never fetches a deleted region", () => {
    const f = fixture((root) =>
      renameSync(join(root, "feeds/roads/nl.jsonc"), join(root, "feeds/roads/new name.jsonc")),
    );
    const result = f.run();
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual(["feeds/roads/new name.jsonc"]);
  });
  it.each(["delete", "rename-out"])("handles %s as no current region", (kind) => {
    const f = fixture((root) => {
      if (kind === "delete") rmSync(join(root, "feeds/roads/nl.jsonc"));
      else renameSync(join(root, "feeds/roads/nl.jsonc"), join(root, "notes.txt"));
    });
    const result = f.run("run");
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual([]);
    expect(existsSync(f.receipt)).toBe(false);
  });
  it("preserves candidate scope so nested/hidden catalogue errors reach the existing checker", () => {
    const names = ["feeds/roads/.hidden.jsonc", "feeds/roads/nested/file.jsonc"];
    const f = fixture((root) => {
      for (const name of names) put(root, name);
    });
    const result = f.run();
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual(names);
  });
  it.each([1, 2])("preserves checker exit %s after successful selection", (code) => {
    const f = fixture();
    const result = f.run("run", { FIXTURE_CHECKER_STATUS: String(code) });
    expect(result.status, result.output).toBe(code);
    expect(JSON.parse(readFileSync(f.receipt, "utf8"))).toEqual([
      "scripts/feeds-check.ts",
      "feeds/roads/nl.jsonc",
    ]);
  });
  it.each([
    "missing-base",
    "wrong-base",
    "wrong-head",
    "malformed-head",
    "wrong-repo",
    "missing-head-repo",
    "wrong-number",
    "closed",
  ])("fails %s instead of reporting an empty selection", (kind) => {
    const f = fixture(() => {});
    if (kind === "missing-base") f.event.pull_request.base.sha = "1".repeat(40);
    if (kind === "wrong-base") f.event.pull_request.base.sha = f.initial;
    if (kind === "wrong-head") f.event.pull_request.head.sha = f.base;
    if (kind === "malformed-head") f.event.pull_request.head.sha = "--help; touch sentinel";
    if (kind === "wrong-repo") f.event.repository.full_name = "OpenMapX/openmapx";
    if (kind === "missing-head-repo") f.event.pull_request.head.repo.full_name = "";
    if (kind === "wrong-number") f.event.pull_request.number = 8;
    if (kind === "closed") f.event.action = "closed";
    const result = f.run();
    expect(result.status, result.output).not.toBe(0);
    expect(result.stdout).toBe("");
  });
  it.each([
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_REPOSITORY: "Other/repo" },
    { GITHUB_REF: "refs/pull/8/merge" },
    { GITHUB_BASE_REF: "other" },
    { GITHUB_HEAD_REF: "other" },
    { GITHUB_SHA: "1".repeat(40) },
    { GITHUB_EVENT_PATH: "/missing/event.json" },
  ])("rejects inconsistent runtime identity %j", (env) => {
    const f = fixture(() => {});
    const result = f.run("select", env);
    expect(result.status, result.output).not.toBe(0);
    expect(result.stdout).toBe("");
  });
  it("rejects stale and non-merge checkouts", () => {
    const f = fixture(() => {});
    git(f.root, ["checkout", "--detach", f.head]);
    expect(f.run().status).not.toBe(0);
    expect(f.run("select", { GITHUB_SHA: f.head }).status).not.toBe(0);
  });
  it("rejects malformed event bytes before producing a selection", () => {
    const f = fixture();
    put(f.root, ".git/malformed-event", "{not JSON");
    const result = f.run("select", { GITHUB_EVENT_PATH: join(f.root, ".git/malformed-event") });
    expect(result.status, result.output).not.toBe(0);
    expect(result.stdout).toBe("");
  });
  it("fails visibly when Git cannot execute", () => {
    const f = fixture();
    const result = f.run("select", { PATH: "" });
    expect(result.status, result.output).not.toBe(0);
    expect(result.stderr).toContain("git rev-parse failed");
    expect(result.stdout).toBe("");
  });
  it("rejects a real HEAD advancement during Git selection", () => {
    const f = fixture();
    const tree = git(f.root, ["rev-parse", "HEAD^{tree}"]);
    const advanced = git(f.root, ["commit-tree", tree, "-p", f.merge, "-m", "advance"]);
    const actualGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    expect(actualGit).not.toBe("");
    const bin = join(f.root, ".git/bin");
    const wrapper = join(bin, "git");
    put(
      f.root,
      ".git/bin/git",
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { openSync, closeSync } = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(actualGit)}, args);
if (result.status === 0 && args.includes('--name-status')) {
  try {
    closeSync(openSync(${JSON.stringify(join(f.root, ".git/advanced"))}, 'wx'));
    const mutation = spawnSync(${JSON.stringify(actualGit)}, ['update-ref', 'HEAD', ${JSON.stringify(advanced)}]);
    if (mutation.status !== 0) process.exit(90);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 91);
`,
    );
    chmodSync(wrapper, 0o755);
    const result = f.run("select", { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status, result.output).not.toBe(0);
    expect(result.stderr).toContain("HEAD does not match");
    expect(result.stdout).toBe("");
    expect(existsSync(f.outputPath)).toBe(false);
    expect(git(f.root, ["rev-parse", "HEAD"])).toBe(advanced);
  });
  it("propagates an actual git diff failure rather than an empty list", () => {
    const f = fixture();
    git(f.root, ["config", "diff.orderFile", join(f.root, ".git/absent-order-file")]);
    const result = f.run();
    expect(result.status, result.output).not.toBe(0);
    expect(result.stderr).toContain("git diff");
    expect(result.stdout).toBe("");
  });
  it.each([false, true])("rejects dirty working/index content (staged=%s)", (staged) => {
    const f = fixture();
    put(f.root, "feeds/roads/nl.jsonc", "unstaged bytes\n");
    if (staged) git(f.root, ["add", "."]);
    expect(f.run().status).not.toBe(0);
  });
  it("rejects staged changes canceled only in the working tree", () => {
    const f = fixture();
    const path = join(f.root, "feeds/roads/nl.jsonc");
    const original = readFileSync(path);
    writeFileSync(path, "staged bytes\n");
    git(f.root, ["add", "--", "feeds/roads/nl.jsonc"]);
    writeFileSync(path, original);
    expect(git(f.root, ["diff", "--quiet", "HEAD", "--"])).toBe("");
    expect(
      spawnSync("git", ["diff", "--cached", "--quiet", "HEAD", "--"], { cwd: f.root }).status,
    ).toBe(1);
    const result = f.run();
    expect(result.status, result.output).not.toBe(0);
    expect(result.stdout).toBe("");
  });
  it("rejects an untracked catalogue input instead of checking different bytes", () => {
    const f = fixture();
    put(f.root, "feeds/roads/untracked.jsonc");
    expect(f.run().status).not.toBe(0);
  });
  it("rejects ignored catalogue inputs that the live loader would still read", () => {
    const f = fixture();
    put(f.root, ".git/info/exclude", "feeds/roads/ignored.jsonc\n");
    put(f.root, "feeds/roads/ignored.jsonc");
    const result = f.run();
    expect(result.status, result.output).not.toBe(0);
    expect(result.stdout).toBe("");
  });
  it("rejects a symlink region without reading or running it", () => {
    const f = fixture((root) => {
      rmSync(join(root, "feeds/roads/nl.jsonc"));
      symlinkSync("../../.git/config", join(root, "feeds/roads/nl.jsonc"));
    });
    const result = f.run("run");
    expect(result.status, result.output).not.toBe(0);
    expect(result.stderr).toContain("regular file");
    expect(existsSync(f.receipt)).toBe(false);
  });
  it("treats event ref/title/body as data", () => {
    const f = fixture();
    const ref = "feature/$(touch-sentinel)";
    f.event.pull_request.head.ref = ref;
    Object.assign(f.event.pull_request, { title: "$(touch sentinel)", body: "`touch sentinel`" });
    const result = f.run("run", { GITHUB_HEAD_REF: ref });
    expect(result.status, result.output).toBe(0);
    expect(existsSync(join(f.root, "sentinel"))).toBe(false);
  });
  it("does not accept an unknown command mode", () => {
    const f = fixture();
    expect(f.run("ignore-errors").status).not.toBe(0);
  });
});
