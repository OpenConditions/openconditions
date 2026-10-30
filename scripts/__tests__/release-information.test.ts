import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const packageManager: string = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).packageManager;
const pnpmVersion = packageManager.slice("pnpm@".length);
function fixture(
  change: string,
  body = "",
  note?: string,
  baseline: Record<string, string> = {},
  candidate: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "oc-release-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "packages/ocpi/src"), { recursive: true });
  mkdirSync(join(dir, ".changeset"));
  writeFileSync(
    join(dir, "scripts/public-packages.json"),
    JSON.stringify({ packages: [{ name: "@openconditions/ocpi", directory: "packages/ocpi" }] }),
  );
  writeFileSync(
    join(dir, "packages/ocpi/package.json"),
    JSON.stringify({ name: "@openconditions/ocpi", version: "0.1.0" }),
  );
  writeFileSync(join(dir, "packages/ocpi/src/index.ts"), "export const x=1;\n");
  for (const [name, text] of Object.entries(baseline)) {
    const path = join(dir, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const file = join(dir, change);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, "changed\n");
  if (note !== undefined) writeFileSync(join(dir, ".changeset/change.md"), note);
  for (const [name, text] of Object.entries(candidate)) {
    const path = join(dir, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "candidate");
  const head = git("rev-parse", "HEAD");
  const metadata = join(dir, "pr.json");
  writeFileSync(metadata, JSON.stringify({ number: 1, base, head, body }));
  const r = spawnSync(
    process.execPath,
    [
      join(root, "scripts/check-release-information.ts"),
      "--base",
      base,
      "--head",
      head,
      "--pr-file",
      metadata,
    ],
    { cwd: dir, encoding: "utf8", timeout: 15000 },
  );
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, output: r.stdout + r.stderr };
}
const note = '---\n"@openconditions/ocpi": patch\n---\nPreserve connector normalization.\n';
describe("release information actual CLI", () => {
  it("rejects a public runtime change without consumer evidence", () =>
    expect(fixture("packages/ocpi/src/index.ts").status).not.toBe(0));
  it.each(["README.md", "services/internal.ts", "packages/ocpi/src/__tests__/x.test.ts"])(
    "does not force bookkeeping for %s",
    (p) => expect(fixture(p).status).toBe(0),
  );
  it("accepts focused changeset", () =>
    expect(fixture("packages/ocpi/src/index.ts", "", note).status).toBe(0));
  it("accepts meaningful reviewed none declaration", () =>
    expect(
      fixture(
        "packages/ocpi/src/index.ts",
        "Package release: none — Refactors a local variable; exported values and errors are unchanged.",
      ).status,
    ).toBe(0));
  it.each([
    "",
    "---\nunknown: patch\n---\nSomething useful\n",
    '---\n"@openconditions/core": patch\n---\nSomething useful\n',
    '---\n"@openconditions/ocpi": banana\n---\nSomething useful\n',
  ])("rejects malformed/unknown/private note %s", (n) =>
    expect(fixture("README.md", "", n).status).not.toBe(0),
  );
  it("rejects a meaningless none declaration", () =>
    expect(fixture("packages/ocpi/src/index.ts", "Package release: none — n/a").status).not.toBe(
      0,
    ));
  it("requires actual operator fragment", () =>
    expect(
      fixture("README.md", "Product release: operator-impact docs/release-notes/missing.md").status,
    ).not.toBe(0));
});

function installedVersion(name: string): string {
  return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
}
function versionFixture(
  extra: "canonical" | "source" | "empty" | "allowlist" | "fragment",
  toolRoot = root,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const dir = mkdtempSync(join(tmpdir(), "oc-version-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    for (const d of [".changeset", "scripts", "packages/ocpi", "packages/internal"])
      mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        private: true,
        packageManager,
        devDependencies: {
          "@changesets/cli": installedVersion("@changesets/cli"),
          prettier: installedVersion("prettier"),
        },
      }),
    );
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(
      join(dir, "scripts/public-packages.json"),
      JSON.stringify({ packages: [{ name: "@openconditions/ocpi", directory: "packages/ocpi" }] }),
    );
    writeFileSync(
      join(dir, ".changeset/config.json"),
      readFileSync(join(root, ".changeset/config.json")),
    );
    writeFileSync(
      join(dir, "packages/ocpi/package.json"),
      JSON.stringify({ name: "@openconditions/ocpi", version: "0.1.0", private: false }),
    );
    writeFileSync(
      join(dir, "packages/internal/package.json"),
      JSON.stringify({ name: "internal", version: "2.3.4", private: true }),
    );
    if (extra !== "empty") writeFileSync(join(dir, ".changeset/note.md"), note);
    // Reuse the repository's actual pinned toolchain receipt in this empty offline fixture.
    // The application lock remains generated by the current pnpm CLI below.
    const repositoryLock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const applicationDocument = repositoryLock.indexOf("\n---", 4);
    expect(applicationDocument).toBeGreaterThan(0);
    writeFileSync(join(dir, "pnpm-lock.yaml"), repositoryLock.slice(0, applicationDocument) + "\n");
    execFileSync("pnpm", ["install", "--lockfile-only", "--offline", "--ignore-scripts"], {
      cwd: dir,
      stdio: "pipe",
      env: environment,
    });
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], {
      cwd: dir,
      stdio: "pipe",
      env: environment,
    });
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const generated = spawnSync(
      process.execPath,
      [join(toolRoot, "scripts/version-public-packages.mjs")],
      { cwd: dir, encoding: "utf8", timeout: 30000, env: environment },
    );
    expect(generated.status, generated.stdout + generated.stderr).toBe(0);
    if (extra === "empty")
      writeFileSync(
        join(dir, "packages/ocpi/package.json"),
        JSON.stringify({ name: "@openconditions/ocpi", version: "0.1.1", private: false }),
      );
    else {
      expect(
        JSON.parse(readFileSync(join(dir, "packages/ocpi/package.json"), "utf8")).version,
      ).toBe("0.1.1");
      expect(readFileSync(join(dir, "packages/ocpi/CHANGELOG.md"), "utf8")).toContain(
        "Preserve connector normalization.",
      );
      expect(
        JSON.parse(readFileSync(join(dir, "packages/internal/package.json"), "utf8")).version,
      ).toBe("2.3.4");
    }
    if (extra === "source")
      writeFileSync(join(dir, "packages/ocpi/extra.js"), "export const unexpected=1;");
    if (extra === "allowlist") writeFileSync(join(dir, "scripts/public-packages.json"), "{}\n");
    if (extra === "fragment") writeFileSync(join(dir, "operator.md"), "Unexpected fragment\n");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "candidate");
    const head = git("rev-parse", "HEAD");
    return spawnSync(
      process.execPath,
      [join(toolRoot, "scripts/canonical-package-version.mjs"), base, head],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          ...(toolRoot !== root
            ? {
                NODE_OPTIONS: `--import=${join(toolRoot, "observe.mjs")}`,
                OC_CANONICAL_TRACE: join(toolRoot, "trace.jsonl"),
              }
            : {}),
        },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
