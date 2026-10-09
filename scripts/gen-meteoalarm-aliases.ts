/**
 * Regenerate the vendored MeteoAlarm alias table from the "Geocodes Aliases"
 * CSV that MeteoAlarm's Redistribution Hub links
 * (https://meteoalarm.org/en/live/page/redistribution-hub). Run it when the
 * Hub's change log lists a new file; the Hub link points at the latest
 * revision of one Google Drive file.
 *
 *   pnpm tsx scripts/gen-meteoalarm-aliases.ts               # download and write
 *   pnpm tsx scripts/gen-meteoalarm-aliases.ts --from FILE   # use a saved CSV
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  type MeteoAlarmAliasSnapshot,
  readMeteoAlarmAliasCsv,
} from "../packages/hazards/src/formats/meteoalarm-aliases.js";

const SOURCE =
  "https://drive.usercontent.google.com/download?id=1haP3_PFz9nYrEgLjCd_YvaCuMb9_5QC1&export=download";
const OUT = "packages/hazards/src/formats/snapshots/meteoalarm-aliases.json";

async function main() {
  const fromIndex = process.argv.indexOf("--from");
  let text: string;
  let lastModified: string | null = null;
  if (fromIndex !== -1 && process.argv[fromIndex + 1]) {
    text = readFileSync(process.argv[fromIndex + 1]!, "utf8");
  } else {
    console.log(`downloading ${SOURCE}`);
    const res = await fetch(SOURCE, { headers: { "User-Agent": "OpenConditions" } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const modified = res.headers.get("last-modified");
    lastModified = modified === null ? null : new Date(modified).toISOString();
    text = await res.text();
  }
  const rows = readMeteoAlarmAliasCsv(text);
  if (rows.length === 0) throw new Error("the file holds no alias rows");
  const snapshot: MeteoAlarmAliasSnapshot = {
    source: SOURCE,
    lastModified,
    retrievedAt: new Date().toISOString(),
    rows,
  };
  // One row per line, so a new revision reads as a diff of the rows it changed.
  const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  const { rows: _rows, ...head } = snapshot;
  const header = JSON.stringify(head, null, 2).slice(0, -2);
  writeFileSync(OUT, `${header},\n  "rows": [\n${body}\n  ]\n}\n`);
  console.log(`wrote ${rows.length} rows → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
