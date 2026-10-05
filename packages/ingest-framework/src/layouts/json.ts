import type { LayoutBlock } from "./block.js";
import { geometryPoint, hasShape, reprojectGeometry } from "./geojson.js";
import { getPath, type LayoutRow, pointFromFields } from "./row.js";

/**
 * The rows of a JSON document: the array at `records` (the root by default),
 * each element a record. A point comes from the `point` field, `lon`/`lat`, or
 * a GeoJSON geometry at `geometryPath`.
 */
export function decodeJson(text: string, block: LayoutBlock): LayoutRow[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const list = block.records ? getPath(doc, block.records) : doc;
  if (!Array.isArray(list)) return [];
  const rows: LayoutRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const fields = item as Record<string, unknown>;
    let point = pointFromFields(fields, block);
    if (!point && block.geometryPath) {
      const geometry = getPath(fields, block.geometryPath);
      if (hasShape(geometry))
        point = geometryPoint(reprojectGeometry(geometry, undefined, block.crs));
    }
    rows.push(point ? { point, fields } : { fields });
  }
  return rows;
}