it("accepts actual installed Changesets version/lock/changelog/note consumption", () => {
  const r = versionFixture("canonical");
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('"pending":1');
}, 60000);
it.each(["source", "empty", "allowlist", "fragment"] as const)(
  "rejects forged canonical output: %s",
  (kind) => {
    const r = versionFixture(kind);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stderr).toContain(
      kind === "empty"
        ? "Empty queue cannot authorize"
        : "Version PR differs from installed Changesets canonical output",
    );
  },
  60000,
);
it.each([
  "packages/ocpi/src/types.ts",
  "packages/ocpi/tsup.config.ts",
  "packages/ocpi/LICENSE",
  "scripts/check-packed-packages.mjs",
])("requires consumer evidence for %s", (p) => expect(fixture(p).status).not.toBe(0));
it("accepts declared operator fragment with actual action and caveats", () => {
  const path = "docs/release-notes/change.md";
  const text =
    "Affected versions: Unreleased operator behavior.\nAction: Rebuild the configured consumers.\nCompatibility: Existing deployments need migration.\nCaveats: Linux evidence does not cover ARM.\n";
  expect(
    fixture(
      "services/operator.ts",
      `Product release: operator-impact ${path}`,
      undefined,
      {},
      { [path]: text },
    ).status,
  ).toBe(0);
});
it("does not let a fragment bypass its declaration", () =>
  expect(fixture("docs/release-notes/change.md").status).not.toBe(0));
const runtimeLock = (v: string, dev: string) =>
  `lockfileVersion: '9.0'\nimporters:\n  packages/ocpi:\n    dependencies:\n      dep:\n        specifier: ^1.0.0\n        version: ${v}\n  .:\n    devDependencies:\n      tool:\n        specifier: ${dev}\n        version: ${dev}\npackages:\n  dep@${v}:\n    resolution: {integrity: ${v}}\nsnapshots:\n  dep@${v}: {}\n`;
it("requires evidence for bot runtime lock changes", () =>
  expect(
    fixture(
      "pnpm-lock.yaml",
      "",
      undefined,
      { "pnpm-lock.yaml": runtimeLock("1.0.0", "2.0.0") },
      { "pnpm-lock.yaml": runtimeLock("1.0.1", "2.0.0") },
    ).status,
  ).not.toBe(0));
