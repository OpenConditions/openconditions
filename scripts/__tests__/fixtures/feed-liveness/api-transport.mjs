import { readFileSync } from "node:fs";

// These standalone fixture processes are outside the Turbo task cache.
const env = process.env;
const config = JSON.parse(readFileSync(env.OC_LIVENESS_FIXTURE_DATA, "utf8"));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.github.com") throw new Error("unexpected fixture API origin");
  return realFetch(config.origin + url.pathname + url.search, init);
};
