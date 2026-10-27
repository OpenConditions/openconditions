import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// These standalone fixture processes are outside the Turbo task cache.
const env = process.env;
const config = JSON.parse(readFileSync(env.OC_LIVENESS_FIXTURE_DATA, "utf8"));
const { runFeedsCheck } = await import(config.checkerUrl);
if (config.mode === "checker-crash") process.exit(1);
if (config.mode === "report-generation") mkdirSync("liveness/out.md");
const testFetch = (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== "provider.example.org") throw new Error("unexpected fixture provider");
  return globalThis.fetch(config.origin + url.pathname + url.search, init);
};
const code = await runFeedsCheck(process.argv.slice(2), {
  feedsDir: config.feedsDir,
  fetch: testFetch,
  env: process.env,
});
if (["partial", "wrong-source", "wrong-run", "wrong-attempt", "wrong-hash"].includes(config.mode)) {
  const receipt = JSON.parse(readFileSync("liveness/check.json", "utf8"));
  switch (config.mode) {
    case "partial":
      receipt.coverage.completed = 0;
      receipt.results = [];
      break;
    case "wrong-source":
      receipt.context.sourceSha = "b".repeat(40);
      break;
    case "wrong-run":
      receipt.context.runId = "999";
      break;
    case "wrong-attempt":
      receipt.context.runAttempt = "9";
      break;
    case "wrong-hash":
      receipt.reportSha256 = "b".repeat(64);
      break;
  }
  writeFileSync("liveness/check.json", JSON.stringify(receipt));
}
process.exitCode = code;
