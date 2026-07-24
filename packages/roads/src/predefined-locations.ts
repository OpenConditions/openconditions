/**
 * Streaming parser for a DATEX II PredefinedLocationsPublication — the static
 * geometry registry the Autobahn GmbH BAB ElaboratedData feeds join against by
 * `predefinedLocationReference` id. Distinct from the NDW MeasurementSiteTable
 * parser in siteTable.ts: the record element is `predefinedLocation` (id attr),
 * and coordinates live in `pointCoordinates` (latitude/longitude children),
 * either directly (Point) or inside `linearByCoordinates` start/intermediate/end
 * points (LineString). Coordinates are WGS84 lat/lon (VRZ doc §4.3.1.2), emitted
 * as GeoJSON [lon, lat].
 */
import { SaxesParser } from "saxes";
import type { SiteGeometry, SiteTableParser } from "./siteTable.js";
import { flattenString, stripXmlNamespace } from "./xml.js";

interface RecordState {
  id?: string;
  points: [number, number][]; // ordered [lon, lat]; length 1 => Point, >=2 => LineString
  isLinear: boolean;
  curLat?: number;
  curLon?: number;
}

function freshRecord(id: string | undefined): RecordState {
  return { ...(id != null ? { id } : {}), points: [], isLinear: false };
}

function geometryForRecord(r: RecordState): SiteGeometry | null {
  if (r.isLinear && r.points.length >= 2) {
    return { type: "LineString", coordinates: r.points };
  }
  if (r.points.length >= 1) {
    const [lon, lat] = r.points[0]!;
    return { type: "Point", coordinates: [lon, lat] };
  }
  return null;
}

export function createPredefinedLocationsParser(): SiteTableParser {
  const map = new Map<string, SiteGeometry>();
  let record: RecordState | null = null;
  let textTarget: "latitude" | "longitude" | null = null;
  let textBuffer = "";
  let failed = false;

  const parser = new SaxesParser({ position: false });
  parser.on("doctype", () => {
    throw new Error("XML DOCTYPE/entity declarations are not allowed");
  });
  parser.on("error", () => {
    failed = true;
  });

  const flushCoordinatePair = (): void => {
    if (record == null) return;
    if (Number.isFinite(record.curLat) && Number.isFinite(record.curLon)) {
      record.points.push([record.curLon!, record.curLat!]);
    }
    record.curLat = undefined;
    record.curLon = undefined;
  };

  parser.on("opentag", (tag) => {
    const local = stripXmlNamespace(tag.name);

    if (local === "predefinedLocation") {
      const id = (tag.attributes as Record<string, string>)["id"];
      record = freshRecord(id != null ? flattenString(id) : undefined);
      return;
    }
    if (record == null) return;
    if (local === "linearByCoordinates") record.isLinear = true;
    else if (local === "latitude") {
      textTarget = "latitude";
      textBuffer = "";
    } else if (local === "longitude") {
      textTarget = "longitude";
      textBuffer = "";
    }
  });

  parser.on("text", (t) => {
    if (textTarget != null) textBuffer += t;
  });
  parser.on("cdata", (t) => {
    if (textTarget != null) textBuffer += t;
  });

  parser.on("closetag", (tag) => {
    const local = stripXmlNamespace(tag.name);
    if ((local === "latitude" || local === "longitude") && record != null) {
      const value = textBuffer.trim() !== "" ? Number(textBuffer) : NaN;
      if (Number.isFinite(value)) {
        if (textTarget === "latitude") record.curLat = value;
        else record.curLon = value;
      }
      textTarget = null;
      textBuffer = "";
    }
    if (local === "pointCoordinates") flushCoordinatePair();
    if (local === "predefinedLocation" && record != null) {
      const geom = geometryForRecord(record);
      if (record.id != null && geom != null) map.set(record.id, geom);
      record = null;
      textTarget = null;
      textBuffer = "";
    }
  });

  return {
    write(chunk: string): void {
      if (failed) return;
      try {
        parser.write(chunk);
      } catch {
        failed = true;
      }
    },
    close(): Map<string, SiteGeometry> {
      if (!failed) {
        try {
          parser.close();
        } catch {
          failed = true;
        }
      }
      return map;
    },
  };
}

export function parsePredefinedLocations(input: string | Buffer): Map<string, SiteGeometry> {
  const str = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const parser = createPredefinedLocationsParser();
  parser.write(str);
  return parser.close();
}
