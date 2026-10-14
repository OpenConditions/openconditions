/**
 * Regenerate the vendored outlines of Croatia's counties, which MeteoAlarm's
 * Croatian warnings name by NUTS 2021 level-3 code and which neither of
 * MeteoAlarm's own geocode files resolves. The outlines are the State
 * Geodetic Administration's (Državna geodetska uprava, DGU) "Upravne
 * jedinice INSPIRE" dataset, published under the Croatian Open Licence
 * (https://data.gov.hr/otvorena-dozvola), which permits commercial reuse with
 * a source statement, the dataset's date and link, and changes marked. Run it
 * when DGU redraws a county boundary; the outlines are simplified to about
 * 100 m, so ordinary cadastral corrections do not need a new snapshot.
 *
 *   pnpm tsx scripts/gen-hr-county-shapes.ts             # download, extract, write
 *   pnpm tsx scripts/gen-hr-county-shapes.ts --from GML  # use an extracted AdministrativeUnit.gml
 *
 * The zip is about 210 MB and its GML about 600 MB, so the GML is streamed.
 * Extraction shells out to `unzip`, as the TMC table script does.
 */

import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  HR_NUTS3,
  type HrCounty,
  type HrCountySnapshot,
} from "../packages/hazards/src/formats/hr-counties.js";
import { simplifyGeometry } from "../packages/hazards/src/geometry.js";
import { reprojectorFor } from "../packages/ingest-framework/src/reproject.js";

// The GeoJSON types by way of the snapshot's, which the scripts cannot import directly.
type Outline = HrCounty["geometry"];
type Position = number[];

const SOURCE = "https://geoportal.dgu.hr/services/atom/INSPIRE_Administrative_Units_(AU).zip";
const DATASET = "https://geoportal.dgu.hr/services/atom/au/xml";
const LICENSE_URL = "https://data.gov.hr/otvorena-dozvola";
const OUT = "packages/hazards/src/formats/snapshots/hr-counties.json";
/** About 100 m at Croatia's latitude; the warnings are drawn coarser still. */
const TOLERANCE_DEG = 0.001;
/** Four decimals are about 10 m, well inside the tolerance. */
const round = (v: number) => Math.round(v * 1e4) / 1e4;

const fromLaea = reprojectorFor("EPSG:3035")!;

/**
 * A GML `posList` in EPSG:3035 as WGS84 positions. INSPIRE writes that CRS
 * in its EPSG axis order, northing before easting.
 */
function ring(posList: string): Position[] {
  const values = posList.trim().split(/\s+/).map(Number);
  const out: Position[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    out.push(fromLaea([values[i + 1]!, values[i]!]));
  }
  return out;
}

/** The polygons of one `au:AdministrativeUnit`'s `gml:MultiSurface`. */
function polygons(member: string): Position[][][] {
  return member
    .split("<gml:Polygon")
    .slice(1)
    .map((polygon) => {
      const lists = [
        ...polygon.matchAll(/<gml:(exterior|interior)>[\s\S]*?<gml:posList[^>]*>([^<]*)</g),
      ];
      const outer = lists.filter((m) => m[1] === "exterior").map((m) => ring(m[2]!));
      const holes = lists.filter((m) => m[1] === "interior").map((m) => ring(m[2]!));
      if (outer.length !== 1) throw new Error("a polygon without exactly one exterior ring");
      return [outer[0]!, ...holes];
    });
}

function rounded(geometry: Outline): Outline {
  const rings = (rs: Position[][]) => rs.map((r) => r.map(([x, y]) => [round(x!), round(y!)]));
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: rings(geometry.coordinates) }
    : { type: "MultiPolygon", coordinates: geometry.coordinates.map(rings) };
}

