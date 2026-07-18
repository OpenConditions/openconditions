import type { Point } from "geojson";
import type { RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";
import { reprojectorFor } from "./reproject.js";
import { getXmlChild, getXmlChildren, isXmlObject, parseXmlDocument, xmlText } from "./xml.js";

type Los = RoadFlow["los"];

// INFORMO's nivelServicio: 0 fluido, 1 lento, 2 retenido, 3 congestionado.
function losFromNivel(raw: string | undefined): Los {
  switch ((raw ?? "").trim()) {
    case "0":
      return "free_flow";
    case "1":
      return "heavy";
    case "2":
      return "queuing";
    case "3":
      return "stationary";
    default:
      return "unknown";
  }
}

const QUEUING_LOS = new Set<Los>(["queuing", "stationary", "blocked"]);

/** Parse a Madrid INFORMO number, which uses a comma decimal separator. */
function numEs(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the City of Madrid INFORMO realtime traffic XML
 * (`informo.madrid.es/informo/tmadrid/pm.xml`) into RoadFlow point
 * measurements. Each `<pm>` is a measurement point carrying a
 * `nivelServicio` level-of-service, `intensidad` (veh/h) and `ocupacion`
 * (%), with UTM (ETRS89 / EPSG:25830) `st_x`/`st_y` coordinates reprojected
 * to WGS84. The feed carries no measured speed, so flows are level-of-service
 * only; a derived congestion event is appended when the LOS reaches queuing
 * or worse. Points with an error flag, no valid coordinate, or an
 * unresolvable LOS are skipped.
 */
export function parseMadridFlow(input: string | Buffer, src: SourceDescriptor): FlowParseResult {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: true,
      isArray: (n) => n === "pm",
    });
  } catch {
    return { flows: [], events: [], failed: true };
  }

  const root = isXmlObject(doc) ? (getXmlChild(doc, "pms") ?? doc) : null;
  if (!root) return { flows: [], events: [], failed: true };
  const points = getXmlChildren(root, "pm");

  const toWgs = reprojectorFor("EPSG:25830");
  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];
  const events: FlowParseResult["events"] = [];

  for (const pm of points) {
    try {
      if (xmlText(pm["error"]) === "S") continue; // sensor fault this cycle
      const id = xmlText(pm["idelem"]);
      if (!id) continue;

      const x = numEs(xmlText(pm["st_x"]));
      const y = numEs(xmlText(pm["st_y"]));
      if (x == null || y == null || !toWgs) continue;
      const [lon, lat] = toWgs([x, y]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

      const los = losFromNivel(xmlText(pm["nivelServicio"]));
      if (los === "unknown") continue;

      const geometry: Point = { type: "Point", coordinates: [lon, lat] };

      const flow: RoadFlow = {
        id: `${src.id}:${id}`,
        source: src.id,
        sourceFormat: "informo",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        level: los,
        aggregation: "live",
        status: "active",
        geometry,
        los,
        origin,
        dataUpdatedAt: now,
        fetchedAt: now,
        isStale: false,
      };
      flows.push(flow);

      if (QUEUING_LOS.has(los)) {
        events.push({
          id: `${flow.id}:congestion`,
          source: src.id,
          sourceFormat: "informo",
          domain: "roads",
          kind: "event",
          type: "congestion",
          category: "conditions",
          isPlanned: false,
          severity: los === "stationary" || los === "blocked" ? "critical" : "high",
          severitySource: "derived",
          headline: `Traffic congestion (${id})`,
          status: "active",
          geometry,
          roads: [],
          origin,
          dataUpdatedAt: now,
          fetchedAt: now,
          isStale: false,
          validFrom: now,
        });
      }
    } catch (err) {
      console.warn("[madrid-flow] skipped malformed pm:", err);
    }
  }

  return { flows, events };
}