it("does not force notes for bot dev-only lock changes", () =>
  expect(
    fixture(
      "pnpm-lock.yaml",
      "",
      undefined,
      { "pnpm-lock.yaml": runtimeLock("1.0.0", "2.0.0") },
      { "pnpm-lock.yaml": runtimeLock("1.0.0", "2.0.1") },
    ).status,
  ).toBe(0));
it("requires evidence for exports/runtime dependency manifest changes", () =>
  expect(
    fixture(
      "packages/ocpi/package.json",
      "",
      undefined,
      {},
      {
        "packages/ocpi/package.json": JSON.stringify({
          name: "@openconditions/ocpi",
          version: "0.1.0",
          exports: { ".": "./new.js" },
          dependencies: { dep: "1.0.0" },
        }),
      },
    ).status,
  ).not.toBe(0));
it("refuses ambiguous duplicate package declarations", () =>
  expect(
    fixture(
      "README.md",
      "Package release: none — No consumer effect because only prose changed.\nPackage release: none — A second contradictory declaration is invalid.",
    ).status,
  ).not.toBe(0));
const buildLock = (version: string, tool = "tsup") =>
  `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      tsup:\n        specifier: ^8.0.0\n        version: 8.0.0\n  packages/ocpi:\n    devDependencies:\n      ${tool}:\n        specifier: ^8.0.0\n        version: ${version}\npackages:\n  tsup@8.0.0: {}\n  ${tool}@${version}: {}\nsnapshots:\n  tsup@8.0.0: {}\n  ${tool}@${version}: {}\n`;
it("refuses package-local build-tool resolution change with unchanged root importer", () =>
  expect(
    fixture(
      "pnpm-lock.yaml",
      "",
      undefined,
      { "pnpm-lock.yaml": buildLock("8.0.1") },
      { "pnpm-lock.yaml": buildLock("8.1.0") },
    ).status,
  ).not.toBe(0));
it("accepts package-local build change with reviewed consumer-equivalence reason", () =>
  expect(
    fixture(
      "pnpm-lock.yaml",
      "Package release: none — Rebuilt outputs match the prior consumer contract; no delivered behavior changed.",
      undefined,
      { "pnpm-lock.yaml": buildLock("8.0.1") },
      { "pnpm-lock.yaml": buildLock("8.1.0") },
    ).status,
  ).toBe(0));
const toolchainDoc = `---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm: {specifier: ${pnpmVersion}, version: ${pnpmVersion}}\npackages: {}\nsnapshots: {}\n---\n`;
it("accepts unchanged public closure in pnpm12 toolchain+application documents", () =>
  expect(
    fixture(
      "pnpm-lock.yaml",
      "",
      undefined,
      { "pnpm-lock.yaml": toolchainDoc + runtimeLock("1.0.0", "2.0.0") },
      { "pnpm-lock.yaml": toolchainDoc + runtimeLock("1.0.0", "2.0.1") },
    ).status,
  ).toBe(0));
it("still requires evidence for runtime changes in pnpm12 second document", () =>
  expect(
    fixture(
      "pnpm-lock.yaml",
      "",
      undefined,
      { "pnpm-lock.yaml": toolchainDoc + runtimeLock("1.0.0", "2.0.0") },
      { "pnpm-lock.yaml": toolchainDoc + runtimeLock("1.0.1", "2.0.0") },
    ).output,
  ).toContain("delivered surface changed"));

function nativeOptionalLocks() {
  const baseline = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const native = /('@esbuild\/linux-x64@[^']+':\n {4}resolution: \{integrity: )[^}]+(\})/;
  const candidate = baseline.replace(native, `$1sha512-${"A".repeat(86)}==$2`);
  expect(candidate).not.toBe(baseline);
  return { baseline: { "pnpm-lock.yaml": baseline }, candidate: { "pnpm-lock.yaml": candidate } };
}
it("requires evidence for only an actual locked optional native build integrity change", () => {
  const locks = nativeOptionalLocks();
  const result = fixture("pnpm-lock.yaml", "", undefined, locks.baseline, locks.candidate);
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain("delivered surface changed");
});
it.each(["none", "changeset"])("accepts optional native build evidence: %s", (kind) => {
  const locks = nativeOptionalLocks();
  const result = fixture(
    "pnpm-lock.yaml",
    kind === "none"
      ? "Package release: none — The reviewed native build input change preserves the delivered consumer contract."
      : "",
    kind === "changeset" ? note : undefined,
    locks.baseline,
    locks.candidate,
  );
  expect(result.status, result.output).toBe(0);
});
function optionalRuntimeLock(integrity: string, nested: boolean) {
  return `${toolchainDoc}lockfileVersion: '9.0'\nimporters:\n  packages/ocpi:\n    optionalDependencies:\n      optional-root:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  optional-root@1.0.0:\n    resolution: {integrity: ${nested ? "root-unchanged" : integrity}}\n  optional-child@1.0.0:\n    resolution: {integrity: ${nested ? integrity : "child-unchanged"}}\nsnapshots:\n  optional-root@1.0.0:\n    optionalDependencies:\n      optional-child: 1.0.0\n  optional-child@1.0.0:\n    optionalDependencies:\n      optional-root: 1.0.0\n`;
}
it.each([false, true])(
  "tracks optional runtime roots and nested cyclic edges (nested=%s)",
  (nested) => {
    const result = fixture(
      "pnpm-lock.yaml",
      "",
      undefined,
      { "pnpm-lock.yaml": optionalRuntimeLock("before", nested) },
      { "pnpm-lock.yaml": optionalRuntimeLock("after", nested) },
    );
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("delivered surface changed");
  },
);

