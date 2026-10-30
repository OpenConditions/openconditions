import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { regular as readRegular } from "./check-docker-contexts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const contract = JSON.parse(
  readFileSync(new URL("./openmapx-product-contracts.json", import.meta.url), "utf8"),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function regular(path) {
  return readRegular(path).bytes;
}
function tree(dir) {
  const entries = [];
  function walk(path) {
    for (const n of readdirSync(path).sort()) {
      const p = join(path, n),
        s = lstatSync(p);
      if (s.isDirectory()) walk(p);
      else entries.push([relative(dir, p).split(sep).join("/"), s.mode & 0o777, sha(regular(p))]);
    }
  }
  walk(dir);
  return sha(JSON.stringify(entries));
}
function run(command, args, cwd, env) {
  const r = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r;
}
export function consumerPackageManager(cwd, env) {
  // Resolve the root-selected executable, not a wrapper that may bootstrap again
  // under the consumer's empty HOME. The existing release fixtures use this API.
  const selected = run("pnpm", ["exec", "node", "-p", "process.env.npm_execpath"], root, {
    ...process.env,
    npm_config_offline: "true",
  });
  if (selected.status !== 0 || !isAbsolute(selected.stdout.trim()))
    throw Error("Resolve installed pinned pnpm from the trusted root before contract validation");
  const manager = realpathSync(selected.stdout.trim());
  const version = run(manager, ["--version"], cwd, env);
  if (version.status !== 0 || version.stdout.trim() !== "12.16.1")
    throw Error(
      "Pinned pnpm must run directly in the isolated consumer (12.16.1 required): " +
        version.stdout +
        version.stderr,
    );
  return manager;
}
export function validateProductManifests(directory, tools) {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw Error("Node24 or newer required for actual contract tool");
  const archive = join(tools, "portable.tgz"),
    admission = join(tools, "admission.mjs");
  const archiveBytes = regular(archive),
    admissionBytes = regular(admission);
  if (
    sha(archiveBytes) !== contract.portable.archiveSha256 ||
    sha(admissionBytes) !== contract.admission.entrySha256
  )
    throw Error("OpenMapX tool artifact pin mismatch");
  const scratch = mkdtempSync(join(tmpdir(), "oc-openmapx-contracts-"));
  try {
    const env = {
      PATH: process.env.PATH,
      PNPM_HOME: process.env.PNPM_HOME,
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      TMPDIR: scratch,
      CI: "1",
      NO_COLOR: "1",
    };
    const manager = consumerPackageManager(scratch, env);
    const store = run(manager, ["store", "path", "--silent"], root, process.env);
    if (store.status !== 0 || basename(store.stdout.trim()) !== "v11")
      throw Error("Unsupported pnpm store contract");
    const fixture = join(root, "scripts/fixtures/openmapx-contract-consumer");
    copyFileSync(join(fixture, "package.json"), join(scratch, "package.json"));
    copyFileSync(join(fixture, "pnpm-workspace.yaml"), join(scratch, "pnpm-workspace.yaml"));
    writeFileSync(join(scratch, "portable.tgz"), archiveBytes, { flag: "wx" });
    writeFileSync(join(scratch, "admission.mjs"), admissionBytes, { flag: "wx" });
    writeFileSync(join(scratch, "empty.npmrc"), "");
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
      split = lock.indexOf("\n---", 4);
    if (split < 0) throw Error("Unsupported trusted manager lock layout");
    writeFileSync(
      join(scratch, "pnpm-lock.yaml"),
      lock.slice(0, split) +
        "\n---\n" +
        readFileSync(join(fixture, "application-lock.yaml"), "utf8")
          .trimStart()
          .replace(/^---\s*\n/, ""),
    );
    const frozenBefore = readFileSync(join(scratch, "pnpm-lock.yaml"));
    const install = run(
      manager,
      [
        "install",
        "--frozen-lockfile",
        "--offline",
        "--ignore-scripts",
        "--store-dir",
        dirname(store.stdout.trim()),
        "--userconfig",
        join(scratch, "empty.npmrc"),
      ],
      scratch,
      env,
    );
    if (install.status !== 0)
      throw Error("Owned offline consumer install failed: " + install.stdout + install.stderr);
    if (!readFileSync(join(scratch, "pnpm-lock.yaml")).equals(frozenBefore))
      throw Error("Frozen contract-consumer lock changed");
    const entry = realpathSync(join(scratch, "node_modules/@openmapx/extension-cli/dist/cli.js")),
      pkg = dirname(dirname(entry)),
      dep = dirname(createRequire(entry).resolve("commander"));
    if (
      ![pkg, dep].every((p) => p.startsWith(realpathSync(scratch) + sep)) ||
      tree(pkg) !== contract.portable.packageTreeSha256 ||
      tree(dep) !== contract.portable.commanderTreeSha256
    )
      throw Error("Resolved portable installation differs from qualified artifact/dependencies");
    const paths = [
      "extension.json",
      ...["ingest", "ingest-heavy", "contributions-api", "federation"].map(
        (x) => `services/${x}/service.json`,
      ),
    ];
    const results = paths.map((path) => {
      const r = run(
        process.execPath,
        [
          entry,
          "validate",
          "--kind",
          path === "extension.json" ? "extension" : "service",
          join(directory, path),
        ],
        scratch,
        env,
      );
      return { path, exit: r.status, stdout: r.stdout, stderr: r.stderr };
    });
    const host = run(
      process.execPath,
      [
        join(root, "scripts/run-openmapx-admission.mjs"),
        join(scratch, "admission.mjs"),
        ...paths.slice(1).map((p) => join(directory, p)),
      ],
      scratch,
      env,
    );
    if (host.status !== 0)
      throw Error("Actual admission export failed: " + host.stdout + host.stderr);
    const records = JSON.parse(host.stdout).map((record, i) => ({
      path: paths[i + 1],
      problems: record.problems,
    }));
    if (
      results.some((r) => r.exit !== 0) ||
      records.length !== 4 ||
      records.some((r) => !Array.isArray(r.problems) || r.problems.length)
    )
      throw Object.assign(Error("Portable/community contract rejected prepared metadata"), {
        results: { portable: results, admission: records },
      });
    if (
      sha(regular(archive)) !== contract.portable.archiveSha256 ||
      sha(regular(admission)) !== contract.admission.entrySha256
    )
      throw Error("Tool bytes changed during validation");
    return {
      schemaVersion: 1,
      contract,
      portable: results,
      admission: records,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      scope:
        "Actual local exported contracts only; no deployed host, provider, secret resolution or readiness acceptance",
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    if (process.argv.length !== 4)
      throw Error(
        "Usage: node scripts/validate-product-manifests.mjs METADATA_DIRECTORY QUALIFIED_TOOLS_DIRECTORY",
      );
    console.log(JSON.stringify(validateProductManifests(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, results: error.results ?? null }));
    process.exitCode = 1;
  }
}
