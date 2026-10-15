/** Regenerate only the reviewed active VILD release; never download "latest".
 * pnpm exec tsx scripts/gen-vild-table.ts [--archive /path/to/VILD6.13.A.zip]
 * Optional --out writes a candidate elsewhere for byte-for-byte verification. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildVildSnapshot,
  VILD_SOURCE,
  verifyVildArchive,
} from "../packages/roads/src/tmc/vild-import.js";

async function main() {
  const { values } = parseArgs({
    options: { archive: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  let archive: Buffer;
  if (values.archive) archive = readFileSync(values.archive);
  else {
    const response = await fetch(VILD_SOURCE.url);
    if (!response.ok) throw new Error(`VILD download failed: HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  verifyVildArchive(archive);
  const dir = mkdtempSync(join(tmpdir(), "oc-vild-import-"));
  try {
    const zip = join(dir, "source.zip");
    writeFileSync(zip, archive);
    execFileSync("unzip", ["-q", zip, "-d", dir]);
    const snapshot = buildVildSnapshot({
      mainDbf: readFileSync(join(dir, "VILD6.13.A.dbf")),
      pointDbf: readFileSync(join(dir, "WGS84/vild_point.dbf")),
      pointShp: readFileSync(join(dir, "WGS84/vild_point.shp")),
      projection: readFileSync(join(dir, "WGS84/vild_point.prj"), "utf8"),
    });
    if (snapshot.points.length !== 9844)
      throw new Error(`VILD point count changed: ${snapshot.points.length}`);
    const out = resolve(values.out ?? "packages/roads/src/tmc/snapshots/vild-nl-6.13.A.json");
    writeFileSync(out, `${JSON.stringify(snapshot)}\n`);
    console.log(`wrote ${snapshot.points.length} points from VILD ${snapshot.edition} to ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
