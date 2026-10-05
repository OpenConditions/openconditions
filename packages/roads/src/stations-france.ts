import { reprojectorFor } from "@openconditions/ingest-framework";
import type { FlowSite, FlowSites } from "./flow-output.js";

/**
 * Build the `code_pme` → LineString sites from the French national road counting-
 * station reference CSV (transport.data.gouv.fr "Référentiel des stations de
 * comptage"). The CSV is semicolon-delimited; each station's start/end
 * coordinates (`x_deb`/`y_deb`/`x_fin`/`y_fin`) are in RGF93 / Lambert-93
 * (EPSG:2154) and are reprojected to WGS84. The `code_pme` id joins to the
 * MeasuredData feed's `measurementSiteReference id`. Rows missing an id or a
 * finite coordinate pair are skipped.
 */
export function parseFranceComptageStations(input: string | Buffer): FlowSites {
  const map = new Map<string, FlowSite>();
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return map;

  // The published file is column-misaligned — the header carries 20 columns but
  // every data row carries 19 (a middle column is dropped), so header-index
  // lookups read the wrong cells. `code_pme` is reliably the first column and the
  // coordinate block (x_deb, y_deb, x_fin, y_fin, code_traficolor) is reliably
  // the trailing five, so anchor the coordinates to the row's end instead.
  if (!lines[0]!.toLowerCase().includes("code_pme")) return map;

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
    if (cells.length < 6) continue;
    const id = cells[0]?.trim();
    if (!id) continue;
    const n = cells.length;
    const xd = num(cells[n - 5]);
    const yd = num(cells[n - 4]);
    const xf = num(cells[n - 3]);
    const yf = num(cells[n - 2]);
    if (xd == null || yd == null || xf == null || yf == null) continue;

    const [lonD, latD] = toWgs([xd, yd]);
    const [lonF, latF] = toWgs([xf, yf]);
    if (![lonD, latD, lonF, latF].every(Number.isFinite)) continue;

    // `nb_voies` precedes the coordinate block; 0 means "not stated".
    const lanes = num(cells[n - 6]);
    map.set(id, {
      ...(lanes !== undefined && Number.isInteger(lanes) && lanes > 0 ? { laneCount: lanes } : {}),
      geometry: {
        type: "LineString",
        coordinates: [
          [lonD, latD],
          [lonF, latF],
        ],
      },
    });
  }
  return map;
}
