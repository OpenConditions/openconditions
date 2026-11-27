import { deriveFeedId, readCatalogDir } from "@openconditions/ingest-framework";
import { INGEST_DOMAINS } from "../../../services/ingest/src/domains.js";
import { FEEDS_DIR } from "../catalog-paths.js";
import type { InventoryFeed } from "./model.js";

/** Baked definitions only. Never materialize catalog children or operator overlays. */
export async function readInventory(dir: string = FEEDS_DIR): Promise<InventoryFeed[]> {
  const { files } = readCatalogDir(dir, INGEST_DOMAINS);
  return files.flatMap((file) =>
    file.feeds.map((feed) => ({
      id: deriveFeedId({ region: file.region, ...feed }),
      domain: file.domain,
      region: file.region,
      disabled: !!feed.disabled,
      aggregator: feed.tier === "aggregator",
      urls: Object.values(feed.endpoints).flatMap((endpoint) => [
        ...(typeof endpoint.url === "string" ? [endpoint.url] : []),
        ...(endpoint.urls ?? []),
      ]),
      termsUrls: feed.terms?.url ? [feed.terms.url] : [],
      countries: feed.coverage?.countries ?? [],
      bbox: !!feed.coverage?.bbox,
    })),
  );
}
