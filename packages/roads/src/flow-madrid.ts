import {
  getXmlChild,
  getXmlChildren,
  isXmlObject,
  parseXmlDocument,
  xmlText,
} from "@openconditions/datex2";
import { recordSkipped, reprojectorFor } from "@openconditions/ingest-framework";
import type { Point } from "geojson";
import type { FlowContext, FlowSites } from "./flow-output.js";
import type { FlowParse, FlowReading, Los } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

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

/** Parse a Madrid INFORMO number, which uses a comma decimal separator. */
function numEs(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the City of Madrid INFORMO realtime traffic XML
 * (`informo.madrid.es/informo/tmadrid/pm.xml`). Each `<pm>` is a measurement
 * point carrying a `nivelServicio` level of service, `intensidad` (vehicles
 * per hour) and `ocupacion` (%), with UTM (ETRS89 / EPSG:25830) `st_x`/`st_y`
 * coordinates reprojected to WGS84. The feed carries no measured speed and no
 * per-point time, so readings are dated by the poll. Points with an error
 * flag or no stated level carry nothing this cycle and are left out. A point
 * without an id, with an unreadable coordinate or with a level off the scale
 * is skipped as malformed, one without a coordinate as having no geometry.
 */
export function parseMadridFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: true,
      isArray: (n) => n === "pm",
    });
  } catch {
    return { readings: [], failed: true };
  }

  const root = isXmlObject(doc) ? (getXmlChild(doc, "pms") ?? doc) : null;
  if (!root) return { readings: [], failed: true };

  const toWgs = reprojectorFor("EPSG:25830");
  const readings: FlowReading[] = [];
  for (const pm of getXmlChildren(root, "pm")) {
    try {
      if (xmlText(pm["error"]) === "S") continue; // sensor fault this cycle
      const id = xmlText(pm["idelem"]);
      if (!id) {
        recordSkipped(src.id, "malformed");
        continue;
      }

      const rawX = xmlText(pm["st_x"]);
      const rawY = xmlText(pm["st_y"]);
      if (!rawX?.trim() && !rawY?.trim()) {
        recordSkipped(src.id, "no_geometry");
        continue;
      }
      const x = numEs(rawX);
      const y = numEs(rawY);
      if (x == null || y == null || !toWgs) {
        recordSkipped(src.id, x == null || y == null ? "malformed" : "no_geometry");
        continue;
      }
      const [lon, lat] = toWgs([x, y]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        recordSkipped(src.id, "malformed");
        continue;
      }

      const nivel = xmlText(pm["nivelServicio"])?.trim();
      if (!nivel) continue; // no level stated this cycle
      const los = losFromNivel(nivel);
      if (los === "unknown") {
        recordSkipped(src.id, "malformed");
        continue;
      }
      const volume = numEs(xmlText(pm["intensidad"]));
      const occupancy = numEs(xmlText(pm["ocupacion"]));
      const name = xmlText(pm["descripcion"])?.trim();

      const geometry: Point = { type: "Point", coordinates: [lon, lat] };
      readings.push({
        site: id,
        geometry,
        los,
        ...(volume !== undefined && volume >= 0 ? { volume } : {}),
        ...(occupancy !== undefined && occupancy >= 0 && occupancy <= 100 ? { occupancy } : {}),
        ...(name ? { name, nameLang: "es" } : {}),
      });
    } catch (err) {
      console.warn("[madrid-flow] skipped malformed pm:", err);
      recordSkipped(src.id, "malformed");
    }
  }

  return { readings };
}
