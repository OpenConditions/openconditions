import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRepo,
  makeRepoKeys,
  pastDate,
  type RepoKeys,
  rolesFrom,
  sampleEntry,
  tempDir,
  writeRegistryDir,
} from "../../packages/federation/src/__tests__/tuf-fixture.js";
import { generateTufSigner } from "../../packages/federation/src/tuf/signing.js";
import { verifyRegistryMetadata } from "../../packages/federation/src/tuf/verify.js";

/**
 * Cross-checks the registry's TUF repository tool and client against
 * python-tuf: python-tuf's client reads repositories `signRegistry` writes,
 * and `verifyRegistryMetadata` reads repositories python-tuf's Metadata API
 * writes. Each direction covers a valid release, a threshold met and missed,
 * a root rotation with and without the previous root's signatures, expiry,
 * snapshot and target tampering, and rollback against a retained cache.
 */

const [python] = process.argv.slice(2);
if (!python) throw new Error("usage: tsx scripts/tuf-interop/check.ts <python with python-tuf>");
const script = fileURLToPath(new URL("./tuf_interop.py", import.meta.url));

function runPython(args: string[]): Record<string, unknown> {
  const result = spawnSync(python as string, ["-I", script, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`python-tuf failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const registryDir = writeRegistryDir([sampleEntry("openmapx-de"), sampleEntry("openmapx-nl")]);
const TARGETS = ["openmapx-de.yaml", "openmapx-nl.yaml"];
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const expectedTargets = Object.fromEntries(TARGETS.map((t) => [t, sha256(join(registryDir, t))]));

/**
 * Changes one character of a file without changing its length, so only a
 * hash (not a length) check can notice. Metadata keeps its signed content:
 * the change falls in a signature, which the client must never get to check.
 */
function tamper(path: string): void {
  const text = readFileSync(path, "utf8");
  const at = text.includes('"sig":"') ? text.indexOf('"sig":"') + 7 : text.indexOf("Operator");
  assert.ok(at >= 0, `nothing to tamper with in ${path}`);
  const swapped = text[at] === "0" ? "1" : text[at] === "O" ? "o" : "0";
  writeFileSync(path, `${text.slice(0, at)}${swapped}${text.slice(at + 1)}`);
}

let checks = 0;
function report(direction: string, name: string, outcome: string): void {
  checks += 1;
  console.log(`${direction}: ${name}: ${outcome}`);
}

/** python-tuf's client over a repository, trusting the root written at `trustedRoot`. */
function pythonClient(repoDir: string, trustedRoot: string, cache = tempDir("oc-tuf-py-cache-")) {
  return { result: runPython(["client", repoDir, trustedRoot, cache]), cache };
}

function trustedRootFile(bytes: Buffer): string {
  const path = join(tempDir("oc-tuf-root-"), "root.json");
  writeFileSync(path, bytes);
  return path;
}

function expectPythonAccepts(name: string, result: Record<string, unknown>, rootVersion = 1) {
  assert.deepEqual(result, { ok: true, rootVersion, targets: expectedTargets }, name);
  report("signRegistry → python-tuf", name, "accepted");
}

function expectPythonRejects(name: string, result: Record<string, unknown>, error: string) {
  assert.equal(result["ok"], false, `${name}: accepted`);
  assert.equal(result["error"], error, `${name}: ${String(result["message"])}`);
  report("signRegistry → python-tuf", name, `rejected (${error})`);
}

async function ocProducesPythonConsumes(): Promise<void> {
  const valid = await buildRepo({ registryDir });
  const validRoot = trustedRootFile(valid.rootBytes);
  expectPythonAccepts("valid release", pythonClient(valid.repoDir, validRoot).result);

  const thresholdKeys = await makeRepoKeys();
  const targetSigners = [
    await generateTufSigner(),
    await generateTufSigner(),
    await generateTufSigner(),
  ];
  for (const [name, signed] of [
    ["targets threshold 2 of 3 met", 2],
    ["targets threshold 2 of 3 missed", 1],
  ] as const) {
    const repo = await buildRepo({
      registryDir,
      keys: thresholdKeys,
      roles: rolesFrom(thresholdKeys, {
        targets: {
          keys: targetSigners.map((s) => s.key),
          threshold: 2,
          signers: targetSigners.slice(0, signed),
        },
      }),
    });
    const { result } = pythonClient(repo.repoDir, trustedRootFile(repo.rootBytes));
    if (signed === 2) expectPythonAccepts(name, result);
    else expectPythonRejects(name, result, "UnsignedMetadataError");
  }

  for (const [name, signedByOld] of [
    ["root rotation signed by the old and new root keys", true],
    ["root rotation signed by the new root key only", false],
  ] as const) {
    const keys = await makeRepoKeys();
    const v1 = await buildRepo({ registryDir, keys });
    const newRoot = await generateTufSigner();
    const rotated: RepoKeys = { ...keys, root: [newRoot] };
    await buildRepo({
      registryDir,
      repoDir: v1.repoDir,
      keys: rotated,
      roles: rolesFrom(rotated, {
        root: { signers: signedByOld ? [...keys.root, newRoot] : [newRoot] },
      }),
      version: 2,
      rootVersion: 2,
    });
    const { result } = pythonClient(v1.repoDir, trustedRootFile(v1.rootBytes));
    if (signedByOld) expectPythonAccepts(name, result, 2);
    else expectPythonRejects(name, result, "UnsignedMetadataError");
  }

  const expired = await buildRepo({ registryDir, expires: { timestamp: pastDate() } });
  expectPythonRejects(
    "expired timestamp",
    pythonClient(expired.repoDir, trustedRootFile(expired.rootBytes)).result,
    "ExpiredMetadataError",
  );

  const snapshotTampered = await buildRepo({ registryDir });
  tamper(join(snapshotTampered.metadataDir, "snapshot.json"));
  expectPythonRejects(
    "snapshot not matching the timestamp's hash",
    pythonClient(snapshotTampered.repoDir, trustedRootFile(snapshotTampered.rootBytes)).result,
    "LengthOrHashMismatchError",
  );

  const targetTampered = await buildRepo({ registryDir });
  tamper(join(targetTampered.targetsDir, TARGETS[0] as string));
  expectPythonRejects(
    "target file not matching its targets entry",
    pythonClient(targetTampered.repoDir, trustedRootFile(targetTampered.rootBytes)).result,
    "LengthOrHashMismatchError",
  );

  const keys = await makeRepoKeys();
  const now = new Date().toISOString();
  const v2 = await buildRepo({ registryDir, keys, version: 2, now });
  const root = trustedRootFile(v2.rootBytes);
  const first = pythonClient(v2.repoDir, root);
  expectPythonAccepts("release 2 before a rollback", first.result);
  const v1 = await buildRepo({ registryDir, keys, version: 1, now });
  expectPythonRejects(
    "rollback to release 1 against the retained cache",
    pythonClient(v1.repoDir, root, first.cache).result,
    "BadVersionNumberError",
  );
}

async function ocVerify(repoDir: string, trustedRoot: string, cacheDir = tempDir("oc-tuf-cache-")) {
  const entries = await verifyRegistryMetadata(repoDir, readFileSync(trustedRoot), {
    cacheDir,
    env: "test",
  });
  return { ids: entries.map((e) => e.id), cacheDir };
}

async function expectOcRejects(name: string, run: Promise<unknown>, error: RegExp) {
  // tuf-js wraps most failures in a plain Error, so the message tells the reason.
  let reason = "";
  await assert.rejects(run, (thrown: Error) => {
    assert.match(thrown.message, error, name);
    reason = thrown.message;
    return true;
  });
  report("python-tuf → verifyRegistryMetadata", name, `rejected (${reason})`);
}

async function pythonProducesOcConsumes(): Promise<void> {
  const produce = (scenario: string) => {
    const out = join(tempDir("oc-tuf-py-repo-"), "repo");
    const produced = runPython(["repo", scenario, registryDir, out]);
    return { repoDir: out, ...(produced as { trustedRoot: string; older?: string }) };
  };
  const accepted = async (name: string, scenario: string) => {
    const { repoDir, trustedRoot } = produce(scenario);
    assert.deepEqual((await ocVerify(repoDir, trustedRoot)).ids, ["openmapx-de", "openmapx-nl"]);
    report("python-tuf → verifyRegistryMetadata", name, "accepted");
  };
  const rejected = async (name: string, scenario: string, error: RegExp) => {
    const { repoDir, trustedRoot } = produce(scenario);
    await expectOcRejects(name, ocVerify(repoDir, trustedRoot), error);
  };

  await accepted("valid release", "valid");
  await accepted("targets threshold 2 of 3 met", "threshold-met");
  await rejected(
    "targets threshold 2 of 3 missed",
    "threshold-unmet",
    /targets was signed by 1\/2 keys/,
  );
  await accepted("root rotation signed by the old and new root keys", "rotation");
  await rejected(
    "root rotation signed by the new root key only",
    "rotation-unauthorized",
    /root was signed by 0\/1 keys/,
  );
  await rejected("expired timestamp", "expired", /timestamp\.json is expired/);

  const snapshot = produce("valid");
  tamper(join(snapshot.repoDir, "metadata", "snapshot.json"));
  await expectOcRejects(
    "snapshot not matching the timestamp's hash",
    ocVerify(snapshot.repoDir, snapshot.trustedRoot),
    /snapshot metadata error Error: Expected hash/,
  );

  const target = produce("valid");
  tamper(join(target.repoDir, "targets", TARGETS[0] as string));
  await expectOcRejects(
    "target file not matching its targets entry",
    ocVerify(target.repoDir, target.trustedRoot),
    /^Expected hash [0-9a-f]+ but got/,
  );

  const rollback = produce("rollback");
  const { cacheDir } = await ocVerify(rollback.repoDir, rollback.trustedRoot);
  report("python-tuf → verifyRegistryMetadata", "release 2 before a rollback", "accepted");
  await expectOcRejects(
    "rollback to release 1 against the retained cache",
    ocVerify(rollback.older as string, rollback.trustedRoot, cacheDir),
    /New timestamp version 1 is less than current version 2/,
  );
}

await ocProducesPythonConsumes();
await pythonProducesOcConsumes();
console.log(`${checks} TUF interoperability checks passed`);
