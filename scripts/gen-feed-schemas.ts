import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  credentialsFileJsonSchema,
  type IngestDomain,
  regionFileJsonSchema,
} from "@openconditions/ingest-framework";
import { INGEST_DOMAINS } from "../services/ingest/src/domains.js";
import { FEED_SCHEMA_DIR } from "./lib/catalog-paths.js";

/**
 * The JSON Schemas the catalogue files name in `$schema`: one per domain
 * (`<domain>.schema.json`, what a region file of that domain may hold) and
 * `credentials.schema.json`. `--write` regenerates them; without it the script
 * lists stale files and exits 1 (pre-commit and CI).
 */

/** Every schema file name mapped to its rendered content. */
export function renderFeedSchemas(domains: readonly IngestDomain[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const domain of domains) {
    files.set(
      `${domain.id}.schema.json`,
      `${JSON.stringify(regionFileJsonSchema(domain), null, 2)}\n`,
    );
  }
  files.set("credentials.schema.json", `${JSON.stringify(credentialsFileJsonSchema(), null, 2)}\n`);
  return files;
}

function readOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function committedSchemas(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".schema.json"));
  } catch {
    return [];
  }
}

/**
 * In write mode, brings `dir` in line with the render: changed schemas
 * rewritten, schemas no domain generates removed. In check mode, lists those
 * files instead (sorted) and touches nothing.
 */
export function applyOrCheckFeedSchemas(
  dir: string,
  domains: readonly IngestDomain[],
  write: boolean,
): { drift: string[] } {
  const rendered = renderFeedSchemas(domains);
  const drift: string[] = [];
  if (write) mkdirSync(dir, { recursive: true });
  for (const [name, content] of rendered) {
    const file = join(dir, name);
    if (readOrUndefined(file) === content) continue;
    if (write) writeFileSync(file, content);
    else drift.push(file);
  }
  for (const name of committedSchemas(dir)) {
    if (rendered.has(name)) continue;
    const file = join(dir, name);
    if (write) rmSync(file);
    else drift.push(file);
  }
  return { drift: drift.sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  const { drift } = applyOrCheckFeedSchemas(FEED_SCHEMA_DIR, INGEST_DOMAINS, write);
  if (write) {
    console.log("✓ feed schemas written");
  } else if (drift.length > 0) {
    console.error(`✗ stale feed schemas (run pnpm gen:feed-schemas):\n  ${drift.join("\n  ")}`);
    process.exit(1);
  } else {
    console.log("✓ feed schemas up to date");
  }
}
