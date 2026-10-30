import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

// These are the literal contexts in the reviewed CI qualification implementation. Fail on drift rather
// than guessing a context or inheriting a service-local ignore for a root build.
export const images = Object.freeze([
  { image: "ingest", context: ".", recipe: "services/ingest/Dockerfile" },
  {
    image: "contributions-api",
    context: ".",
    recipe: "services/contributions-api/Dockerfile",
  },
  {
    image: "federation",
    context: ".",
    recipe: "services/federation/Dockerfile",
  },
  {
    image: "openlr-resolver",
    context: "services/openlr-resolver",
    recipe: "services/openlr-resolver/Dockerfile",
  },
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function command(cwd, executable, args) {
  // Supplied SHAs must name their immutable objects, including when a caller
  // selects a custom GIT_REPLACE_REF_BASE. Apply this to every Git operation.
  const commandArgs = executable === "git" ? ["--no-replace-objects", ...args] : args;
  const r = spawnSync(executable, commandArgs, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `${executable} ${args[0]} failed (${r.error?.code ?? r.status}); ${executable === "docker" ? "install/start local Docker with docker buildx; no hook downloads tools" : "check the requested commit/tool"}`,
    );
  return r.stdout;
}
function regular(path) {
  // One no-follow handle binds type, bytes and identity; never stat then reopen.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("expected regular file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("file changed during inventory");
    return { bytes, mode: Number(after.mode & 0o777n) };
  } finally {
    closeSync(fd);
  }
}
function optional(path) {
  try {
    return regular(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function safePath(path) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    path.includes("\uFFFD")
  )
    throw new Error("unsafe Git path");
  return path;
}
function inventory(root, prefix = "") {
  const result = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = safePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isDirectory()) result.push(...inventory(root, path));
    else if (entry.isFile()) {
      const f = regular(join(root, path));
      result.push({ path, mode: f.mode, sha256: sha256(f.bytes) });
    } else throw new Error("context export must contain only regular files/directories");
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function snapshot(repo, sha, dest, scratch) {
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error("source identities must be 40 lowercase hex commit SHAs");
  if (command(repo, "git", ["cat-file", "-t", sha]).trim() !== "commit")
    throw new Error("source must identify a commit");
  const tree = command(repo, "git", ["ls-tree", "-rz", sha])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("snapshot requires regular Git files (no symlinks/submodules)");
      return {
        mode: match[1] === "100755" ? 0o755 : 0o644,
        oid: match[2],
        path: safePath(match[3]),
      };
    });
  mkdirSync(dest);
  const tar = join(scratch, `${sha}-${dest.endsWith("a") ? "a" : "b"}.tar`);
  command(repo, "git", [
    "-c",
    "core.attributesFile=/dev/null",
    "archive",
    "--format=tar",
    `--output=${tar}`,
    sha,
  ]);
  // Paths/modes were checked before extraction: Git cannot contribute link or
  // traversal entries. All output is confined to this private temporary root.
  command(repo, "tar", ["-xf", tar, "-C", dest]);
  for (const entry of tree) {
    const path = join(dest, entry.path);
    const { bytes } = regular(path);
    const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (oid !== entry.oid)
      throw new Error("Git archive changed source bytes (export-subst is unsupported)");
    chmodSync(path, entry.mode);
  }
  if (inventory(dest).length !== tree.length)
    throw new Error("incomplete or malformed Git archive (export-ignore is unsupported)");
}
function producer(root) {
  const doc = parseDocument(regular(join(root, ".github/workflows/ci.yml")).bytes.toString());
  if (doc.errors.length) throw new Error("invalid CI producer contract");
  const job = doc.toJS().jobs?.["build-images"];
  const step = job?.steps?.filter((s) => s.name === "Build, smoke, scan and bind image evidence");
  // A changed Python producer needs a fresh review of these context/recipe facts.
  if (
    sha256(regular(join(root, "scripts/qualify-container-images.py")).bytes) !==
      "7e39177c13736f896bdf9e2e046c2506edfd5ca82fb4dd8615aa6758f65a17d3" ||
    JSON.stringify(job?.strategy?.matrix) !==
      JSON.stringify({ image: images.map((i) => i.image) }) ||
    step?.length !== 1 ||
    step[0].env?.IMAGE !== `\${{ matrix.image }}` ||
    step[0].run?.trim().replace(/\s+/g, " ") !==
      'python scripts/qualify-container-images.py qualify --image "$IMAGE" --source "$GITHUB_SHA" --output "$RUNNER_TEMP/qualified-image"'
  )
    throw new Error("unsupported CI producer context/recipe policy");
}
function selectedIgnore(root, image) {
  const specific = `${image.recipe}.dockerignore`;
  return optional(join(root, specific))
    ? specific
    : `${image.context === "." ? "" : `${image.context}/`}.dockerignore`;
}
function controls(a, b) {
  const paths = new Set([".github/workflows/ci.yml", "scripts/qualify-container-images.py"]);
  for (const image of images) {
    paths.add(image.recipe);
    paths.add(`${image.recipe}.dockerignore`);
    paths.add(`${image.context === "." ? "" : `${image.context}/`}.dockerignore`);
  }
  for (const path of paths) {
    const left = optional(join(a, path));
    const right = optional(join(b, path));
    if (
      (left?.mode ?? null) !== (right?.mode ?? null) ||
      !((left === null && right === null) || (left && right && left.bytes.equals(right.bytes)))
    )
      throw new Error(`build control changed: ${path}`);
  }
}
function exportContext(root, image, scratch, side) {
  const context = join(root, image.context);
  const toolRoot = join(scratch, `exporter-${side}-${image.image}`);
  mkdirSync(toolRoot);
  const dockerfile = join(toolRoot, "Context.Dockerfile");
  writeFileSync(dockerfile, "FROM scratch\nCOPY . /\n");
  const ignorePath = selectedIgnore(root, image);
  const ignore = optional(join(root, ignorePath));
  // An external exporter keeps the real recipe unchanged and copyable. Its
  // Dockerfile-specific ignore is byte-identical to the producer's selected
  // ignore; Docker/BuildKit, not a second parser, applies those rules.
  if (ignore) writeFileSync(`${dockerfile}.dockerignore`, ignore.bytes);
  const output = join(toolRoot, "output");
  const metadata = join(toolRoot, "metadata.json");
  command(root, "docker", [
    "buildx",
    "build",
    "--progress=quiet",
    "--network=none",
    "--provenance=false",
    "--file",
    dockerfile,
    "--metadata-file",
    metadata,
    "--output",
    `type=local,dest=${output}`,
    context,
  ]);
  let receipt;
  try {
    receipt = JSON.parse(regular(metadata).bytes.toString());
  } catch {
    throw new Error("missing/malformed BuildKit export metadata");
  }
  if (typeof receipt["buildx.build.ref"] !== "string" || !receipt["buildx.build.ref"])
    throw new Error("missing BuildKit build identity");
  const entries = inventory(output);
  const required =
    image.context === "."
      ? ["package.json", "pnpm-lock.yaml"]
      : ["requirements.txt", "app/__main__.py"];
  if (!required.every((path) => entries.some((e) => e.path === path)))
    throw new Error("incomplete context export: missing required inputs");
  // Reject unexpected/rewritten files, mode loss, links or partial tool output.
  const source = new Map(inventory(context).map((e) => [e.path, e]));
  for (const entry of entries)
    if (JSON.stringify(source.get(entry.path)) !== JSON.stringify(entry))
      throw new Error(
        `export content/mode differs from archived source: ${JSON.stringify({
          image: image.image,
          side,
          path: entry.path,
          expected: source.get(entry.path) ?? null,
          actual: entry,
        })}`,
      );
  return {
    entries,
    summary: {
      files: entries.length,
      inventory: entries,
      inventorySha256: sha256(JSON.stringify(entries)),
      ignore: ignore ? ignorePath : null,
      ignoreSha256: ignore ? sha256(ignore.bytes) : null,
      buildRef: receipt["buildx.build.ref"],
    },
  };
}
export function compareDockerContexts({ repo, imageSource, releaseSource }) {
  const scratch = mkdtempSync(join(tmpdir(), "oc-docker-contexts-"));
  try {
    const a = join(scratch, "a");
    const b = join(scratch, "b");
    snapshot(repo, imageSource, a, scratch);
    snapshot(repo, releaseSource, b, scratch);
    producer(a);
    producer(b);
    controls(a, b);
    const outcomes = images.map((image) => {
      const left = exportContext(a, image, scratch, "a");
      const right = exportContext(b, image, scratch, "b");
      const l = new Map(left.entries.map((e) => [e.path, e]));
      const r = new Map(right.entries.map((e) => [e.path, e]));
      const differences = [...new Set([...l.keys(), ...r.keys()])]
        .filter((path) => JSON.stringify(l.get(path)) !== JSON.stringify(r.get(path)))
        .sort();
      return {
        image: image.image,
        context: image.context,
        recipe: image.recipe,
        a: left.summary,
        b: right.summary,
        differences,
      };
    });
    return {
      schemaVersion: 1,
      imageSource,
      releaseSource,
      equal: outcomes.every((i) => !i.differences.length),
      images: outcomes,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , a, imageSource, b, releaseSource, ...extra] = process.argv;
    if (a !== "--image-source" || b !== "--release-source" || extra.length)
      throw new Error(
        "usage: node scripts/check-docker-contexts.mjs --image-source <SHA> --release-source <SHA>",
      );
    const result = compareDockerContexts({ repo: process.cwd(), imageSource, releaseSource });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.equal ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Docker context check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
