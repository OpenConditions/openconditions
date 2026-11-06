import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
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
import { parse, parseAllDocuments, stringify } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const packageManager: string = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).packageManager;
const pnpmVersion = packageManager.slice("pnpm@".length);
function fixture(
  change: Record<string, string>,
  baseline: Record<string, string> = {},
  afterWrite?: (directory: string) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "oc-release-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    put(
      "scripts/public-packages.json",
      JSON.stringify({ packages: [{ name: "@openconditions/ocpi", directory: "packages/ocpi" }] }),
    );
    put(
      "packages/ocpi/package.json",
      JSON.stringify({ name: "@openconditions/ocpi", version: "0.1.0" }),
    );
    put("packages/ocpi/src/index.ts", "export const x=1;\n");
    put(".changeset/README.md", "Package notes\n");
    for (const [path, text] of Object.entries(baseline)) put(path, text);
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    for (const [path, text] of Object.entries(change)) put(path, text);
    afterWrite?.(dir);
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "candidate");
    const head = git("rev-parse", "HEAD");
    const index = readFileSync(join(dir, ".git/index"));
    const r = spawnSync(
      process.execPath,
      [join(root, "scripts/check-release-information.ts"), "--base", base, "--head", head],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, GITHUB_EVENT_PATH: join(dir, "nonexistent-pr-body.json") },
      },
    );
    expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
    expect(git("status", "--porcelain")).toBe("");
    return { status: r.status, output: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const note = '---\n"@openconditions/ocpi": patch\n---\nPreserve connector normalization.\n';
describe("source-only package information", () => {
  it.each([
    "README.md",
    "services/internal.ts",
    "packages/ocpi/src/index.ts",
    "packages/ocpi/src/types.ts",
    "packages/ocpi/tsup.config.ts",
    "packages/ocpi/LICENSE",
    "docs/release-notes/ordinary.md",
  ])("allows ordinary %s without declarations or a note", (path) => {
    const r = fixture({ [path]: "Ordinary reviewed change\n" });
    expect(r.status, r.output).toBe(0);
  });
  it.each(["runtime", "development", "optional native build"])(
    "allows ordinary %s dependency input changes",
    (kind) => {
      const path = kind === "runtime" ? "packages/ocpi/package.json" : "pnpm-lock.yaml";
      const value =
        kind === "runtime"
          ? JSON.stringify({
              name: "@openconditions/ocpi",
              version: "0.1.0",
              dependencies: { dep: "1.0.0" },
              exports: { ".": "./dist/index.js" },
            })
          : `lockfileVersion: 9.0\n# reviewed ${kind} resolution change\n`;
      const r = fixture({ [path]: value });
      expect(r.status, r.output).toBe(0);
    },
  );
  it("rejects a note symlink whose Git blob otherwise parses as a valid Changeset", () => {
    const r = fixture({ ".changeset/change.md": note }, {}, (directory) => {
      const path = join(directory, ".changeset/change.md");
      rmSync(path);
      symlinkSync(note, path);
    });
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain("regular file directly in .changeset");
  });
  it("rejects notes outside the queue consumed by the version helper", () => {
    const r = fixture({ ".changeset/nested/change.md": note });
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain("regular file directly in .changeset");
  });
  it("accepts a public Changeset", () => {
    const r = fixture({ ".changeset/change.md": note });
    expect(r.status, r.output).toBe(0);
  });
  it("does not impose an arbitrary summary length", () => {
    const r = fixture({
      ".changeset/change.md": note.replace("Preserve connector normalization.", "Fix."),
    });
    expect(r.status, r.output).toBe(0);
  });
  it.each([
    "",
    "not frontmatter",
    "---\n{}\n---\nUseful summary",
    "---\nunknown: patch\n---\nUseful summary",
    '---\n"@openconditions/core": patch\n---\nUseful summary',
    '---\n"@openconditions/ocpi": banana\n---\nUseful summary',
    '---\n"@openconditions/ocpi": patch\n---\n   ',
  ])("rejects malformed/private/empty notes: %s", (text) => {
    const r = fixture({ ".changeset/change.md": text });
    expect(r.status, r.output).not.toBe(0);
  });
  it("does not let a candidate extend its own note authority", () => {
    const r = fixture({
      "scripts/public-packages.json": JSON.stringify({
        packages: [{ name: "@openconditions/core", directory: "packages/core" }],
      }),
      ".changeset/change.md": '---\n"@openconditions/core": patch\n---\nUseful summary',
    });
    expect(r.status, r.output).not.toBe(0);
  });
});

function installedVersion(name: string): string {
  return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
}
function versionFixture(
  extra: "canonical" | "source" | "empty" | "allowlist" | "fragment" | "consumed",
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
    const workspace = parse(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      stringify({
        packages: ["packages/*"],
        // Test inputs are the already verified repository lock, not fresh resolution.
        trustLockfile: true,
        overrides: workspace.overrides,
        patchedDependencies: workspace.patchedDependencies,
      }),
    );
    cpSync(join(root, "patches"), join(dir, "patches"), { recursive: true });
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
    // Seed exact installed inputs, not registry metadata that a frozen CI install
    // need not cache. pnpm still generates the versioned application lock below.
    const locks = parseAllDocuments(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).map(
      (document) => {
        if (document.errors.length) throw document.errors[0];
        return document.toJSON();
      },
    );
    const application = locks.at(-1);
    application.importers = {
      ".": {
        devDependencies: Object.fromEntries(
          ["@changesets/cli", "prettier"].map((name) => [
            name,
            {
              ...application.importers["."].devDependencies[name],
              specifier: installedVersion(name),
            },
          ]),
        ),
      },
      "packages/ocpi": {},
      "packages/internal": {},
    };
    writeFileSync(
      join(dir, "pnpm-lock.yaml"),
      locks.map((lock) => `---\n${stringify(lock)}`).join(""),
    );
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
    if (extra === "consumed") {
      const manifest = JSON.parse(readFileSync(join(dir, "packages/ocpi/package.json"), "utf8"));
      manifest.version = "0.1.0";
      writeFileSync(join(dir, "packages/ocpi/package.json"), JSON.stringify(manifest));
    }
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "candidate");
    const head = git("rev-parse", "HEAD");
    return spawnSync(
      process.execPath,
      [join(toolRoot, "scripts/check-release-information.ts"), "--base", base, "--head", head],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...environment,
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
it.each(["source", "empty", "allowlist", "fragment", "consumed"] as const)(
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
    for (const file of [
      "canonical-package-version.mjs",
      "version-public-packages.mjs",
      "check-release-information.ts",
    ])
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

it("replays a version using locked packages without cached registry metadata", () => {
  const cache = mkdtempSync(join(tmpdir(), "oc-empty-metadata-"));
  try {
    const result = versionFixture("canonical", root, {
      ...process.env,
      XDG_CACHE_HOME: cache,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"pending":1');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}, 60000);

it("keeps title validation lightweight and source validation in ordinary Node CI", () => {
  const title = parse(readFileSync(join(root, ".github/workflows/pr-title.yml"), "utf8"));
  expect(Object.keys(title.on)).toEqual(["pull_request_target"]);
  expect(title.jobs.validate.name).toBe("Validate conventional commit title");
  expect(title.permissions).toEqual({});
  expect(title.jobs.validate.permissions).toEqual({ "pull-requests": "read", statuses: "write" });
  expect(title.jobs.validate.steps).toHaveLength(1);
  expect(title.jobs.validate.steps[0].uses).toBe(
    "amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50",
  );
  expect(title.jobs.validate.steps[0].with.wip).toBe(true);
  expect(title.jobs.validate).not.toHaveProperty("if");
  const ci = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  const step = ci.jobs.ci.steps.find((s: { run?: string }) =>
    s.run?.includes("check:release-information"),
  );
  expect(step.if).toBe("github.event_name == 'pull_request'");
  expect(step.env).toEqual({
    RELEASE_BASE: `\${{ github.event.pull_request.base.sha }}`,
    RELEASE_HEAD: `\${{ github.event.pull_request.head.sha }}`,
  });
  expect(step.run).toBe(
    'pnpm check:release-information --base "$RELEASE_BASE" --head "$RELEASE_HEAD"',
  );
  expect(ci.on.pull_request).toBeNull(); // default source events do not include body edits
});

it("accepts only explicit source arguments, not a PR-body input", () => {
  for (const args of [
    ["--base", "main", "--head", "HEAD"],
    ["--base", "a".repeat(40), "--head", "b".repeat(40), "--pr-file", "unused.json"],
  ]) {
    const r = spawnSync(
      process.execPath,
      [join(root, "scripts/check-release-information.ts"), ...args],
      { cwd: root, encoding: "utf8" },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("immutable source revisions only");
  }
});
