/**
 * Regenerate the places of the vendored border-crossing table
 * (packages/border/src/snapshots/crossings.json) from Wikidata (CC0). Which
 * Wikidata item each CBP port and CBSA office is, and the zone its clocks
 * keep, are curated in the table itself; this script reads each item's English
 * label and coordinate location, and warns where a crossing lies far from the
 * point the Bureau of Transportation Statistics publishes for its CBP port
 * (public domain), which catches an item picked for the wrong port.
 *
 *   pnpm tsx scripts/gen-border-crossings.ts           # refresh the places
 *   pnpm tsx scripts/gen-border-crossings.ts --feeds   # also list ports the live feeds name but the table lacks
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { BorderCrossing, BorderCrossingSnapshot } from "../packages/border/src/crossings.js";

const OUT = "packages/border/src/snapshots/crossings.json";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const BTS_PORTS =
  "https://data.bts.gov/resource/keg4-3bc2.json?$select=port_code,port_name,latitude,longitude&$group=port_code,port_name,latitude,longitude&$limit=1000";
const CBP_FEED = "https://bwt.cbp.gov/api/bwtnew";
const CBSA_FEED = "https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv";
const HEADERS = {
  "User-Agent":
    "OpenConditions-BorderCrossings/1.0 (+https://github.com/openconditions/openconditions)",
};
/** How far a crossing may lie from its CBP port's BTS point; a port of several crossings spans tens of kilometres. */
const BTS_WARN_KM = 40;

type Curated = Pick<BorderCrossing, "wikidata" | "countries" | "zone" | "cbp" | "cbsa">;

interface WikidataEntity {
  labels?: { en?: { value: string } };
  claims?: {
    P625?: { mainsnak: { datavalue?: { value: { latitude: number; longitude: number } } } }[];
  };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { ...HEADERS, ...headers } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function entities(ids: readonly string[]): Promise<Map<string, WikidataEntity>> {
  const out = new Map<string, WikidataEntity>();
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams({
      action: "wbgetentities",
      ids: ids.slice(i, i + 50).join("|"),
      props: "labels|claims",
      languages: "en",
      format: "json",
    });
    const answer = (await getJson(`${WIKIDATA}?${params}`)) as {
      entities: Record<string, WikidataEntity>;
    };
    for (const [id, entity] of Object.entries(answer.entities)) out.set(id, entity);
  }
  return out;
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

function km(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

async function crossCheckBts(crossings: readonly BorderCrossing[]): Promise<void> {
  const rows = (await getJson(BTS_PORTS)) as {
    port_code: string;
    latitude?: string;
    longitude?: string;
  }[];
  const ports = new Map<string, [number, number]>();
  for (const r of rows) {
    if (r.latitude && r.longitude)
      ports.set(r.port_code, [Number(r.longitude), Number(r.latitude)]);
  }
  for (const c of crossings) {
    for (const port of c.cbp) {
      const point = ports.get(port.slice(0, 4).toUpperCase());
      if (point === undefined) continue;
      const d = km([c.lon, c.lat], point);
      if (d > BTS_WARN_KM) {
        console.warn(
          `! ${port} ${c.wikidata} (${c.name}) lies ${d.toFixed(1)} km from BTS port ${port.slice(0, 4)}`,
        );
      }
    }
  }
}

async function listFeedGaps(crossings: readonly BorderCrossing[]): Promise<void> {
  const ports = new Set(crossings.flatMap((c) => c.cbp));
  const offices = new Set(crossings.flatMap((c) => c.cbsa));
  const cbp = (await getJson(CBP_FEED, {
    Accept: "application/json",
    "Accept-Language": "en-US",
  })) as { port_number: string; port_name: string; crossing_name: string }[];
  for (const p of cbp) {
    if (!ports.has(p.port_number)) {
      console.warn(`- CBP ${p.port_number} ${p.port_name}: ${p.crossing_name} has no crossing`);
    }
  }
  const res = await fetch(CBSA_FEED, { headers: HEADERS });
  if (!res.ok) throw new Error(`${CBSA_FEED}: HTTP ${res.status}`);
  const rows = (await res.text()).replace(/^﻿/, "").trim().split(/\r?\n/).slice(1);
  for (const row of rows) {
    const office = row.split(";;")[0]?.trim();
    if (office && !offices.has(office)) console.warn(`- CBSA ${office} has no crossing`);
  }
}

async function main() {
  const current = JSON.parse(readFileSync(OUT, "utf8")) as {
    crossings: (Curated & Partial<BorderCrossing>)[];
  };
  const items = await entities(current.crossings.map((c) => c.wikidata));
  const crossings: BorderCrossing[] = current.crossings.map((c) => {
    const entity = items.get(c.wikidata);
    const name = entity?.labels?.en?.value;
    const at = entity?.claims?.P625?.[0]?.mainsnak.datavalue?.value;
    if (name === undefined || at === undefined) {
      throw new Error(`${c.wikidata} has no English label or no coordinate location`);
    }
    return {
      wikidata: c.wikidata,
      name,
      lon: round(at.longitude),
      lat: round(at.latitude),
      countries: c.countries,
      zone: c.zone,
      cbp: c.cbp,
      cbsa: c.cbsa,
    };
  });
  await crossCheckBts(crossings);
  if (process.argv.includes("--feeds")) await listFeedGaps(crossings);

  const snapshot: BorderCrossingSnapshot = {
    source: "https://www.wikidata.org/wiki/Special:EntityData",
    license: "CC0-1.0",
    retrievedAt: new Date().toISOString(),
    crossings,
  };
  // One crossing per line, so a change reads as a diff of the crossings it touched.
  const body = crossings.map((c) => `    ${JSON.stringify(c)}`).join(",\n");
  const { crossings: _crossings, ...head } = snapshot;
  const header = JSON.stringify(head, null, 2).slice(0, -2);
  writeFileSync(OUT, `${header},\n  "crossings": [\n${body}\n  ]\n}\n`);
  console.log(`wrote ${crossings.length} crossings → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
