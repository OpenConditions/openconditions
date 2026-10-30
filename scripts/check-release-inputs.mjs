import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { compareDockerContexts, images } from "./check-docker-contexts.mjs";

// Reuse the installed, lock-pinned Changesets SemVer implementation, not a second engine.
const semver = createRequire(import.meta.resolve("@changesets/cli/package.json"))("semver");
const services = ["ingest", "ingest-heavy", "contributions-api", "federation"];
const fail = (message) => {
  throw new Error(message);
};
function json(text) {
  const value = JSON.parse(text);
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) fail("duplicate or invalid JSON keys");
  return value;
}
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  )
    fail("unexpected object keys");
}
function equal(a, b, message) {
  if (!isDeepStrictEqual(a, b)) fail(message);
}
function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail("invalid immutable producer/artifact identity");
}
function git(repo, args) {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}
function entries(repo, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || git(repo, ["cat-file", "-t", sha]) !== "commit")
    fail("immutable commit required");
  return new Map(
    git(repo, ["ls-tree", "-rz", sha])
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const m = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
        if (!m) fail("regular Git files required (no symlinks/submodules)");
        return [m[3], { mode: m[1], oid: m[2] }];
      }),
  );
}
function read(repo, sha, path) {
  return json(git(repo, ["show", `${sha}:${path}`]));
}
// RFC6901 tokens are decoded individually; arrays retain order and cardinality.
function without(value, pointers) {
  const copy = structuredClone(value);
  for (const pointer of pointers) {
    const tokens = pointer
      .slice(1)
      .split("/")
      .map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"));
    let parent = copy;
    for (const key of tokens.slice(0, -1)) {
      if (!parent || typeof parent !== "object") fail("missing pointer parent");
      parent = parent[key];
    }
    delete parent[tokens.at(-1)];
  }
  return copy;
}
export function checkReleaseMetadata({
  repo,
  imageSource,
  releaseSource,
  version,
  previousVersion,
  producerInputs,
}) {
  if (
    semver.valid(version) !== version ||
    semver.valid(previousVersion) !== previousVersion ||
    !semver.gt(version, previousVersion)
  )
    fail("selected version must be canonical SemVer later than previous history");
  const a = entries(repo, imageSource),
    b = entries(repo, releaseSource);
  const note = `docs/release-notes/${version}`,
    candidatePath = `${note}.json`;
  const allowed = new Set([
    "extension.json",
    ...services.map((x) => `services/${x}/service.json`),
    candidatePath,
    `${note}.md`,
  ]);
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const l = a.get(path),
      r = b.get(path);
    if (l?.mode !== r?.mode && l && r) fail(`mode changed: ${path}`);
    if (!isDeepStrictEqual(l, r) && !allowed.has(path)) fail(`nonmetadata path changed: ${path}`);
    if (allowed.has(path) && r?.mode !== "100644")
      fail(`release file missing or nonregular mode: ${path}`);
  }
  if (a.has(candidatePath) || a.has(`${note}.md`))
    fail("selected release note already exists at image source");
  if (
    !b.has(candidatePath) ||
    !b.has(`${note}.md`) ||
    !git(repo, ["show", `${releaseSource}:${note}.md`]).trim()
  )
    fail("missing release notes");
  const c = read(repo, releaseSource, candidatePath);
  keys(c, ["schemaVersion", "version", "imageSourceSha", "producer", "images"]);
  equal(
    [c.schemaVersion, c.version, c.imageSourceSha],
    [1, version, imageSource],
    "candidate source/version mismatch",
  );
  keys(c.producer, ["workflowFile", "runId", "runAttempt"]);
  equal(c.producer.workflowFile, ".github/workflows/ci.yml", "wrong producer workflow");
  positive(c.producer.runId);
  positive(c.producer.runAttempt);
  keys(
    c.images,
    images.map((x) => x.image),
  );
  for (const { image } of images) {
    const i = c.images[image];
    keys(i, [
      "repository",
      "digest",
      "platforms",
      "buildSourceSha",
      "qualificationArtifactId",
      "sbomArtifactId",
      "provenanceArtifactId",
    ]);
    equal(i.repository, `ghcr.io/openconditions/${image}`, "wrong fixed image repository");
    if (typeof i.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(i.digest))
      fail("invalid digest");
    equal(i.platforms, ["linux/amd64"], "unsupported producer platform set");
    equal(i.buildSourceSha, imageSource, "older/different image source not approved");
    for (const k of ["qualificationArtifactId", "sbomArtifactId", "provenanceArtifactId"])
      positive(i[k]);
  }
  equal(c, producerInputs, "candidate differs from separately supplied producer inputs");
  const extension = "extension.json",
    old = read(repo, imageSource, extension),
    next = read(repo, releaseSource, extension);
  equal(
    [next.version, next.services?.length, next.services?.[0]?.ref, next.services?.[1]?.ref],
    [version, 2, `v${version}`, `v${version}`],
    "extension version/ref/membership mismatch",
  );
  equal(
    without(old, ["/version", "/services/0/ref", "/services/1/ref"]),
    without(next, ["/version", "/services/0/ref", "/services/1/ref"]),
    "frozen extension field changed",
  );
  for (const name of services) {
    const path = `services/${name}/service.json`,
      old = read(repo, imageSource, path),
      next = read(repo, releaseSource, path),
      i = c.images[name === "ingest-heavy" ? "ingest" : name];
    equal(
      [next.version, next.container?.tag, next.container?.digest, next.container?.image],
      [version, version, i.digest, i.repository],
      "service version/tag/digest/repository mismatch",
    );
    equal(
      without(old, ["/version", "/container/tag", "/container/digest"]),
      without(next, ["/version", "/container/tag", "/container/digest"]),
      "frozen service field changed",
    );
  }
  return c;
}
export function checkReleaseInputs(options) {
  const candidate = checkReleaseMetadata(options);
  const contexts = options.metadataOnly ? "NOT_CHECKED" : compareDockerContexts(options);
  if (contexts !== "NOT_CHECKED" && !contexts.equal) fail("effective Docker contexts differ");
  return {
    schemaVersion: 1,
    imageSource: options.imageSource,
    releaseSource: options.releaseSource,
    candidate,
    contexts,
    authority:
      "Caller-supplied producer binding only; not GitHub CI approval, host admission or release permission",
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      values = {},
      names = new Set([
        "--image-source",
        "--release-source",
        "--version",
        "--previous-version",
        "--producer-inputs",
      ]);
    let metadataOnly = false;
    while (args.length) {
      const key = args.shift();
      if (key === "--metadata-only" && !metadataOnly) {
        metadataOnly = true;
        continue;
      }
      if (!names.has(key) || Object.hasOwn(values, key) || !args.length) fail("invalid arguments");
      values[key] = args.shift();
    }
    if (Object.keys(values).length !== names.size)
      fail(
        "required: --image-source SHA --release-source SHA --version SEMVER --previous-version SEMVER --producer-inputs FILE [--metadata-only]",
      );
    console.log(
      JSON.stringify(
        checkReleaseInputs({
          repo: process.cwd(),
          imageSource: values["--image-source"],
          releaseSource: values["--release-source"],
          version: values["--version"],
          previousVersion: values["--previous-version"],
          producerInputs: json(readFileSync(values["--producer-inputs"], "utf8")),
          metadataOnly,
        }),
      ),
    );
  } catch (error) {
    console.error(`Release input check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
