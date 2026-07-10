import type { SiteGeometry } from "./siteTable.js";
import { reprojectorFor } from "./reproject.js";

/**
 * Build a `code_pme → LineString` map from the French national road counting-
 * station reference CSV (transport.data.gouv.fr "Référentiel des stations de
 * comptage"). The CSV is semicolon-delimited; each station's start/end
 * coordinates (`x_deb`/`y_deb`/`x_fin`/`y_fin`) are in RGF93 / Lambert-93
 * (EPSG:2154) and are reprojected to WGS84. The `code_pme` id joins to the
 * MeasuredData feed's `measurementSiteReference id`. Rows missing an id or a
 * finite coordinate pair are skipped.
 */
export function parseFranceComptageStations(input: string | Buffer): Map<string, SiteGeometry> {
  const map = new Map<string, SiteGeometry>();
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return map;

  const header = lines[0]!.split(";").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iId = col("code_pme");
  const iXd = col("x_deb");
  const iYd = col("y_deb");
  const iXf = col("x_fin");
  const iYf = col("y_fin");
  if (iId < 0 || iXd < 0 || iYd < 0 || iXf < 0 || iYf < 0) return map;

  const toWgs = reprojectorFor("EPSG:2154");
  if (!toWgs) return map;

  const num = (raw: string | undefined): number | undefined => {
    if (raw == null || raw.trim() === "") return undefined;
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  };

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i]!;
    if (row.trim() === "") continue;
    const cells = row.split(";");
    const id = cells[iId]?.trim();
    if (!id) continue;
    const xd = num(cells[iXd]);
    const yd = num(cells[iYd]);
    const xf = num(cells[iXf]);
    const yf = num(cells[iYf]);
    if (xd == null || yd == null || xf == null || yf == null) continue;

    const [lonD, latD] = toWgs([xd, yd]);
    const [lonF, latF] = toWgs([xf, yf]);
    if (![lonD, latD, lonF, latF].every(Number.isFinite)) continue;

    map.set(id, {
      type: "LineString",
      coordinates: [
        [lonD, latD],
        [lonF, latF],
      ],
    });
  }
  return map;
}
