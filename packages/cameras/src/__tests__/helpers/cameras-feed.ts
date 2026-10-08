import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FeedDefinition,
  type ParseContext,
  type Region,
  readCatalogDir,
  regionFileSchema,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { camerasDomain } from "../../domain.js";
import { type CamerasCatalogFeed, camerasFeedShape } from "../../feed-schema.js";

const FEEDS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "..", "feeds");

let catalogue: Map<string, CamerasCatalogFeed> | undefined;

/**
 * Every feed of `feeds/cameras/`, disabled ones included, derived as the
 * loader derives it; empty while the catalogue has no camera feeds.
 */
export function camerasCatalogue(): ReadonlyMap<string, CamerasCatalogFeed> {
  catalogue ??= new Map(
    readCatalogDir(FEEDS_DIR, [camerasDomain], { otherDomains: "ignore" }).files.flatMap((file) =>
      file.feeds.map((definition) => {
        const feed = toCatalogFeed(definition, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }) as CamerasCatalogFeed;
        return [feed.id, feed] as const;
      }),
    ),
  );
  return catalogue;
}

/** One camera feed as its region file writes it. */
export function catalogFeed(id: string): CamerasCatalogFeed {
  const feed = camerasCatalogue().get(id);
  if (feed === undefined) throw new Error(`no feed ${id} in feeds/cameras`);
  return structuredClone(feed);
}

/**
 * A camera feed written as a region file would write it, checked against the
 * cameras feed shape and the domain's lint, and derived as the loader derives
 * it: what the parser tests run on before the catalogue carries the feed.
 */
export function cameraFeed(
  region: Region,
  definition: Record<string, unknown>,
): CamerasCatalogFeed {
  const parsed = regionFileSchema(camerasFeedShape).parse({ feeds: [definition] });
  const def = parsed.feeds[0] as FeedDefinition;
  const issues = camerasDomain.lintFeed?.(def) ?? [];
  if (issues.length > 0) throw new Error(`feed lint: ${issues.join("; ")}`);
  return toCatalogFeed(def, {
    domain: "cameras",
    region,
    file: `feeds/cameras/${region}.jsonc`,
    maintainers: [],
  }) as CamerasCatalogFeed;
}

export const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name));

export const parseContext = (fetchedAt: string, cadenceSec = 600): ParseContext => ({
  fetchedAt,
  cadenceSec,
  reference: {},
});
