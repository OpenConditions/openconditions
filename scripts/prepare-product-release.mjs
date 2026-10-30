import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { checkReleaseInputs } from "./check-release-inputs.mjs";
import { previousVersionForHistory } from "./qualify-product-inputs.mjs";
import { contract, validateProductManifests } from "./validate-product-manifests.mjs";

const services = ["ingest", "ingest-heavy", "contributions-api", "federation"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function command(repo, args, env, input) {
  const r = spawnSync("git", ["--no-replace-objects", ...args], {
    cwd: repo,
    env,
    input,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw Error("Owned Git preparation failed: " + (r.error?.message ?? r.stderr));
  return r.stdout.trimEnd();
}
function decode(bytes) {
  const text = bytes.toString(),
    doc = parseDocument(text);
  if (doc.errors.length) throw Error("Duplicate/invalid JSON keys");
  return JSON.parse(text);
}
export function generateReleaseMetadata(repo, input, notes) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "history,imageSource,producerInputs,version"
  )
    throw Error("Unsupported preparation input fields");
  const { imageSource, version, producerInputs, history } = input;
  if (
    !/^[a-f0-9]{40}$/.test(imageSource) ||
    !Array.isArray(history) ||
    typeof notes !== "string" ||
    !notes.trim()
  )
    throw Error("Invalid preparation inputs");
  previousVersionForHistory(version, history);
  const read = (path) => decode(command(repo, ["show", `${imageSource}:${path}`], process.env));
  const result = {};
  const extension = read("extension.json");
  extension.version = version;
  for (const service of extension.services) service.ref = `v${version}`;
  result["extension.json"] = JSON.stringify(extension, null, 2) + "\n";
  for (const service of services) {
    const path = `services/${service}/service.json`,
      data = read(path),
      image = producerInputs.images[service === "ingest-heavy" ? "ingest" : service];
    data.version = version;
    data.container.tag = version;
    data.container.digest = image.digest;
    result[path] = JSON.stringify(data, null, 2) + "\n";
  }
  result[`docs/release-notes/${version}.json`] = JSON.stringify(producerInputs, null, 2) + "\n";
  result[`docs/release-notes/${version}.md`] = notes;
  return result;
}
export function validatePreparationReceipt(receipt) {
  const exact = (value, names) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), names.split(" ").sort());
  const keys = [
    "schemaVersion",
    "kind",
    "imageSourceSha",
    "version",
    "preparedTreeOid",
    "metadataSha256",
    "producerInputsSha256",
    "historySha256",
    "contextProof",
    "portable",
    "images",
    "nativeAuthority",
    "releaseAuthority",
    "downstream",
  ];
  if (
    !isDeepStrictEqual(Object.keys(receipt).sort(), keys.sort()) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "Owned product preparation only" ||
    receipt.nativeAuthority !== false ||
    receipt.releaseAuthority !== false ||
    !isDeepStrictEqual(receipt.portable.contract, contract)
  )
    throw Error("Invalid preparation receipt authority/schema");
  if (
    !/^[a-f0-9]{40}$/.test(receipt.preparedTreeOid) ||
    ![receipt.producerInputsSha256, receipt.historySha256].every((x) => /^[a-f0-9]{64}$/.test(x)) ||
    !exact(receipt.contextProof, "schemaVersion imageSource preparedTreeOid equal images") ||
    !exact(receipt.portable, "schemaVersion contract portable admission runtime scope") ||
    !exact(receipt.portable.runtime, "node platform arch")
  )
    throw Error("Unsupported nested preparation receipt schema");
  const paths = [
    "extension.json",
    ...services.map((x) => `services/${x}/service.json`),
    `docs/release-notes/${receipt.version}.json`,
    `docs/release-notes/${receipt.version}.md`,
  ];
  if (
    !isDeepStrictEqual(Object.keys(receipt.metadataSha256).sort(), paths.sort()) ||
    !Object.values(receipt.metadataSha256).every((x) => /^[a-f0-9]{64}$/.test(x)) ||
    !isDeepStrictEqual(
      Object.keys(receipt.images).sort(),
      ["ingest", "contributions-api", "federation", "openlr-resolver"].sort(),
    )
  )
    throw Error("Invalid prepared hash/image set");
  if (
    !/^[a-f0-9]{40}$/.test(receipt.imageSourceSha) ||
    !isDeepStrictEqual(receipt.contextProof, {
      ...receipt.contextProof,
      imageSource: receipt.imageSourceSha,
      preparedTreeOid: receipt.preparedTreeOid,
      equal: true,
    }) ||
    receipt.contextProof.schemaVersion !== 1 ||
    receipt.contextProof.images.length !== 4
  )
    throw Error("Invalid prepared context binding");
  const manifests = ["extension.json", ...services.map((x) => `services/${x}/service.json`)];
  if (
    !isDeepStrictEqual(
      receipt.portable.portable.map((x) => x.path),
      manifests,
    ) ||
    !isDeepStrictEqual(
      receipt.portable.admission.map((x) => x.path),
      manifests.slice(1),
    ) ||
    receipt.portable.portable.some((x) => !exact(x, "path exit stdout stderr")) ||
    receipt.portable.admission.some((x) => !exact(x, "path problems"))
  )
    throw Error("Unsupported actual contract result set");
  for (const image of Object.values(receipt.images))
    if (
      !exact(
        image,
        "repository digest platforms buildSourceSha qualificationArtifactId sbomArtifactId provenanceArtifactId",
      ) ||
      !isDeepStrictEqual(image.platforms, ["linux/amd64"]) ||
      !["qualificationArtifactId", "sbomArtifactId", "provenanceArtifactId"].every(
        (k) => Number.isSafeInteger(image[k]) && image[k] > 0,
      )
    )
      throw Error("Unsupported prepared image receipt");
  for (const [role, image] of Object.entries(receipt.images))
    if (
      image.buildSourceSha !== receipt.imageSourceSha ||
      image.repository !== `ghcr.io/openconditions/${role}` ||
      !/^sha256:[a-f0-9]{64}$/.test(image.digest)
    )
      throw Error("Invalid prepared image binding");
  if (
    receipt.portable.portable.length !== 5 ||
    receipt.portable.portable.some((x) => x.exit !== 0) ||
    receipt.portable.admission.length !== 4 ||
    receipt.portable.admission.some((x) => x.problems.length)
  )
    throw Error("Actual portable/admission proof missing");
  if (
    !isDeepStrictEqual(receipt.downstream, {
      nativeBQualification: "NOT_QUALIFIED",
      liveHost: "NOT_QUALIFIED",
      readiness: "NOT_QUALIFIED",
      approval: "NOT_QUALIFIED",
      publication: "NOT_IMPLEMENTED",
    })
  )
    throw Error("Unsupported preparation acceptance");
}
export function prepareProductRelease(repo, input, notes, output, tools) {
  repo = realpathSync(repo);
  output = join(realpathSync(dirname(resolve(output))), basename(resolve(output)));
  if (
    output === repo ||
    output.startsWith(repo + sep) ||
    existsSync(output) ||
    existsSync(output + ".receipt.json")
  )
    throw Error("Preparation requires a new owned output outside caller worktree");
  const files = generateReleaseMetadata(repo, input, notes),
    scratch = mkdtempSync(join(tmpdir(), "oc-release-preparation-"));
  let emitted = false;
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const bare = join(scratch, "objects.git");
    command(scratch, ["clone", "--shared", "--bare", "--no-hardlinks", "--", repo, bare], env);
    const own = {
      ...env,
      GIT_DIR: bare,
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_AUTHOR_NAME: "Owned validation",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Owned validation",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    command(scratch, ["read-tree", input.imageSource], own);
    for (const [path, bytes] of Object.entries(files)) {
      const oid = command(scratch, ["hash-object", "-w", "--stdin", "--no-filters"], own, bytes);
      command(scratch, ["update-index", "--add", "--cacheinfo", "100644", oid, path], own);
    }
    const tree = command(scratch, ["write-tree"], own);
    // Ephemeral plumbing object only: no caller refs/index, real B commit or future B SHA.
    const validationCommit = command(
      scratch,
      [
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-p",
        input.imageSource,
        "-m",
        "Owned metadata validation only",
      ],
      own,
    );
    const proof = checkReleaseInputs({
      repo: bare,
      imageSource: input.imageSource,
      releaseSource: validationCommit,
      version: input.version,
      previousVersion: previousVersionForHistory(input.version, input.history),
      producerInputs: input.producerInputs,
    });
    const metadata = join(scratch, "metadata");
    mkdirSync(metadata);
    for (const [path, bytes] of Object.entries(files)) {
      const file = join(metadata, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { flag: "wx", mode: 0o644 });
      chmodSync(file, 0o644);
    }
    const portable = validateProductManifests(metadata, tools);
    const receipt = {
      schemaVersion: 1,
      kind: "Owned product preparation only",
      imageSourceSha: input.imageSource,
      version: input.version,
      preparedTreeOid: tree,
      metadataSha256: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha(b)])),
      producerInputsSha256: sha(JSON.stringify(input.producerInputs)),
      historySha256: sha(JSON.stringify(input.history)),
      contextProof: {
        schemaVersion: 1,
        imageSource: input.imageSource,
        preparedTreeOid: tree,
        equal: proof.contexts.equal,
        images: proof.contexts.images,
      },
      portable,
      images: input.producerInputs.images,
      nativeAuthority: false,
      releaseAuthority: false,
      downstream: {
        nativeBQualification: "NOT_QUALIFIED",
        liveHost: "NOT_QUALIFIED",
        readiness: "NOT_QUALIFIED",
        approval: "NOT_QUALIFIED",
        publication: "NOT_IMPLEMENTED",
      },
    };
    if (
      proof.contexts === "NOT_CHECKED" ||
      !receipt.contextProof.equal ||
      Object.keys(receipt.metadataSha256).length !== 7
    )
      throw Error("Incomplete preparation proof");
    validatePreparationReceipt(receipt);
    mkdirSync(output);
    emitted = true;
    for (const [path, bytes] of Object.entries(files)) {
      const file = join(output, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { flag: "wx", mode: 0o644 });
      chmodSync(file, 0o644);
      if (sha(readFileSync(file)) !== receipt.metadataSha256[path])
        throw Error("Output bytes changed");
    }
    writeFileSync(output + ".receipt.json", JSON.stringify(receipt, null, 2) + "\n", {
      flag: "wx",
      mode: 0o644,
    });
    return receipt;
  } catch (error) {
    if (emitted) rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        inputs: { type: "string" },
        notes: { type: "string" },
        output: { type: "string" },
        tools: { type: "string" },
      },
      strict: true,
    });
    if (!["inputs", "notes", "output", "tools"].every((k) => values[k]))
      throw Error(
        "Required: --inputs JSON --notes MD --output NEW_TREE --tools QUALIFIED_LOCAL_TOOLS",
      );
    const result = prepareProductRelease(
      process.cwd(),
      decode(readFileSync(values.inputs)),
      readFileSync(values.notes, "utf8"),
      values.output,
      values.tools,
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, results: error.results ?? null }));
    process.exitCode = 1;
  }
}
