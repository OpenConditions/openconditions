/**
 * Score a vendored TMC location table against records that carry BOTH an
 * Alert-C location code and real coordinates.
 *
 * Resolving location codes is only safe if the table is the edition the feeds
 * actually reference — codes are renumbered between editions, so the failure
 * mode is a confident coordinate on the wrong road rather than a visible error.
 * This harness is how that is checked rather than assumed, and it is what
 * rejected an OpenStreetMap-derived table (55% of codes present, ~900 m median)
 * in favour of the published one.
 *
 * Ground truth comes from the ingest database, where such records are already
 * stored with their raw Alert-C block:
 *
 *   COPY (
 *     select
 *       o.source,
 *       (jsonb_path_query_first(o.attributes->'sourceRaw', '$.**.alertCLocationTableVersion'))#>>'{}' as ver,
 *       (jsonb_path_query_first(o.attributes->'sourceRaw', '$.**.alertCMethod4PrimaryPointLocation.alertCLocation.specificLocation'))#>>'{}'   as prim,
 *       (jsonb_path_query_first(o.attributes->'sourceRaw', '$.**.alertCMethod4SecondaryPointLocation.alertCLocation.specificLocation'))#>>'{}' as sec,
 *       ST_AsGeoJSON(o.geom, 6) as gj
 *     from conditions.observations o
 *     where o.source like 'de-%' and o.attributes->>'sourceRaw' like '%alertC%'
 *   ) TO STDOUT WITH CSV HEADER;
 *
 *   pnpm tsx scripts/validate-tmc-table.ts ground-truth.csv
 */

import { readFileSync } from "node:fs";
import { resolveAlertC, tmcTables } from "../packages/roads/src/tmc/index.js";

interface Row {
  source: string;
  ver: string;
  prim: string;
  sec: string;
  gj: string;
}

/** Minimal CSV reader: quoted fields, embedded commas and doubled quotes. */
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])) as unknown as Row);
}

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = ((b[1] - a[1]) * Math.PI) / 180;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Distance from a point to a segment, good enough at city scale. */
function toSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return haversine(p, a);
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * k * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))
  );
  return haversine(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

function vertices(geom: { coordinates?: unknown }): [number, number][] {
  const out: [number, number][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") out.push([c[0], c[1]]);
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return out;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
}

function main() {
  const path = process.argv[2];
  if (!path) throw new Error("usage: validate-tmc-table.ts <ground-truth.csv>");

  const rows = parseCsv(readFileSync(path, "utf8"));
  const tables = tmcTables();
  const errors: number[] = [];
  const reasons = new Map<string, number>();
  const seen = new Set<string>();

  for (const r of rows) {
    const key = `${r.source}|${r.prim}|${r.sec}|${r.gj.slice(0, 120)}`;
    if (seen.has(key) || !r.gj) continue;
    seen.add(key);

    const resolution = resolveAlertC(
      {
        country: "D",
        table: "1",
        version: r.ver,
        primary: Number(r.prim) || undefined,
        secondary: Number(r.sec) || undefined,
      },
      tables
    );
    if (!resolution.ok) {
      reasons.set(resolution.reason, (reasons.get(resolution.reason) ?? 0) + 1);
      continue;
    }

    const truth = vertices(JSON.parse(r.gj) as { coordinates?: unknown });
    if (truth.length === 0) continue;
    const line =
      resolution.geometry.type === "LineString"
        ? (resolution.geometry.coordinates as [number, number][])
        : [resolution.geometry.coordinates as [number, number]];

    // Median over the record's own vertices: how far the real extent sits from
    // where the table places it.
    const d = truth
      .map((p) =>
        line.length === 1
          ? haversine(p, line[0]!)
          : Math.min(...line.slice(1).map((_, i) => toSegment(p, line[i]!, line[i + 1]!)))
      )
      .sort((x, y) => x - y);
    errors.push(quantile(d, 0.5));
  }

  errors.sort((a, b) => a - b);
  const total = errors.length + [...reasons.values()].reduce((a, b) => a + b, 0);
  console.log(`ground-truth records : ${total}`);
  console.log(
    `resolved             : ${errors.length} (${((errors.length / total) * 100).toFixed(1)}%)`
  );
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  unresolved ${reason.padEnd(17)} ${n}`);
  }
  if (errors.length === 0) return;
  console.log(
    `\nplacement error      : median=${quantile(errors, 0.5).toFixed(0)}m ` +
      `p90=${quantile(errors, 0.9).toFixed(0)}m p99=${quantile(errors, 0.99).toFixed(0)}m`
  );
  for (const t of [100, 250, 500, 1000, 2000]) {
    const share = (errors.filter((e) => e < t).length / errors.length) * 100;
    console.log(`  within ${String(t).padStart(5)}m: ${share.toFixed(1)}%`);
  }
}

main();
