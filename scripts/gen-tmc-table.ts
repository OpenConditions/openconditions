/**
 * Regenerate the vendored TMC location table from the authority's published
 * exchange-format files.
 *
 * Germany's LCL 22.0 is the final edition — BASt ended maintenance in 2022 — so
 * this is expected to run approximately never. It exists so the vendored
 * snapshot is reproducible from its source rather than being an artefact nobody
 * can regenerate.
 *
 *   pnpm tsx scripts/gen-tmc-table.ts             # download, extract, write
 *   pnpm tsx scripts/gen-tmc-table.ts --from DIR  # use an extracted DAT dir
 *
 * Extraction shells out to `unzip`; this is a maintainer script, not runtime
 * code, so a system tool is an acceptable dependency.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTmcTable, toSnapshot } from "../packages/roads/src/tmc/lcl.js";

const SOURCE = {
  url: "https://www.bast.de/DE/Themen/Digitales/HF_1/Massnahmen/LCL/lcl-download.zip?__blob=publicationFile&v=2",
  attribution: "Location Code List 22.0 — Bundesanstalt für Straßenwesen (BASt)",
  license: "CC-BY-4.0",
  out: "packages/roads/src/tmc/snapshots/lcl-de.json",
};

/** Locate the directory holding the `*.DAT` files, wherever the zip nested it. */
function findDatDir(root: string): string {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = readdirSync(dir);
    if (entries.some((e) => e.toUpperCase() === "POINTS.DAT")) return dir;
    for (const e of entries) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) stack.push(full);
    }
  }
  throw new Error(`no POINTS.DAT found under ${root}`);
}

function read(dir: string, name: string): string {
  const actual = readdirSync(dir).find((e) => e.toUpperCase() === name);
  if (!actual) throw new Error(`${name} missing from ${dir}`);
  return readFileSync(path.join(dir, actual), "utf8");
}

async function main() {
  const fromIndex = process.argv.indexOf("--from");
  let datDir: string;

  if (fromIndex !== -1 && process.argv[fromIndex + 1]) {
    datDir = findDatDir(path.resolve(process.argv[fromIndex + 1]!));
  } else {
    const work = mkdtempSync(path.join(tmpdir(), "lcl-"));
    console.log(`downloading ${SOURCE.url}`);
    const res = await fetch(SOURCE.url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const zip = path.join(work, "lcl.zip");
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    execFileSync("unzip", ["-q", "-o", zip, "-d", work]);
    datDir = findDatDir(work);
  }

  console.log(`reading exchange files from ${datDir}`);
  const table = buildTmcTable(
    {
      points: read(datDir, "POINTS.DAT"),
      poffsets: read(datDir, "POFFSETS.DAT"),
      locationDatasets: read(datDir, "LOCATIONDATASETS.DAT"),
      countries: read(datDir, "COUNTRIES.DAT"),
      roads: read(datDir, "ROADS.DAT"),
      segments: read(datDir, "SEGMENTS.DAT"),
    },
    { attribution: SOURCE.attribution, license: SOURCE.license }
  );

  const snapshot = toSnapshot(table);
  const out = path.resolve(SOURCE.out);
  writeFileSync(out, `${JSON.stringify(snapshot)}\n`);
  console.log(
    `wrote ${out}\n  cid=${snapshot.cid} tabcd=${snapshot.tabcd} version=${snapshot.version} ` +
      `ccd=${snapshot.ccd ?? "-"}\n  ${snapshot.points.length} coded points`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
