import { fileURLToPath } from "node:url";
import { assertPublicUrl, loadFeedFiles } from "@openconditions/ingest-framework";
import { roadFeedSchema } from "../src/feed-schema.js";

type RoadFeed = ReturnType<typeof roadFeedSchema.parse>;

// Replaced with the curated license registry (LICENSES) once it lands.
const KNOWN_LICENSE_STUB = (id: string): boolean => id.length > 0;

/** Returns a list of human-readable problems; empty === clean. */
export function lintFeedDir(dir: string): string[] {
  const problems: string[] = [];

  // Schema validation (throws an aggregated error naming file + zod path).
  let feeds: RoadFeed[];
  try {
    feeds = loadFeedFiles(dir, roadFeedSchema);
  } catch (err) {
    return [(err as Error).message];
  }

  for (const feed of feeds) {
    // Egress guard on every STATIC url (skip env-templated `${…}` and catalog
    // feeds — those resolve at fetch time and are guarded then).
    const urls = feed.url == null ? [] : Array.isArray(feed.url) ? feed.url : [feed.url];
    for (const url of urls) {
      if (url.includes("${")) continue;
      try {
        assertPublicUrl(url);
      } catch (err) {
        problems.push(`${feed.id}: ${url} — ${(err as Error).message}`);
      }
    }
    if (!KNOWN_LICENSE_STUB(feed.license)) {
      problems.push(`${feed.id}: unknown license "${feed.license}"`);
    }
  }
  return problems;
}

// CLI entry: lint the repo's roads feed dir and set the exit code.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = fileURLToPath(new URL("../feeds/roads", import.meta.url));
  const problems = lintFeedDir(dir);
  if (problems.length > 0) {
    console.error(`feeds-lint found ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("feeds-lint: all feed files valid");
}
