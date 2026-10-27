import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repository = "OpenConditions/openconditions";
const candidateScope = "feeds/*/*.jsonc";
const decoder = new TextDecoder("utf-8", { fatal: true });
const env = process.env;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sha(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`Invalid ${name} SHA`);
  }
  return value;
}
function repo(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}
function sameRepository(value) {
  return repo(value) && value.toLowerCase() === repository.toLowerCase();
}
function git(args, allowed = [0]) {
  const result = spawnSync("git", ["--no-pager", "--no-replace-objects", ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.signal || !allowed.includes(result.status)) {
    throw new Error(
      `git ${args[0]} failed (exit ${result.status}, signal ${result.signal}): ${
        result.error?.message ?? decoder.decode(result.stderr).slice(0, 2000)
      }`,
    );
  }
  // Never parse partial output from an unsuccessful command.
  return { status: result.status, text: decoder.decode(result.stdout) };
}
function nul(text) {
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new Error("Incomplete NUL-delimited Git output");
  return text.slice(0, -1).split("\0");
}
function changes(text) {
  const tokens = nul(text);
  const result = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!/^(?:[AMDT]|[RC](?:100|[0-9]{1,2}|0[0-9]{2}))$/.test(status ?? "")) {
      throw new Error("Unsupported Git change status");
    }
    const previous = tokens[i++];
    const path = /^[RC]/.test(status) ? tokens[i++] : previous;
    if (!previous || !path) throw new Error("Incomplete Git change record");
    result.push({ status: status[0], path });
  }
  return result;
}
function cleanCheckout(expected) {
  if (git(["rev-parse", "--verify", "HEAD"]).text.trim() !== expected) {
    throw new Error("Checked-out HEAD does not match the event merge SHA");
  }
  if (
    git(["diff", "--no-ext-diff", "--no-textconv", "--cached", "--quiet", "HEAD", "--"], [0, 1])
      .status
  ) {
    throw new Error("Tracked index differs from the event checkout");
  }
  if (git(["diff", "--no-ext-diff", "--no-textconv", "--quiet", "HEAD", "--"], [0, 1]).status) {
    throw new Error("Tracked working tree differs from the event checkout");
  }
  if (git(["ls-files", "--others", "-z", "--", "feeds"]).text !== "") {
    throw new Error("Untracked catalogue files differ from the event checkout");
  }
}

function select() {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !sameRepository(env.GITHUB_REPOSITORY)) {
    throw new Error("Expected an unprivileged OpenConditions pull_request event");
  }
  if (!env.GITHUB_EVENT_PATH) throw new Error("Missing GITHUB_EVENT_PATH");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const pr = object(event) && event.pull_request;
  if (
    !object(pr) ||
    !["opened", "synchronize", "reopened"].includes(event.action) ||
    !sameRepository(event.repository?.full_name) ||
    !sameRepository(pr.base?.repo?.full_name) ||
    !repo(pr.head?.repo?.full_name) ||
    !Number.isSafeInteger(event.number) ||
    event.number < 1 ||
    pr.number !== event.number ||
    env.GITHUB_REF !== `refs/pull/${event.number}/merge` ||
    typeof pr.base?.ref !== "string" ||
    !pr.base.ref ||
    env.GITHUB_BASE_REF !== pr.base.ref ||
    typeof pr.head?.ref !== "string" ||
    !pr.head.ref ||
    env.GITHUB_HEAD_REF !== pr.head.ref
  ) {
    throw new Error("Missing or inconsistent PR event/repository/ref identity");
  }
  const base = sha(pr.base.sha, "event base");
  const head = sha(pr.head.sha, "event head");
  const checkout = sha(env.GITHUB_SHA, "event merge");
  if (resolve(git(["rev-parse", "--show-toplevel"]).text.trim()) !== resolve(process.cwd())) {
    throw new Error("Run changed-feed checking from the checkout root");
  }
  for (const commit of [base, head, checkout]) git(["cat-file", "-e", `${commit}^{commit}`]);
  cleanCheckout(checkout);
  const parents = git(["show", "--no-patch", "--format=%P", checkout]).text.trim().split(" ");
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
    throw new Error("Merge checkout parents do not match the exact event base/head");
  }
  const diff = (scope) =>
    changes(
      git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "-z",
        "--find-renames",
        base,
        checkout,
        "--",
        scope,
      ]).text,
    );
  const all = diff(".");
  const candidates = diff(candidateScope);
  const current = new Map();
  for (const entry of nul(git(["ls-files", "--stage", "-z", "--", candidateScope]).text)) {
    const tab = entry.indexOf("\t");
    const header = entry.slice(0, tab);
    const path = entry.slice(tab + 1);
    if (tab < 0 || !/^[0-7]{6} [a-f0-9]{40} 0$/.test(header) || !path) {
      throw new Error("Malformed or unmerged catalogue index entry");
    }
    current.set(path, header.slice(0, 6));
  }
  const files = [];
  for (const change of candidates) {
    if (change.status === "D") continue;
    const mode = current.get(change.path);
    // Rename destinations outside the candidate scope have nothing to fetch.
    if (mode === undefined && ["R", "C"].includes(change.status)) continue;
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(
        `Changed region candidate must be a tracked regular file: ${JSON.stringify(change.path)}`,
      );
    }
    files.push(change.path);
  }
  cleanCheckout(checkout);
  return {
    repository,
    pullRequest: event.number,
    base,
    head,
    checkout,
    files: [...new Set(files)].sort(),
    changedEntries: all.length,
    reason: files.length
      ? "regions-changed"
      : all.length
        ? "no-current-region-files"
        : "no-changes",
  };
}

try {
  const mode = process.argv[2] ?? "run";
  if (!["select", "run"].includes(mode) || process.argv.length > 3) {
    throw new Error("Usage: node scripts/check-changed-feeds.mjs [select|run]");
  }
  const selection = select();
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `selected=${selection.files.length > 0}\n`);
  }
  console.log(JSON.stringify(selection));
  if (mode === "run" && selection.files.length > 0) {
    const result = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/feeds-check.ts", ...selection.files],
      {
        stdio: "inherit",
        shell: false,
      },
    );
    if (result.error || result.signal) {
      throw new Error(`Feed checker failed to execute: ${result.error?.message ?? result.signal}`);
    }
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(
    `changed-feeds: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 1;
}
