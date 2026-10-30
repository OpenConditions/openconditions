import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { setupRelease } from "./product-release-fixtures.js";

function invoke(file: string, name: string, args: unknown[]) {
  const code =
    'import {pathToFileURL} from "node:url"; const m=await import(pathToFileURL(process.argv[2]).href); console.log(JSON.stringify(m[process.argv[3]](...JSON.parse(process.argv[4]))));';
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      code,
      "owned-function-harness",
      fileURLToPath(new URL("../" + file, import.meta.url)),
      name,
      JSON.stringify(args),
    ],
    { encoding: "utf8" },
  );
}
function generateReleaseMetadata(...args: unknown[]) {
  const r = invoke("prepare-product-release.mjs", "generateReleaseMetadata", args);
  if (r.status !== 0) throw Error(r.stderr);
  return JSON.parse(r.stdout);
}
const owned: string[] = [];
afterEach(() => {
  for (const p of owned.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("generates exactly seven data paths without touching index/worktree and keeps default/optional identity", () => {
  const f = setupRelease(),
    index = readFileSync(join(f.repo, ".git/index")),
    before = readFileSync(join(f.repo, "extension.json"));
  const files = generateReleaseMetadata(
    f.repo,
    { imageSource: f.a, version: f.version, producerInputs: f.candidate, history: ["v0.7.0"] },
    "Owned reviewed fixture notes.\n",
  );
  expect(Object.keys(files)).toHaveLength(7);
  const extension = JSON.parse(files["extension.json"]);
  expect(extension.services.map((s: { service: string }) => s.service)).toEqual([
    "openconditions-ingest",
    "openconditions-contributions-api",
  ]);
  expect(JSON.parse(files["services/ingest/service.json"]).container.digest).toBe(
    JSON.parse(files["services/ingest-heavy/service.json"]).container.digest,
  );
  expect(JSON.parse(files["services/federation/service.json"]).id).toBe(
    "openconditions-federation",
  );
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(readFileSync(join(f.repo, "extension.json"))).toEqual(before);
  const a = JSON.parse(readFileSync(join(f.repo, "services/ingest/service.json"), "utf8")),
    b = JSON.parse(files["services/ingest/service.json"]);
  expect(b.configSchema).toEqual(a.configSchema);
  expect(b.container.environment).toEqual(a.container.environment);
});
it("rejects unsupported input/version/history without pretending metadata generation is qualification", () => {
  const f = setupRelease();
  for (const extra of [
    { version: "main" },
    { history: ["not-semver"] },
    { version: "0.7.0" },
    { extra: true },
  ])
    expect(() =>
      generateReleaseMetadata(
        f.repo,
        {
          imageSource: f.a,
          version: f.version,
          producerInputs: f.candidate,
          history: ["v0.7.0"],
          ...extra,
        },
        "notes",
      ),
    ).toThrow();
});
it("refuses substituted actual-tool bytes before any tool execution; no fallback tool is injected", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-tool-pin-"));
  owned.push(dir);
  writeFileSync(join(dir, "portable.tgz"), "wrong bytes");
  writeFileSync(join(dir, "admission.mjs"), 'throw Error("must not execute")');
  const result = invoke("validate-product-manifests.mjs", "validateProductManifests", [dir, dir]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("artifact pin mismatch");
  const contract = JSON.parse(
    readFileSync(new URL("../openmapx-product-contracts.json", import.meta.url), "utf8"),
  );
  expect(contract.sourceSha).toMatch(/^[a-f0-9]{40}$/);
});
it("native preparation CLI rejects non-workflow contexts before token or provider access", () => {
  const r = spawnSync("python3", ["scripts/prepare-product-release.py"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("untrusted qualification context");
});
it("will not create output inside caller worktree even with a valid metadata input", () => {
  const f = setupRelease(),
    path = join(f.repo, "unsafe-output");
  const r = invoke("prepare-product-release.mjs", "prepareProductRelease", [
    f.repo,
    { imageSource: f.a, version: f.version, producerInputs: f.candidate, history: ["v0.7.0"] },
    "notes",
    path,
    "not-used",
  ]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("outside caller worktree");
  expect(existsSync(path)).toBe(false);
});
