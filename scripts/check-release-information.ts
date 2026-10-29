import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const cwd = process.cwd();
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}
function blob(ref: string, path: string): string {
  return git("show", `${ref}:${path}`);
}
function json(ref: string, path: string) {
  return JSON.parse(blob(ref, path));
}
function fail(message: string): never {
  throw Error(message);
}
try {
  const args = process.argv.slice(2);
  const arg = (name: string) => args[args.indexOf(name) + 1];
  if (
    args.length !== 6 ||
    !args.includes("--base") ||
    !args.includes("--head") ||
    !args.includes("--pr-file")
  )
    fail("Use --base SHA --head SHA --pr-file JSON (number,base,head,body)");
  const base = arg("--base"),
    head = arg("--head");
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head))
    fail("Explicit immutable base/head required");
  const metadata = JSON.parse(readFileSync(arg("--pr-file"), "utf8"));
  const pr = metadata.pull_request
    ? {
        number: metadata.number,
        base: metadata.pull_request.base.sha,
        head: metadata.pull_request.head.sha,
        body: metadata.pull_request.body ?? "",
      }
    : metadata;
  if (
    pr.base !== base ||
    pr.head !== head ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    typeof pr.body !== "string"
  )
    fail("PR identity drift or malformed metadata");
  const body: string = pr.body;
  const files = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
  const boundary = json(base, "scripts/public-packages.json");
  const allowed: string[] = boundary.packages.map((p: { name: string }) => p.name);
  const changesets = git("ls-tree", "-r", "--name-only", head, ".changeset")
    .split("\n")
    .filter((p) => p.endsWith(".md") && !p.endsWith("/README.md"));
  const covered = new Set<string>();
  for (const file of changesets) {
    const parts = blob(head, file).split(/^---\s*$/m);
    if (parts.length !== 3 || parts[0].trim() || parts[2].trim().length < 10)
      fail(`Malformed or empty Changeset ${file}`);
    const note = parse(parts[1]);
    if (!note || typeof note !== "object" || Array.isArray(note) || !Object.keys(note).length)
      fail(`Empty Changeset ${file}`);
    for (const [name, bump] of Object.entries(note)) {
      if (!allowed.includes(name) || !["patch", "minor", "major"].includes(String(bump)))
        fail(`Unknown/private package or invalid bump: ${name}`);
      if (files.includes(file)) covered.add(name);
    }
  }
  if (body.split("\n").filter((line) => line.startsWith("Package release:")).length > 1)
    fail("Duplicate Package release declaration");
  const versionRequest = /^Package release: version\s*$/m.test(body);
  if (versionRequest) {
    execFileSync(
      process.execPath,
      [resolve(import.meta.dirname, "canonical-package-version.mjs"), base, head],
      { cwd, stdio: "inherit" },
    );
  } else {
    const baseNotes = git("ls-tree", "-r", "--name-only", base, ".changeset")
      .split("\n")
      .filter((p) => p.endsWith(".md") && !p.endsWith("/README.md"));
    if (baseNotes.some((p) => !changesets.includes(p)))
      fail("Changeset consumption requires canonical version validation");
    const none = body.match(/^Package release: none[ \t]+(?:—|:|-)[ \t]+(.+)$/m);
    if (body.includes("Package release:") && !none)
      fail(
        "Malformed Package release declaration (use a Changeset, or none — meaningful reason, or version)",
      );
    if (
      none &&
      (none[1].trim().length < 25 || /^(?:n\/a|none|internal|no changes)\.?$/i.test(none[1].trim()))
    )
      fail("Package release:none requires a meaningful reviewable consumer-impact reason");
    const relevant = new Set<string>();
    for (const p of boundary.packages) {
      const before = json(base, `${p.directory}/package.json`),
        after = json(head, `${p.directory}/package.json`);
      if (before.version !== after.version)
        fail("Package version edits require exact canonical Package release: version validation");
      if (
        files.some(
          (f) =>
            f.startsWith(`${p.directory}/`) &&
            !/(?:^|\/)(?:__tests__|test|tests)\//.test(f) &&
            !f.endsWith(".test.ts") &&
            !f.endsWith(".md"),
        )
      )
        relevant.add(p.name);
      if (
        files.some((f) =>
          [
            "scripts/public-packages.json",
            "scripts/check-packed-packages.mjs",
            "pnpm-workspace.yaml",
            "tsconfig.base.json",
          ].includes(f),
        )
      )
        relevant.add(p.name);
      if (files.includes("package.json")) {
        const a = json(base, "package.json"),
          b = json(head, "package.json");
        if (
          a.packageManager !== b.packageManager ||
          a.scripts?.build !== b.scripts?.build ||
          a.devDependencies?.tsup !== b.devDependencies?.tsup ||
          a.devDependencies?.typescript !== b.devDependencies?.typescript
        )
          relevant.add(p.name);
      }
      if (files.includes("pnpm-lock.yaml")) {
        const closure = (ref: string) => {
          const lock = parse(blob(ref, "pnpm-lock.yaml"));
          const deps = lock.importers?.[p.directory]?.dependencies ?? {};
          const buildTools = [".", p.directory].map((directory) =>
            Object.fromEntries(
              Object.entries(lock.importers?.[directory]?.devDependencies ?? {}).filter(([name]) =>
                ["tsup", "typescript"].includes(name),
              ),
            ),
          );
          const found: Record<string, unknown> = { deps, buildTools };
          const visit = (name: string, version: string) => {
            const key = `${name}@${version}`;
            if (key in found) return;
            const s = lock.snapshots?.[key];
            const pkg = lock.packages?.[key.split("(")[0]];
            found[key] = { s, pkg };
            for (const [n, d] of Object.entries(s?.dependencies ?? {})) visit(n, String(d));
          };
          for (const scope of [deps, ...buildTools])
            for (const [n, d] of Object.entries(scope))
              visit(n, String((d as { version: string }).version));
          return JSON.stringify(found);
        };
        if (closure(base) !== closure(head)) relevant.add(p.name);
      }
    }
    for (const name of relevant)
      if (!covered.has(name) && !none)
        fail(
          `${name} delivered surface changed: add a focused Changeset or Package release: none — meaningful reviewed reason`,
        );
  }
  const productLines = body.split("\n").filter((l) => l.startsWith("Product release:"));
  if (productLines.length > 1) fail("Duplicate Product release declaration");
  if (productLines.length) {
    const match = productLines[0].match(
      /^Product release: operator-impact (docs\/release-notes\/[a-z0-9-]+\.md)$/,
    );
    if (!match) fail("Use Product release: operator-impact docs/release-notes/name.md");
    if (!files.includes(match[1])) fail("Operator fragment must be committed in this PR");
    const fragment = blob(head, match[1]);
    for (const field of ["Affected versions:", "Action:", "Compatibility:", "Caveats:"])
      if (
        !fragment
          .split("\n")
          .some((l) => l.startsWith(field) && l.slice(field.length).trim().length >= 10)
      )
        fail(`Fragment needs meaningful ${field}`);
  }
  if (
    files.some(
      (f) => f.startsWith("docs/release-notes/") && f !== "docs/release-notes/README.md",
    ) &&
    !productLines.length
  )
    fail("Product fragment requires reviewer-owned Product release declaration");
  console.log(
    JSON.stringify({
      pr: pr.number,
      base,
      head,
      releaseInformation: "accepted",
      semanticSignificance: "reviewer-owned",
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release information failed");
  process.exitCode = 1;
}
