import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import { commit, fixture, put, root } from "./docker-context-fixtures.js";

const owned: string[] = [];
afterEach(() => {
  for (const p of owned.splice(0)) rmSync(p, { recursive: true, force: true });
});
export function setupRelease(fullSource = false) {
  const f = fixture();
  owned.push(f.repo);
  if (fullSource) {
    for (const name of readdirSync(f.repo))
      if (name !== ".git") rmSync(join(f.repo, name), { recursive: true, force: true });
    const archive = execFileSync("git", ["--no-replace-objects", "archive", "HEAD"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", f.repo], { input: archive });
  }
  for (const p of [
    "extension.json",
    ...["ingest", "ingest-heavy", "contributions-api", "federation"].map(
      (x) => `services/${x}/service.json`,
    ),
  ])
    put(f.repo, p, readFileSync(join(root, p)));
  const a = commit(f.repo),
    version = "0.8.0-alpha.1";
  const candidate = {
    schemaVersion: 1,
    version,
    imageSourceSha: a,
    producer: { workflowFile: ".github/workflows/ci.yml", runId: 1, runAttempt: 1 },
    images: Object.fromEntries(
      ["ingest", "contributions-api", "federation", "openlr-resolver"].map((x, i) => [
        x,
        {
          repository: `ghcr.io/openconditions/${x}`,
          digest: `sha256:${String(i + 1).repeat(64)}`,
          platforms: ["linux/amd64"],
          buildSourceSha: a,
          qualificationArtifactId: 10 + i,
          sbomArtifactId: 20 + i,
          provenanceArtifactId: 30 + i,
        },
      ]),
    ),
  };
  put(f.repo, "docs/release-notes/" + version + ".json", JSON.stringify(candidate));
  put(f.repo, "docs/release-notes/" + version + ".md", "Owned synthetic release communication.\n");
  const extension = JSON.parse(readFileSync(join(f.repo, "extension.json"), "utf8"));
  extension.version = version;
  for (const s of extension.services) s.ref = "v" + version;
  put(f.repo, "extension.json", JSON.stringify(extension));
  for (const x of ["ingest", "ingest-heavy", "contributions-api", "federation"]) {
    const p = `services/${x}/service.json`,
      d = JSON.parse(readFileSync(join(f.repo, p), "utf8"));
    d.version = version;
    d.container.tag = version;
    d.container.digest = candidate.images[x === "ingest-heavy" ? "ingest" : x].digest;
    put(f.repo, p, JSON.stringify(d));
  }
  const receipt = join(f.repo, ".git/producer.json");
  put(f.repo, ".git/producer.json", JSON.stringify(candidate));
  const check = (contexts = false) => {
    const b = commit(f.repo),
      indexBefore = readFileSync(join(f.repo, ".git/index"));
    const result = spawnSync(
      process.execPath,
      [
        join(root, "scripts/check-release-inputs.mjs"),
        "--image-source",
        a,
        "--release-source",
        b,
        "--version",
        version,
        "--previous-version",
        "0.7.0",
        "--producer-inputs",
        receipt,
        ...(contexts ? [] : ["--metadata-only"]),
      ],
      { cwd: f.repo, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
    );
    return Object.assign(result, {
      indexBefore,
      indexAfter: readFileSync(join(f.repo, ".git/index")),
    });
  };
  return { ...f, a, version, candidate, check };
}