/** The 2nd-order units (the counties) of DGU's GML, and the dataset's build time. */
async function readCounties(gml: string): Promise<{ counties: HrCounty[]; timeStamp: string }> {
  const byName = new Map(Object.entries(HR_NUTS3).map(([code, name]) => [name, code]));
  const counties: HrCounty[] = [];
  let timeStamp: string | undefined;
  let buffer = "";
  for await (const chunk of createReadStream(gml, { encoding: "utf8", highWaterMark: 1 << 22 })) {
    buffer += chunk;
    timeStamp ??= /<wfs:FeatureCollection[^>]*\btimeStamp="([^"]+)"/.exec(buffer)?.[1];
    let end = buffer.indexOf("</wfs:member>");
    while (end !== -1) {
      const member = buffer.slice(0, end);
      buffer = buffer.slice(end + "</wfs:member>".length);
      end = buffer.indexOf("</wfs:member>");
      if (!member.includes("AdministrativeHierarchyLevel/2ndOrder")) continue;
      const name = /<gn:text>([^<]*)<\/gn:text>/.exec(member)?.[1];
      const nuts3 = name === undefined ? undefined : byName.get(name);
      if (nuts3 === undefined) throw new Error(`a county no NUTS3 region is named for: ${name}`);
      const parts = polygons(member);
      const shape: Outline =
        parts.length === 1
          ? { type: "Polygon", coordinates: parts[0]! }
          : { type: "MultiPolygon", coordinates: parts };
      const simplified = simplifyGeometry(shape, TOLERANCE_DEG);
      if (simplified?.type !== "Polygon" && simplified?.type !== "MultiPolygon") {
        throw new Error(`${name} collapses at ${TOLERANCE_DEG}°`);
      }
      counties.push({ nuts3, name: name!, geometry: rounded(simplified) });
    }
  }
  if (timeStamp === undefined) throw new Error("the GML states no timeStamp");
  return { counties, timeStamp };
}

async function main() {
  const fromIndex = process.argv.indexOf("--from");
  let gml: string;
  if (fromIndex !== -1 && process.argv[fromIndex + 1]) {
    gml = path.resolve(process.argv[fromIndex + 1]!);
  } else {
    const work = mkdtempSync(path.join(tmpdir(), "hr-au-"));
    const zip = path.join(work, "au.zip");
    console.log(`downloading ${SOURCE}`);
    const res = await fetch(SOURCE, { headers: { "User-Agent": "OpenConditions" } });
    if (!res.ok || res.body === null) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      createWriteStream(zip),
    );
    execFileSync("unzip", ["-q", "-o", zip, "-d", work]);
    gml = path.join(work, "AdministrativeUnit.gml");
  }

  const { counties, timeStamp } = await readCounties(gml);
  const missing = Object.keys(HR_NUTS3).filter((code) => !counties.some((c) => c.nuts3 === code));
  if (missing.length > 0 || counties.length !== Object.keys(HR_NUTS3).length) {
    throw new Error(`expected each NUTS3 region once; missing ${missing.join(", ") || "none"}`);
  }
  counties.sort((a, b) => a.nuts3.localeCompare(b.nuts3));
  const datasetDate = timeStamp.slice(0, 10);
  const snapshot: HrCountySnapshot = {
    source: SOURCE,
    dataset: DATASET,
    publisher: "Državna geodetska uprava",
    license: "LicenseRef-OD-HR",
    licenseUrl: LICENSE_URL,
    attribution: `Contains information of the State Geodetic Administration of the Republic of Croatia (Državna geodetska uprava) under the Open Licence: Upravne jedinice INSPIRE, ${datasetDate}, ${DATASET}; county boundaries simplified`,
    datasetUpdatedAt: new Date(timeStamp).toISOString(),
    retrievedAt: new Date().toISOString(),
    toleranceDeg: TOLERANCE_DEG,
    counties,
  };
  // One county per line, so a redrawn boundary reads as a diff of that county.
  const body = counties.map((c) => `    ${JSON.stringify(c)}`).join(",\n");
  const { counties: _counties, ...head } = snapshot;
  const header = JSON.stringify(head, null, 2).slice(0, -2);
  writeFileSync(OUT, `${header},\n  "counties": [\n${body}\n  ]\n}\n`);
  console.log(`wrote ${counties.length} counties → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
