import { readFileSync } from "node:fs";

const env = process.env;
const data = JSON.parse(readFileSync(env.OC_LINK_FIXTURE_DATA, "utf8"));
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.github.com") throw new Error("unexpected API origin");
  return original(data.origin + url.pathname + url.search, init);
};