function installationState(directory: string) {
  const modules = join(directory, "node_modules");
  const hash = createHash("sha256");
  let entries = 0;
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(modules, relative), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = join(relative, entry.name),
        path = join(modules, name);
      entries++;
      hash.update(name).update(String(lstatSync(path).mode));
      if (entry.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (entry.isDirectory()) visit(name);
      else hash.update(readFileSync(path));
    }
  };
  visit("");
  return { digest: hash.digest("hex"), entries };
}

it("isolates canonical installs and preserves outside installed tools", () => {
  const outside = installationState(root);
  const victim = realpathSync(mkdtempSync(join(tmpdir(), "oc-owned-tools-")));
  try {
    execFileSync("git", ["clone", "--shared", "--no-checkout", root, victim], { stdio: "pipe" });
    execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: victim, stdio: "pipe" });
    for (const file of ["canonical-package-version.mjs", "version-public-packages.mjs"])
      writeFileSync(join(victim, "scripts", file), readFileSync(join(root, "scripts", file)));
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], {
      cwd: victim,
      stdio: "pipe",
    });
    writeFileSync(
      join(victim, "observe.mjs"),
      `import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
const remove=fs.rmSync;
fs.rmSync=(path,options)=>{
 if(typeof path==="string" && path.includes("/oc-version-") && fs.existsSync(path+"/node_modules")) fs.appendFileSync(process.env.OC_CANONICAL_TRACE,JSON.stringify({directory:fs.realpathSync(path),modules:fs.realpathSync(path+"/node_modules"),cli:fs.realpathSync(path+"/node_modules/@changesets/cli"),formatter:fs.realpathSync(path+"/node_modules/prettier")})+"\\n");
 return remove(path,options);
};syncBuiltinESMExports();`,
    );
    const before = installationState(victim);
    const prettier = join(victim, "node_modules/.bin/prettier");
    const version = execFileSync(prettier, ["--version"], { encoding: "utf8" });
    const result = versionFixture("canonical", victim);
    expect(existsSync(join(victim, "trace.jsonl")), result.stdout + result.stderr).toBe(true);
    const records = readFileSync(join(victim, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    for (const record of records) {
      expect(record.modules).toBe(join(record.directory, "node_modules"));
      expect(record.cli.startsWith(`${record.directory}/node_modules/`)).toBe(true);
      expect(record.formatter.startsWith(`${record.directory}/node_modules/`)).toBe(true);
    }
    expect(installationState(victim)).toEqual(before);
    expect(execFileSync(prettier, ["--version"], { encoding: "utf8" })).toBe(version);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(victim, { recursive: true, force: true });
    expect(installationState(root)).toEqual(outside);
    expect(
      execFileSync(join(root, "node_modules/.bin/prettier"), ["--version"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(installedVersion("prettier"));
  }
}, 120000);
it("keeps the pinned manager available from the action-setup PNPM_HOME layout", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "oc-manager-home-")));
  try {
    const home = join(directory, "setup-pnpm/node_modules/.bin");
    const hosts = join(directory, "host-bin");
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(hosts);
    const manager = execFileSync("pnpm", ["exec", "node", "-p", "process.env.npm_execpath"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(execFileSync(manager, ["--version"], { encoding: "utf8" }).trim()).toBe(pnpmVersion);
    symlinkSync(manager, join(home, "bin/pnpm"));
    symlinkSync(process.execPath, join(hosts, "node"));
    const paths = (process.env.PATH ?? "")
      .split(delimiter)
      .filter((path) => !existsSync(join(path, "pnpm")));
    const store = execFileSync("pnpm", ["store", "path", "--silent"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    symlinkSync(dirname(store), join(home, "store"), "dir");
    const environment = {
      ...process.env,
      PNPM_HOME: home,
      PATH: [hosts, join(home, "bin"), ...paths].join(delimiter),
    };
    const result = versionFixture("canonical", root, environment);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"pending":1');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
