import path from "node:path";
import {
  type CatalogParent,
  type CatalogResolver,
  type ChildFeed,
  registryUrl,
} from "@openconditions/ingest-framework";
import { roadChildren } from "./child-schema.js";
import autobahnSnapshot from "./snapshots/autobahn-index.json" with { type: "json" };

const RESOLVER_ID = "autobahn-index";

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
 * Pulls the Autobahn road index the parent names and emits one child per
 * (road × service), named `<road>-<service>` (e.g. `a1-warning`), each road's
 * services under the index URL. Road names are trimmed (the upstream list
 * contains stray whitespace, e.g. `"A60 "`) and deduped before enumeration.
 * Every child is published under the Datenlizenz Deutschland.
 */
async function resolve(parent: CatalogParent, fetchFn: typeof fetch): Promise<ChildFeed[]> {
  const index = registryUrl(parent, RESOLVER_ID);
  const res = await fetchFn(index);
  // Each road sits under the index path, written with or without its trailing slash.
  const base = new URL(index);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the Autobahn road index`);

  const data = (await res.json()) as AutobahnIndex;
  const rawRoads = Array.isArray(data.roads) ? data.roads : [];

  const roads = new Set<string>();
  for (const raw of rawRoads) {
    if (typeof raw !== "string") continue;
    const road = raw.trim();
    if (road) roads.add(road);
  }

  const children: ChildFeed[] = [];
  for (const road of roads) {
    for (const service of AUTOBAHN_SERVICES) {
      children.push({
        qualifier: `${slug(road)}-${service.name}`,
        name: `Autobahn ${road} — ${service.name}`,
        endpoints: {
          main: {
            url: new URL(`${encodeURIComponent(road)}/services/${service.name}`, base).href,
            cadenceSec: service.cadenceSec,
          },
        },
        license: "DL-DE-BY-2.0",
        selectionState: "approved",
      });
    }
  }
  return roadChildren(children);
}

export const autobahnIndexResolver: CatalogResolver = {
  id: RESOLVER_ID,
  snapshotPath: path.resolve(import.meta.dirname, "snapshots/autobahn-index.json"),
  snapshot: roadChildren(autobahnSnapshot),
  resolve,
};
