import path from "node:path";
import type { CatalogResolver, FeedSourceBase } from "@openconditions/ingest-framework";
import autobahnSnapshot from "./snapshots/autobahn-index.json" with { type: "json" };

const AUTOBAHN_BASE = "https://verkehr.autobahn.de/o/autobahn";

/**
 * The three event services, with a per-service poll cadence. Roadworks is by far
 * the largest (~170 items on the A4 alone vs. a handful of warnings), but it is
 * planned work: the schedules shift over weeks, not minutes, so polling it at a
 * third of the incident rate keeps the extra fetch volume roughly flat while
 * still catching same-day changes.
 */
const AUTOBAHN_SERVICES = [
  { name: "warning", cadenceSec: 300 },
  { name: "closure", cadenceSec: 300 },
  { name: "roadworks", cadenceSec: 900 },
] as const;

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
 * service). Road names are trimmed (the upstream list contains stray whitespace,
 * e.g. `"A60 "`) and deduped before enumeration.
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
        id: `autobahn-${slug(road)}-${service.name}`,
        name: `Autobahn ${road} — ${service.name}`,
        operator: "autobahn",
        format: "autobahn",
        url: `${AUTOBAHN_BASE}/${encodeURIComponent(road)}/services/${service.name}`,
        cadenceSec: service.cadenceSec,
        freshnessWindowSec: 900,
        license: "dl-de/by-2-0",
        attribution: "Quelle: Die Autobahn GmbH des Bundes",
        country: "DE",
        privacyUrl: "https://www.autobahn.de/datenschutz",
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
