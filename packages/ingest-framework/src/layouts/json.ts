import type { RecordSkipReason } from "../skips.js";
import type { LayoutBlock } from "./block.js";
import { geometryPoint, hasShape, pointIsComputed, reprojectGeometry } from "./geojson.js";
import { getPath, type LayoutRow, layoutRow, namesPosition, pointFromFields } from "./row.js";

/**
 * The rows of a JSON document: the array at `records` (the root by default),
 * each element a record. A point comes from the `point` field, `lon`/`lat`, or
 * a GeoJSON geometry at `geometryPath`. An element that is not an object is
 * no record: it is left out and reported to `onSkip` as malformed.
 */
export function decodeJson(
  text: string,
  block: LayoutBlock,
  onSkip?: (reason: RecordSkipReason) => void,
): LayoutRow[] {
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
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      onSkip?.("malformed");
      continue;
    }
    const fields = item as Record<string, unknown>;
    const geometry = block.geometryPath ? getPath(fields, block.geometryPath) : undefined;
    let point = pointFromFields(fields, block);
    let pointDerived = false;
    if (!point && hasShape(geometry)) {
      point = geometryPoint(reprojectGeometry(geometry, undefined, block.crs));
      pointDerived = pointIsComputed(geometry);
    }
    rows.push(
      layoutRow(fields, point, namesPosition(fields, block) || hasShape(geometry), pointDerived),
    );
  }
  return rows;
}
