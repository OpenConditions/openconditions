import { fileURLToPath } from "node:url";
import {
  allowedTemplateVars,
  assertPublicUrl,
  licenseInfo,
  loadFeedFiles,
} from "@openconditions/ingest-framework";
import { roadFeedSchema } from "../src/feed-schema.js";

type RoadFeed = ReturnType<typeof roadFeedSchema.parse>;

const TEMPLATE_TOKEN = /\$\{([A-Za-z0-9_]+)\}/g;

/** Every `${NAME}` token referenced in a template string, de-duplicated. */
function templateTokens(template: string): string[] {
  return [...template.matchAll(TEMPLATE_TOKEN)].map((m) => m[1]!);
}

/** Per-feed lint checks: egress on every static url + a registered license. */
export function lintFeed(feed: RoadFeed): string[] {
  const problems: string[] = [];

  // Egress guard on every STATIC url (skip env-templated `${…}` and catalog
  // feeds — those resolve at fetch time and are guarded then).
  const urls = feed.url == null ? [] : Array.isArray(feed.url) ? feed.url : [feed.url];
  if (feed.siteTable?.url != null) urls.push(feed.siteTable.url);
  if (feed.stationRegistry?.url != null) urls.push(feed.stationRegistry.url);
  for (const url of urls) {
    if (url.includes("${")) continue;
    try {
      assertPublicUrl(url);
    } catch (err) {
      problems.push(`${feed.id}: ${url} — ${(err as Error).message}`);
    }
  }

  // Template-exfiltration guard: every `${VAR}` token in `url`/`bodyTemplate`
  // must be declared in the feed's own `requiredEnv`/auth vars — the same
  // allowlist `resolveUrlTemplate` enforces at fetch time. A feed that fails
  // this check would crash on its first live fetch (`resolveUrlTemplate`
  // throws for an undeclared token), so this is caught here instead, at
  // commit/CI time, naming the exact undeclared variable.
  const allowed = allowedTemplateVars(feed);
  const templated = feed.url == null ? [] : Array.isArray(feed.url) ? feed.url : [feed.url];
  if (feed.bodyTemplate != null) templated.push(feed.bodyTemplate);
  for (const template of templated) {
    for (const name of templateTokens(template)) {
      if (!allowed.has(name)) {
        problems.push(
          `${feed.id}: template references undeclared variable \${${name}} — add it to requiredEnv`
        );
      }
    }
  }

  if (!licenseInfo(feed.license)) {
    problems.push(
      `${feed.id}: unknown license id '${feed.license}' — add it to packages/ingest-framework/src/licenses.ts`
    );
  }

  return problems;
}

/** Returns a list of human-readable problems; empty === clean. */
export function lintFeedDir(dir: string): string[] {
  // Schema validation (throws an aggregated error naming file + zod path).
  let feeds: RoadFeed[];
  try {
    feeds = loadFeedFiles(dir, roadFeedSchema);
  } catch (err) {
    return [(err as Error).message];
  }

  return feeds.flatMap((feed) => lintFeed(feed));
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
