import type { LineString } from "geojson";
import type { SiteGeometry } from "./siteTable.js";

/**
 * Parse Barcelona's "Relació de trams" long-format CSV
 * (`Tram,Tram_Components,Descripció,Longitud,Latitud`) into a tram-id →
 * LineString registry for the TRAMS flow parser. One row per polyline vertex;
 * vertices are ordered by `Tram_Components`. The quoted `Descripció` column
 * (which itself contains commas) is skipped by anchoring the match on the two
 * leading integer columns and the two trailing coordinate columns.
 */
export function parseBcnTramsStations(input: string): Map<string, SiteGeometry> {
  const byTram = new Map<string, { seq: number; lon: number; lat: number }[]>();
  const rowRe = /^(\d+),(\d+),.*,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s*$/;
  for (const line of input.split(/\r?\n/)) {
    const m = rowRe.exec(line);
    if (!m) continue;
    const [, tram, seq, lon, lat] = m;
    const arr = byTram.get(tram!) ?? [];
    arr.push({ seq: Number(seq), lon: Number(lon), lat: Number(lat) });
    byTram.set(tram!, arr);
  }
  const map = new Map<string, SiteGeometry>();
  for (const [tram, pts] of byTram) {
    if (pts.length < 2) continue;
    pts.sort((a, b) => a.seq - b.seq);
    const coordinates = pts.map((p) => [p.lon, p.lat] as [number, number]);
    map.set(tram, { type: "LineString", coordinates } satisfies LineString);
  }
  return map;
}
