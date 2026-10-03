import { fileURLToPath } from "node:url";
import {
  formatCatalogIssue,
  type IngestDomain,
  lintCatalog,
  readCatalogDir,
} from "@openconditions/ingest-framework";
import { INGEST_DOMAINS } from "../services/ingest/src/domains.js";
import { FEEDS_DIR } from "./lib/catalog-paths.js";

/**
 * The offline catalogue check: every region file and `credentials.jsonc` read
 * against its schema, then the catalogue linted as a whole (see `lintCatalog`).
 * A file that cannot be read stops the lint there, its problems reported as
 * errors.
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
  const issues = lintCatalog(catalog.files, catalog.credentials, domains, now);
  const lines = (level: "error" | "warning") =>
    issues.filter((i) => i.level === level).map(formatCatalogIssue);
  return { errors: lines("error"), warnings: lines("warning") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, warnings } = lintFeeds(FEEDS_DIR);
  for (const warning of warnings) console.warn(`warning  ${warning}`);
  for (const error of errors) console.error(`error    ${error}`);
  console.log(`feeds:lint: ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (errors.length > 0) process.exit(1);
}
