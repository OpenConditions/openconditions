import type {
  FeedPayloads,
  ParseContext,
  ParseOutput,
  RecordSkipReason,
} from "@openconditions/ingest-framework";
import type { Geometry } from "geojson";
import { capOutput } from "../cap/accounting.js";
import type { DerivedShape } from "../cap/situations.js";
import type { CapAlert, CapArea } from "../cap/types.js";
import { CapReadError, readCapXml } from "../cap/xml.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { DERIVED_SHAPE_TOLERANCE_DEG, derivedShape, unionPolygons } from "../geometry.js";
import { isRecord } from "../records.js";

/**
 * DWD's lake groups (`LAKE-SUM` cells in the CAP-DWD profile, section 3.6.1),
 * which the lake layer gives no shape, by their member lake cells. The
 * membership is DWD's own split of the Bavarian lake warnings into Franken
 * and Südbayern
 * (https://www.dwd.de/DE/wetter/warnungen_aktuell/kriterien/seewarnungen.html),
 * matched to the cells of the warn-cell list
 * (https://www.dwd.de/DE/leistungen/opendata/help/warnungen/cap_warncellids_csv.html).
 */
const LAKE_GROUPS: ReadonlyMap<string, readonly string[]> = new Map([
  // Nordbayrische Seen: Altmühlsee/Brombachsee/Igelsbachsee, Rothsee.
  ["209000001", ["209901000", "209902000"]],
  // Südbayrische Seen: Forggensee to Waginger/Tachinger See (no 209907000).
  [
    "209000002",
    [
      "209903000",
      "209904000",
      "209905000",
      "209906000",
      "209908000",
      "209909000",
      "209910000",
      "209911000",
      "209912000",
      "209913000",
      "209914000",
    ],
  ],
]);

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
 * the `areas` role gives its `WARNCELLID` codes (derived, simplified once). A
 * lake group the layers give no shape stands for its members; a member they
 * lack adds nothing. Undefined without the role, so a feed without it pays
 * nothing.
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
  const cellsOf = (id: string): readonly string[] =>
    cells.has(id) ? [id] : (LAKE_GROUPS.get(id) ?? [id]);
  return (area) => {
    const ids = new Set(
      (Array.isArray(area.geocode) ? area.geocode : []).flatMap((g: unknown) =>
        isRecord(g) && g["valueName"] === "WARNCELLID" && typeof g["value"] === "string"
          ? cellsOf(g["value"].trim())
          : [],
      ),
    );
    const geometry = unionPolygons([...ids].flatMap((id) => shapeOf(id) ?? []));
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
 * its own takes the shapes of its `WARNCELLID` codes (of a Bavarian lake
 * group, its member lakes').
 *
 * Each payload is one record: one that is no CAP message is skipped as
 * `malformed`, a message of an earlier CAP version as `unsupported_version`,
 * and the others publish. Only when every payload fails is the answer the
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
  const undecoded: Partial<Record<RecordSkipReason, number>> = {};
  let firstError: unknown;
  for (const body of bodies) {
    try {
      alerts.push(readCapXml(body));
    } catch (error) {
      firstError ??= error;
      const reason = error instanceof CapReadError ? error.reason : "malformed";
      undecoded[reason] = (undecoded[reason] ?? 0) + 1;
    }
  }
  if (bodies.length > 0 && alerts.length === 0) throw firstError;
  const geometryOf = warnCellGeometry(payloads["areas"]);
  return capOutput(alerts, feed, {
    fetchedAt: ctx.fetchedAt,
    undecoded,
    ...(geometryOf ? { geometryOf } : {}),
  });
}
