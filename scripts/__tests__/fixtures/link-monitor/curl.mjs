#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const env = process.env;
const data = JSON.parse(readFileSync(env.OC_LINK_FIXTURE_DATA, "utf8"));
if (env.GITHUB_TOKEN || env.GH_TOKEN) process.exit(7);
const args = process.argv.slice(2);
appendFileSync("curl-checks.jsonl", `${JSON.stringify(args)}\n`);
const url = new URL(args.at(-1));
if (url.origin !== "https://registry.npmjs.org") throw new Error("unexpected registry");
if (data.mode === "curl-error") process.exit(28);
if (data.mode === "curl-config") process.exit(3);
if (data.mode === "curl-malformed") {
  process.stdout.write("not-a-status");
  process.exit(0);
}
args[args.length - 1] = data.origin + url.pathname;
const child = spawnSync(data.curl, args, { env, stdio: "inherit" });
process.exitCode = child.status ?? 1;
