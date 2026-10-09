import type { FeedPayloads, ParseContext, ParseOutput } from "@openconditions/ingest-framework";
import type { Geometry } from "geojson";
import { capOutput } from "../cap/accounting.js";
import type { DerivedShape } from "../cap/situations.js";
import type { CapAlert, CapArea } from "../cap/types.js";
import { readCapXml } from "../cap/xml.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { DERIVED_SHAPE_TOLERANCE_DEG, derivedShape, unionPolygons } from "../geometry.js";
import { isRecord } from "../records.js";

/**
 * The raw shape of each warn cell in the `areas` role's GeoJSON layers (DWD's
 * coast and lake warning areas), by `WARNCELLID`. A layer that does not read
 * adds none.
 */
function warnCellShapes(bodies: readonly Buffer[]): Map<string, unknown> {
  const cells = new Map<string, unknown>();
  for (const body of bodies) {
    try {
      const root: unknown = JSON.parse(body.toString("utf8"));
      const features = isRecord(root) ? root["features"] : undefined;
      if (!Array.isArray(features)) continue;
      for (const f of features) {
        const properties = isRecord(f) ? f["properties"] : undefined;
        const id = isRecord(properties) ? properties["WARNCELLID"] : undefined;
        const key = typeof id === "number" || typeof id === "string" ? String(id).trim() : "";
        if (key !== "" && !cells.has(key) && isRecord(f)) cells.set(key, f["geometry"]);
      }
    } catch {
      // A layer that does not read leaves the areas with their codes.
    }
  }
  return cells;
}

/**
 * The shape of an area CAP names only by warn cell: the union of the shapes
 * the `areas` role gives its `WARNCELLID` codes (derived, simplified once).
 * Undefined without the role, so a feed without it pays nothing.
 */
function warnCellGeometry(
  bodies: readonly Buffer[] | undefined,
): ((area: CapArea) => DerivedShape | undefined) | undefined {
  if (bodies === undefined || bodies.length === 0) return undefined;
  const cells = warnCellShapes(bodies);
  const shapes = new Map<string, Geometry | null>();
  const shapeOf = (id: string): Geometry | null => {
    const known = shapes.get(id);
    if (known !== undefined) return known;
    const shape = derivedShape(cells.get(id), DERIVED_SHAPE_TOLERANCE_DEG);
    shapes.set(id, shape);
    return shape;
  };
  return (area) => {
    const found = (Array.isArray(area.geocode) ? area.geocode : []).flatMap((g: unknown) =>
      isRecord(g) && g["valueName"] === "WARNCELLID" && typeof g["value"] === "string"
        ? (shapeOf(g["value"].trim()) ?? [])
        : [],
    );
    const geometry = unionPolygons(found);
    return geometry === null ? undefined : { geometry, origin: "derived" };
  };
}

/**
 * CAP 1.2 XML, one message per payload of the `alerts` role: the entries of
 * a status zip (DWD) or the files a directory walk holds (the ECCC
 * Datamart). Every message the role holds is one parse, so a message updated
 * or cancelled by another is dropped. The `index` role is the listing a walk
 * reads, never parsed itself. The optional `areas` role is GeoJSON layers of
 * warn-cell shapes (DWD's coast and lake areas): an area with no polygon of
 * its own takes the shapes of its `WARNCELLID` codes.
 *
 * Each payload is one record: one that is no CAP message is rejected and the
 * others publish. Only when every payload fails is the answer the
 * publisher's error rather than a bad record, and the parse fails, so the
 * last good publication stands.
 */
export function parseCap(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const bodies = payloads["alerts"] ?? [];
  const alerts: CapAlert[] = [];
  let firstError: unknown;
  for (const body of bodies) {
    try {
      alerts.push(readCapXml(body));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (bodies.length > 0 && alerts.length === 0) throw firstError;
  const geometryOf = warnCellGeometry(payloads["areas"]);
  return capOutput(alerts, feed, {
    fetchedAt: ctx.fetchedAt,
    unreadable: bodies.length - alerts.length,
    ...(geometryOf ? { geometryOf } : {}),
  });
}
