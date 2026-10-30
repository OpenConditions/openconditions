import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const helper = join(root, "scripts/check-docker-contexts.mjs");
export const images = ["ingest", "contributions-api", "federation", "openlr-resolver"];
export function run(cwd: string, command: string, args: string[]) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
  if (r.error || r.status !== 0) throw new Error(`${command} failed: ${r.error ?? r.stderr}`);
  return r.stdout.trim();
}
export function put(repo: string, path: string, data: string | Buffer) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), data);
}
export function commit(repo: string) {
  run(repo, "git", ["add", "."]);
  run(repo, "git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  ]);
  return run(repo, "git", ["rev-parse", "HEAD"]);
}
export function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "oc-context-fixture-"));
  run(repo, "git", ["init", "-q"]);
  put(repo, ".git/info/exclude", "untracked-secret.txt\nlocal-build-scratch/\n");
  for (const p of [
    ".dockerignore",
    ".github/workflows/ci.yml",
    "scripts/qualify-container-images.py",
    ...images.map((i) => `services/${i}/Dockerfile`),
    "services/openlr-resolver/.dockerignore",
    "services/ingest/.dockerignore",
  ])
    put(repo, p, readFileSync(join(root, p)));
  for (const [p, value] of Object.entries({
    "extension.json": '{"version":"fixture-a"}',
    "package.json": '{"name":"fixture"}',
    "pnpm-lock.yaml": "lockfileVersion: fixture\n",
    "packages/core/src/index.ts": "export const fixture = 1;\n",
    "packages/core/src/- ü\nname.ts": "export const fixture = 1;\n",
    "packages/core/drizzle/001.sql": "select 1;\n",
    "packages/core/LICENSE": "fixture license\n",
    "packages/core/NOTICE": "fixture notice\n",
    "feeds/roads/de.jsonc": "[]\n",
    "services/ingest/service.json": '{"version":"fixture-a"}',
    "services/ingest-heavy/service.json": '{"version":"fixture-a"}',
    "services/contributions-api/service.json": '{"version":"fixture-a"}',
    "services/federation/service.json": '{"version":"fixture-a"}',
    "services/ingest/src/index.ts": "export const fixture = 1;\n",
    "services/openlr-resolver/app/__main__.py": "fixture = 1\n",
    "services/openlr-resolver/requirements.txt": "fixture==1\n",
    "services/openlr-resolver/LICENSE": "fixture license\n",
    "services/openlr-resolver/NOTICE": "fixture notice\n",
    "docs/release-notes/fixture.json": "{}\n",
    "advisor-plans/private.txt": "private plan\n",
    "plans/private.txt": "private plan\n",
    ".env.private": "fixture-secret\n",
  }))
    put(repo, p, value);
  const a = commit(repo);
  put(repo, "untracked-secret.txt", "must not enter context\n");
  return { repo, a };
}
export function check(repo: string, a: string, b: string, env = process.env) {
  return spawnSync(process.execPath, [helper, "--image-source", a, "--release-source", b], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}
