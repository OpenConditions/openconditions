import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatCatalogIssue,
  type IngestDomain,
  lintCatalog,
  PENDING_REVIEW_FILE,
  readCatalogDir,
} from "@openconditions/ingest-framework";
import { INGEST_DOMAINS } from "../services/ingest/src/domains.js";
import { FEEDS_DIR } from "./lib/catalog-paths.js";

/**
 * The offline catalogue check: every region file and `credentials.jsonc` read
 * against its schema, then the catalogue linted as a whole (see `lintCatalog`).
 * A file that cannot be read stops the lint there, its problems reported as
 * errors. The feeds still awaiting a licence review are read from
 * `rights-pending-review.json` beside the region files.
 */
export function lintFeeds(
  dir: string,
  domains: readonly IngestDomain[] = INGEST_DOMAINS,
  now: Date = new Date(),
): { errors: string[]; warnings: string[] } {
  let catalog: ReturnType<typeof readCatalogDir>;
  try {
    catalog = readCatalogDir(dir, domains);
  } catch (err) {
    // readCatalogDir throws every problem at once, one per line under a heading.
    const [heading = "", ...lines] = (err as Error).message.split("\n");
    return { errors: lines.length > 0 ? lines.map((l) => l.trim()) : [heading], warnings: [] };
  }
  let pending: Set<string>;
  try {
    pending = readPendingReview(dir);
  } catch (err) {
    return { errors: [`${PENDING_REVIEW_FILE}: ${(err as Error).message}`], warnings: [] };
  }
  const issues = lintCatalog(catalog.files, catalog.credentials, domains, now, pending);
  const lines = (level: "error" | "warning") =>
    issues.filter((i) => i.level === level).map(formatCatalogIssue);
  return { errors: lines("error"), warnings: lines("warning") };
}

/** The feed ids `rights-pending-review.json` lists: sorted, unique strings. */
export function readPendingReview(dir: string): Set<string> {
  const body = JSON.parse(
    readFileSync(path.join(dir, path.basename(PENDING_REVIEW_FILE)), "utf8"),
  ) as { feeds?: unknown };
  const ids = body.feeds;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    throw new Error("feeds must be an array of feed ids");
  }
  const sorted = [...ids].sort();
  if (new Set(ids).size !== ids.length || ids.some((id, i) => id !== sorted[i])) {
    throw new Error("feeds must be sorted and unique");
  }
  return new Set(ids);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, warnings } = lintFeeds(FEEDS_DIR);
  for (const warning of warnings) console.warn(`warning  ${warning}`);
  for (const error of errors) console.error(`error    ${error}`);
  console.log(`feeds:lint: ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (errors.length > 0) process.exit(1);
}
