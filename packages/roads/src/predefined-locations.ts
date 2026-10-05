/**
 * Streaming parser for a DATEX II PredefinedLocationsPublication — the static
 * geometry registry the Autobahn GmbH BAB ElaboratedData feeds join against by
 * `predefinedLocationReference` id. Distinct from the NDW MeasurementSiteTable
 * parser in siteTable.ts: the record element is `predefinedLocation` (id attr),
 * and coordinates live in `pointCoordinates` (latitude/longitude children),
 * either directly (Point) or inside `linearByCoordinates` start/intermediate/end
 * points (LineString). Coordinates are WGS84 lat/lon (VRZ doc §4.3.1.2), emitted
 * as GeoJSON [lon, lat]. A location that stands for one lane (the NRW
 * fahrstreifen feeds) names it in `affectedCarriagewayAndLanes`.
 */
import { flattenString, stripXmlNamespace } from "@openconditions/datex2";
import type { LineString, Point } from "geojson";
import { SaxesParser } from "saxes";
import type { FlowSite, FlowSites } from "./flow-output.js";
import { datexLaneNumber } from "./flow-reading.js";
import type { SiteTableParser } from "./siteTable.js";

type SiteGeometry = Point | LineString;

interface RecordState {
  id?: string;
  lanes: number[];
  name?: string;
  nameLang?: string;
  points: [number, number][]; // ordered [lon, lat]; length 1 => Point, >=2 => LineString
  isLinear: boolean;
  curLat?: number;
  curLon?: number;
}

function freshRecord(id: string | undefined): RecordState {
  return { ...(id != null ? { id } : {}), points: [], isLinear: false, lanes: [] };
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
  const map = new Map<string, FlowSite>();
  const stack: string[] = [];
  let record: RecordState | null = null;
  let textTarget: "latitude" | "longitude" | "lane" | "name" | null = null;
  let nameLang: string | undefined;
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
    stack.push(local);

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
    } else if (local === "lane" && stack.includes("affectedCarriagewayAndLanes")) {
      textTarget = "lane";
      textBuffer = "";
    } else if (local === "value" && stack.includes("predefinedLocationName")) {
      nameLang = (tag.attributes as Record<string, string>)["lang"];
      textTarget = "name";
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
    stack.pop();
    if (local === "lane" && textTarget === "lane" && record != null) {
      const lane = datexLaneNumber(textBuffer);
      if (lane !== undefined) record.lanes.push(lane);
      textTarget = null;
    }
    if (local === "value" && textTarget === "name" && record != null) {
      const name = textBuffer.trim();
      if (name !== "" && record.name === undefined) {
        record.name = flattenString(name);
        if (nameLang !== undefined) record.nameLang = flattenString(nameLang);
      }
      textTarget = null;
    }
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
      const geometry = geometryForRecord(record);
      if (record.id != null && geometry != null) {
        map.set(record.id, {
          geometry,
          // A location of exactly one lane is a lane-level site.
          ...(record.lanes.length === 1 ? { lane: record.lanes[0]! } : {}),
          ...(record.name !== undefined ? { name: record.name } : {}),
          ...(record.nameLang !== undefined ? { nameLang: record.nameLang } : {}),
        });
      }
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
    close(): FlowSites {
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

export function parsePredefinedLocations(input: string | Buffer): FlowSites {
  const str = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const parser = createPredefinedLocationsParser();
  parser.write(str);
  return parser.close();
}
