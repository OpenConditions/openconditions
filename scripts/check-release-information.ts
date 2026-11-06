import { execFileSync } from "node:child_process";
import { canonical, validateNote } from "./canonical-package-version.mjs";

// Candidate content is read as immutable Git objects, never checked out or executed.
process.env.GIT_NO_REPLACE_OBJECTS = "1";
const cwd = process.cwd();
function git(...args: string[]): string {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}
function json(ref: string, path: string) {
  return JSON.parse(git("show", `${ref}:${path}`));
}
function notes(ref: string): string[] {
  return git("ls-tree", "-r", "-z", "--name-only", ref, ".changeset")
    .split("\0")
    .filter((path) => path.endsWith(".md") && path !== ".changeset/README.md");
}
try {
  const [baseFlag, base, headFlag, head, ...extra] = process.argv.slice(2);
  if (
    baseFlag !== "--base" ||
    headFlag !== "--head" ||
    extra.length ||
    typeof base !== "string" ||
    typeof head !== "string" ||
    !/^[a-f0-9]{40}$/.test(base) ||
    !/^[a-f0-9]{40}$/.test(head)
  )
    throw Error("Use --base SHA --head SHA (immutable source revisions only)");
  const boundary = json(base, "scripts/public-packages.json");
  const allowed: string[] = boundary.packages.map((p: { name: string }) => p.name);
  const queued = notes(head);
  for (const file of queued) {
    const entry = git("ls-tree", head, "--", file);
    if (!/^\.changeset\/[^/]+\.md$/.test(file) || !/^100(644|755) blob /.test(entry))
      throw Error(`Changeset must be a regular file directly in .changeset: ${file}`);
    validateNote(git("show", `${head}:${file}`), allowed);
  }
  const versionChanged = boundary.packages.some(
    (p: { directory: string }) =>
      json(base, `${p.directory}/package.json`).version !==
      json(head, `${p.directory}/package.json`).version,
  );
  const consumed = notes(base).some((path) => !queued.includes(path));
  const version = versionChanged || consumed ? canonical(base, head, cwd) : null;
  console.log(JSON.stringify({ base, head, changesets: queued.length, canonicalVersion: version }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Package information failed");
  process.exitCode = 1;
}
