import path from "node:path";
import type { CatalogResolver, FeedSourceBase } from "@openconditions/ingest-framework";
import autobahnSnapshot from "./snapshots/autobahn-index.json" with { type: "json" };

const AUTOBAHN_BASE = "https://verkehr.autobahn.de/o/autobahn";

// Warnings and closures are the high-signal road conditions. The `roadworks`
// service is a high-volume planned-works firehose (hundreds of items per road),
// so it is intentionally left out; add it here to enable it.
const AUTOBAHN_SERVICES = ["warning", "closure"] as const;

interface AutobahnIndex {
  roads?: unknown;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pulls the Autobahn road index and emits one feed descriptor per (road ×
 * service) for the high-signal services. Road names are trimmed (the upstream
 * list contains stray whitespace, e.g. `"A60 "`) and deduped before enumeration.
 */
async function resolve(fetchFn: typeof fetch): Promise<FeedSourceBase[]> {
  const res = await fetchFn(`${AUTOBAHN_BASE}/`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the Autobahn road index`);

  const data = (await res.json()) as AutobahnIndex;
  const rawRoads = Array.isArray(data.roads) ? data.roads : [];

  const roads = new Set<string>();
  for (const raw of rawRoads) {
    if (typeof raw !== "string") continue;
    const road = raw.trim();
    if (road) roads.add(road);
  }

  const feeds: FeedSourceBase[] = [];
  for (const road of roads) {
    for (const service of AUTOBAHN_SERVICES) {
      feeds.push({
        id: `autobahn-${slug(road)}-${service}`,
        name: `Autobahn ${road} — ${service}`,
        operator: "autobahn",
        format: "autobahn",
        url: `${AUTOBAHN_BASE}/${encodeURIComponent(road)}/services/${service}`,
        cadenceSec: 300,
        freshnessWindowSec: 900,
        license: "dl-de/by-2-0",
        attribution: "Quelle: Die Autobahn GmbH des Bundes",
        country: "DE",
        privacyUrl: "https://www.autobahn.de/datenschutz",
        enabledByDefault: true,
      });
    }
  }
  return feeds;
}

export const autobahnIndexResolver: CatalogResolver = {
  id: "autobahn-index",
  snapshotPath: path.resolve(import.meta.dirname, "snapshots/autobahn-index.json"),
  snapshot: autobahnSnapshot as FeedSourceBase[],
  resolve,
};
