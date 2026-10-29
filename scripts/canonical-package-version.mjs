import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const tools = resolve(import.meta.dirname, "..");
export function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "1", HUSKY: "0" },
  }).trim();
}
export function notes(cwd, allowed) {
  return readdirSync(join(cwd, ".changeset"))
    .filter((n) => n.endsWith(".md") && n !== "README.md")
    .map((name) => {
      const text = readFileSync(join(cwd, ".changeset", name), "utf8");
      const parts = text.split(/^---\s*$/m);
      if (parts.length !== 3 || parts[0].trim() || parts[2].trim().length < 10)
        throw Error(`Malformed or empty Changeset: ${name}`);
      const data = parse(parts[1]);
      if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length)
        throw Error(`Empty Changeset: ${name}`);
      for (const [pkg, bump] of Object.entries(data))
        if (!allowed.includes(pkg) || !["patch", "minor", "major"].includes(bump))
          throw Error(`Unknown/private package or bump in ${name}`);
      return name;
    });
}
export function generate(cwd, check = false) {
  const boundary = JSON.parse(readFileSync(join(cwd, "scripts/public-packages.json"), "utf8"));
  const allowed = boundary.packages.map((p) => p.name);
  const config = JSON.parse(readFileSync(join(cwd, ".changeset/config.json"), "utf8"));
  if (
    config.commit !== false ||
    config.changelog !== "@changesets/cli/changelog" ||
    config.baseBranch !== "main" ||
    config.access !== "public" ||
    config.fixed?.length !== 0 ||
    config.linked?.length !== 0 ||
    config.ignore?.length !== 0 ||
    config.privatePackages?.version !== false ||
    config.privatePackages?.tag !== false
  )
    throw Error("Unsupported Changesets configuration");
  const pending = notes(cwd, allowed).length;
  if (!pending) return { pending: 0 };
  const cli = join(tools, "node_modules/@changesets/cli/bin.js");
  if (check) {
    run(process.execPath, [cli, "status"], cwd);
    return { pending };
  }
  run(process.execPath, [cli, "version"], cwd);
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--offline"], cwd);
  return { pending };
}
export function canonical(base, head, cwd) {
  const dir = mkdtempSync(join(tmpdir(), "oc-version-"));
  try {
    // Only the trusted base is materialized or executed. Candidate files are compared as Git objects.
    run("git", ["clone", "--shared", "--no-checkout", cwd, dir], cwd);
    run("git", ["checkout", "--detach", base], dir);
    const initial = run("git", ["write-tree"], dir);
    symlinkSync(join(tools, "node_modules"), join(dir, "node_modules"), "dir");
    const result = generate(dir);
    if (!result.pending) throw Error("Empty queue cannot authorize a version PR");
    run("git", ["add", "-A"], dir);
    const expected = run("git", ["write-tree"], dir);
    // Compare bytes and modes without trusting a candidate title, author, or branch.
    const actual = run("git", ["rev-parse", `${head}^{tree}`], cwd);
    if (expected === initial || actual !== expected)
      throw Error("Version PR differs from installed Changesets canonical output");
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [base, head] = process.argv.slice(2);
    if (!/^[a-f0-9]{40}$/.test(base ?? "") || !/^[a-f0-9]{40}$/.test(head ?? ""))
      throw Error("canonical-package-version BASE_SHA HEAD_SHA");
    console.log(JSON.stringify(canonical(base, head, process.cwd())));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
