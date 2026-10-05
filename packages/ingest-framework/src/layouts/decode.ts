import type { LayoutBlock } from "./block.js";
import { decodeCsv } from "./csv.js";
import { decodeGeoJson } from "./geojson.js";
import { decodeJson } from "./json.js";
import type { LayoutRow } from "./row.js";

/**
 * Decode a payload into rows. A row with no placeable point carries none; the
 * domain decides whether to skip it.
 */
export function decodeLayout(
  kind: "geojson" | "json" | "csv",
  payload: Buffer,
  block: LayoutBlock,
): LayoutRow[] {
  if (kind === "csv") return decodeCsv(payload, block);
  const text = payload.toString("utf8");
  return kind === "geojson" ? decodeGeoJson(text, block) : decodeJson(text, block);
}
