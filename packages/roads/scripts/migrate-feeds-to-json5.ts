import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { FEED_SOURCES } from "../src/feeds.js";

// Group the current (closure-free) registry by country and write one JSON5
// array per country. Run once, review the diff, then feeds.ts loads these.
const outDir = fileURLToPath(new URL("../feeds/roads/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const byCountry = new Map<string, unknown[]>();
for (const feed of FEED_SOURCES) {
  const key = feed.country.toLowerCase();
  const bucket = byCountry.get(key) ?? byCountry.set(key, []).get(key)!;
  bucket.push(feed);
}

let total = 0;
for (const [country, feeds] of byCountry) {
  const body = JSON5.stringify(feeds, { space: 2, quote: '"' });
  writeFileSync(`${outDir}${country}.json5`, `${body}\n`, "utf8");
  total += feeds.length;
  console.log(`wrote ${country}.json5 (${feeds.length} feed(s))`);
}
console.log(`total: ${total} feed(s) across ${byCountry.size} file(s)`);
