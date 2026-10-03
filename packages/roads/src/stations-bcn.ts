import type { LineString } from "geojson";
import type { FlowSite, FlowSites } from "./flow-output.js";

/**
 * Parse Barcelona's "Relació de trams" long-format CSV
 * (`Tram,Tram_Components,Descripció,Longitud,Latitud`) into the TRAMS
 * segments: a tram id → LineString and description. One row per polyline
 * vertex; vertices are ordered by `Tram_Components`. The quoted `Descripció`
 * column (which itself contains commas) is read between the two leading
 * integer columns and the two trailing coordinate columns.
 */
export function parseBcnTramsStations(input: string): FlowSites {
  const byTram = new Map<
    string,
    { name?: string; pts: { seq: number; lon: number; lat: number }[] }
  >();
  const rowRe = /^(\d+),(\d+),(.*),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s*$/;
  for (const line of input.split(/\r?\n/)) {
    const m = rowRe.exec(line);
    if (!m) continue;
    const [, tram, seq, description, lon, lat] = m;
    const entry = byTram.get(tram!) ?? { pts: [] };
    const name = description!
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    if (name !== "") entry.name ??= name;
    entry.pts.push({ seq: Number(seq), lon: Number(lon), lat: Number(lat) });
    byTram.set(tram!, entry);
  }
  const map = new Map<string, FlowSite>();
  for (const [tram, { name, pts }] of byTram) {
    if (pts.length < 2) continue;
    pts.sort((a, b) => a.seq - b.seq);
    const coordinates = pts.map((p) => [p.lon, p.lat] as [number, number]);
    map.set(tram, {
      geometry: { type: "LineString", coordinates } satisfies LineString,
      ...(name !== undefined ? { name } : {}),
    });
  }
  return map;
}
