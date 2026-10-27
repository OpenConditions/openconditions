#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// These standalone fixture processes are outside the Turbo task cache.
const env = process.env;
const config = JSON.parse(readFileSync(env.OC_LIVENESS_FIXTURE_DATA, "utf8"));
const tokenPresent = Boolean(env.GITHUB_TOKEN || env.GH_TOKEN);
appendFileSync(
  "git-env-checks.jsonl",
  `${JSON.stringify({ tokenPresent, args: process.argv.slice(2) })}\n`,
);
if (tokenPresent) {
  console.error("reporting token reached Git");
  process.exit(7);
}
const result = spawnSync(config.realGit, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
