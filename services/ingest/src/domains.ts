import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Catalog,
  type CatalogFeed,
  type FeedFormat,
  type IngestDomain,
  loadCatalog,
} from "@openconditions/ingest-framework";
import { roadsDomain } from "@openconditions/roads";

/** The domains this service ingests. */
export const INGEST_DOMAINS: readonly IngestDomain[] = [roadsDomain as unknown as IngestDomain];

/**
 * The baked-in catalogue, in both layouts the code runs in: the shipped
 * bundle (`dist/index.js` → `./feeds`, copied there by the ingest build) and a
 * source checkout (`src/domains.ts` → the repo's `feeds/`).
 */
function bakedFeedsDir(): string {
  const candidates = [
    fileURLToPath(new URL("./feeds", import.meta.url)),
    fileURLToPath(new URL("../../../feeds", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

/**
 * The catalogue the service runs: the baked feeds, an operator's mount
 * (`OPENCONDITIONS_FEEDS_DIR`) and, when `OPENCONDITIONS_FEEDS_REMOTE_ENABLED`
 * is `true`, the remote bundle at `OPENCONDITIONS_FEEDS_REMOTE_URL`, whose last
 * good copy is kept in the state dir so it outlives a restart.
 */
export function loadIngestCatalog(env: NodeJS.ProcessEnv = process.env): Promise<Catalog> {
  const remoteUrl = env["OPENCONDITIONS_FEEDS_REMOTE_URL"];
  const remoteEnabled = env["OPENCONDITIONS_FEEDS_REMOTE_ENABLED"] === "true";
  if (remoteEnabled && !remoteUrl) {
    console.warn(
      "[catalog] OPENCONDITIONS_FEEDS_REMOTE_ENABLED is true but OPENCONDITIONS_FEEDS_REMOTE_URL is not set; remote layer skipped",
    );
  }
  const remote =
    remoteEnabled && remoteUrl
      ? {
          url: remoteUrl,
          snapshotPath: join(
            env["OPENCONDITIONS_STATE_DIR"] || "/data",
            "feeds",
            "remote-snapshot.json",
          ),
        }
      : undefined;
  const mount = env["OPENCONDITIONS_FEEDS_DIR"];
  return loadCatalog(INGEST_DOMAINS, {
    baked: bakedFeedsDir(),
    ...(mount ? { mount } : {}),
    ...(remote ? { remote } : {}),
  });
}

/** The domain a feed belongs to; throws for one this service does not ingest. */
export function domainOf(feed: Pick<CatalogFeed, "id" | "domain">): IngestDomain {
  const domain = INGEST_DOMAINS.find((d) => d.id === feed.domain);
  if (!domain) throw new Error(`feed ${feed.id}: unknown domain ${feed.domain}`);
  return domain;
}

/** How a feed's payloads are read; throws for an unknown domain or format. */
export function formatOf(feed: Pick<CatalogFeed, "id" | "domain" | "format">): FeedFormat {
  const { formats } = domainOf(feed);
  const format = Object.hasOwn(formats, feed.format) ? formats[feed.format] : undefined;
  if (!format) throw new Error(`feed ${feed.id}: unknown ${feed.domain} format ${feed.format}`);
  return format;
}
