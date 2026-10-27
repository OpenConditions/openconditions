#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const env = process.env;
const data = JSON.parse(readFileSync(env.OC_LINK_FIXTURE_DATA, "utf8"));
const tokenPresent = Boolean(env.GITHUB_TOKEN || env.GH_TOKEN);
appendFileSync("git-checks.jsonl", `${JSON.stringify({ tokenPresent })}\n`);
if (tokenPresent) process.exit(7);
const child = spawnSync(data.git, process.argv.slice(2), { env, stdio: "inherit" });
process.exitCode = child.status ?? 1;
