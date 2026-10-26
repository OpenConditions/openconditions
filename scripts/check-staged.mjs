import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const isolatedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
let snapshot;
function git(args, cwd = process.cwd(), env = process.env) {
  const result = spawnSync("git", args, { cwd, env, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${decode(result.stderr)}`);
  return result.stdout;
}
function identity(path) {
  try {
    const stat = statSync(path, { bigint: true });
    return {
      bytes: readFileSync(path),
      stamp: `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { bytes: null, stamp: "absent" };
    throw error;
  }
}
function tool(module, args, cwd) {
  let cli;
  try {
    cli = require.resolve(resolve(import.meta.dirname, "../node_modules", module));
  } catch {
    throw new Error(
      `Missing local ${module}. Run pnpm install --frozen-lockfile explicitly, then retry; hooks never install tools.`,
    );
  }
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: isolatedEnv,
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(
      `Staged checks failed (${module}, ${result.signal ?? result.status}). Format/fix the working file, stage only the intended hunks with git add -p, and retry. No files were rewritten or staged.`,
    );
}
function main() {
  const root = decode(git(["rev-parse", "--show-toplevel"])).trimEnd();
  const index = resolve(root, decode(git(["rev-parse", "--git-path", "index"], root)).trimEnd());
  const before = identity(index);
  snapshot = mkdtempSync(join(tmpdir(), "oc-staged-"));
  const snapshotIndex = join(snapshot, "index");
  const env = { ...process.env, GIT_INDEX_FILE: snapshotIndex };
  if (before.bytes) writeFileSync(snapshotIndex, before.bytes);
  else git(["read-tree", "--empty"], root, env);
  const head = decode(git(["rev-parse", "--revs-only", "HEAD"], root));
  let failure;
  let message;
  function check() {
    const changed = new Set(
      decode(
        git(
          ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMT", "-z"],
          root,
          env,
        ),
      )
        .split("\0")
        .filter(Boolean),
    );
    if (!changed.size) {
      message = "No staged regular-file changes to check.";
      return;
    }
    const entries = decode(git(["ls-files", "--stage", "-z"], root, env))
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
        if (match?.[3] !== "0")
          throw new Error("Unmerged or unsupported index; resolve conflicts before committing.");
        const [, mode, oid, , path] = match;
        if (isAbsolute(path) || path.split("/").some((part) => part === ".." || part === ".git"))
          throw new Error("Unsafe index path.");
        return { mode, oid, path };
      });
    const biome = [];
    const prettier = [];
    for (const entry of entries) {
      const regular = entry.mode === "100644" || entry.mode === "100755";
      const config =
        /^(biome\.jsonc?|\.gitignore|\.prettierignore|\.prettierrc(?:\..+)?|prettier\.config\..+|\.editorconfig|package\.json)$/.test(
          basename(entry.path),
        );
      const selected = changed.has(entry.path) && regular;
      const owner = /\.(?:[cm]?[jt]sx?|jsonc?)$/i.test(entry.path)
        ? biome
        : /\.(?:md|ya?ml)$/i.test(entry.path)
          ? prettier
          : null;
      if (config && !regular)
        throw new Error(
          `Staged configuration must be a regular file: ${JSON.stringify(entry.path)}`,
        );
      if (config || (selected && owner)) {
        const target = join(snapshot, "tree", entry.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, git(["cat-file", "blob", entry.oid], root, env));
      }
      if (selected && owner) owner.push(`./${entry.path}`);
    }
    if (!biome.length && !prettier.length) {
      message = "No staged files owned by Biome or Prettier.";
      return;
    }
    const tree = join(snapshot, "tree");
    // Give Biome staged ignore files and a repository boundary, never the source worktree.
    git(["init", "--quiet"], tree, isolatedEnv);
    if (biome.length)
      tool("@biomejs/biome/bin/biome", ["check", "--no-errors-on-unmatched", ...biome], tree);
    if (prettier.length) tool("prettier/bin/prettier.cjs", ["--check", ...prettier], tree);
    message = `Checked ${biome.length + prettier.length} staged file(s); index and working files unchanged.`;
  }
  try {
    check();
  } catch (error) {
    failure = error;
  }
  const after = identity(index);
  if (
    before.stamp !== after.stamp ||
    !(before.bytes === null
      ? after.bytes === null
      : before.bytes.equals(after.bytes ?? Buffer.alloc(0))) ||
    head !== decode(git(["rev-parse", "--revs-only", "HEAD"], root))
  ) {
    throw new Error(
      "Git index changed or HEAD advanced during staged checks. Other changes were preserved; review the index and retry.",
    );
  }
  if (failure) throw failure;
  console.log(message);
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true });
}
