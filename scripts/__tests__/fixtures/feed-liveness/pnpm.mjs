#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// These standalone fixture processes are outside the Turbo task cache.
const env = process.env;
const config = JSON.parse(readFileSync(env.OC_LIVENESS_FIXTURE_DATA, "utf8"));
const args = process.argv.slice(2);
appendFileSync("commands.jsonl", `${JSON.stringify(args)}\n`);
if (env.GITHUB_TOKEN || env.GH_TOKEN) {
  throw new Error("writer token reached provider child");
}
if (args[0] === "install") process.exit(config.mode === "install-error" ? 1 : 0);
if (args[0] === "build:domains") process.exit(config.mode === "build-error" ? 1 : 0);
if (args[0] !== "exec" || args[1] !== "tsx" || args[2] !== "scripts/feeds-check.ts") {
  throw new Error("unexpected fixture command");
}
const child = spawn(process.execPath, [config.tsx, ...args.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
