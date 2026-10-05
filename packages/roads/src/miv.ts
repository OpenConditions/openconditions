import {
  getXmlChild,
  getXmlChildren,
  isXmlObject,
  parseXmlDocument,
  xmlText,
} from "@openconditions/datex2";
import type { FlowContext, FlowSite, FlowSites } from "./flow-output.js";
import { type FlowParse, type FlowReading, plausibleSpeed } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

/** Parse a MIV number, which uses a comma decimal separator (no thousands sep). */
function numNl(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw.trim().replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * MIV vehicle classes (`klasse_id`) as model vehicle classes: motorcycles,
 * cars, vans, lorries, and articulated lorries.
 */
const MIV_CLASSES: Record<string, string> = {
  "1": "motorcycle",
  "2": "car",
  "3": "van",
  "4": "truck",
  "5": "hgv",
};

/** A MIV measuring point counts the vehicles of each one-minute period. */
const MIV_PERIOD_SEC = 60;

/**
 * Build the measuring points (point and full name) from the Flanders MIV configuration document
 * (`miv.opendata.belfla.be/miv/configuratie/xml`). Each `<meetpunt>` carries
 * WGS84 coordinates directly (`lengtegraad_EPSG_4326`/`breedtegraad_EPSG_4326`,
 * comma decimals), so no reprojection is needed. The id joins to the traffic
 * feed's `<meetpunt unieke_id>`. Points without a valid coordinate are skipped.
 */
export function parseMivConfig(input: string | Buffer): FlowSites {
  const map = new Map<string, FlowSite>();
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) => n === "meetpunt",
    });
  } catch {
    return map;
  }
  const root = isXmlObject(doc) ? (getXmlChild(doc, "mivconfig") ?? doc) : null;
  if (!root) return map;

  for (const mp of getXmlChildren(root, "meetpunt")) {
    const id = mp["@_unieke_id"];
    if (id == null) continue;
    const lon = numNl(xmlText(mp["lengtegraad_EPSG_4326"]));
    const lat = numNl(xmlText(mp["breedtegraad_EPSG_4326"]));
    if (lon == null || lat == null) continue;
    const name = xmlText(mp["volledige_naam"])?.trim();
    map.set(String(id), {
      geometry: { type: "Point", coordinates: [lon, lat] },
      ...(name ? { name, nameLang: "nl" } : {}),
    });
  }
  return map;
}

/**
 * Parse the Flanders MIV traffic feed (`miv.opendata.belfla.be/miv/verkeersdata`).
 * Each `<meetpunt>` is one lane detector reporting per vehicle class
 * (`<meetdata klasse_id>`) the vehicles counted in the minute
 * (`verkeersintensiteit`) and their harmonic mean speed (252 = no data), and
 * the minute's occupancy (`rekendata/bezettingsgraad`). The site speed is
 * the harmonic speed of the highest-intensity valid class; the per-class
 * speeds are kept as a vector, and the counts summed into an hourly volume.
 * Geometry comes from the configuration, joined on `unieke_id`. Faulty
 * (`defect`), ungeolocated, or no-vehicle points are skipped. (`geldig` is NOT
 * a per-cycle data-validity flag — it is 0 for most live points that carry
 * real speeds — so the no-data sentinel and a positive count are the
 * validity signal.)
 */
export function parseMivFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) => n === "meetpunt" || n === "meetdata",
    });
  } catch {
    return { readings: [], failed: true };
  }
  const root = isXmlObject(doc) ? (getXmlChild(doc, "miv") ?? doc) : null;
  if (!root) return { readings: [], failed: true };

  const readings: FlowReading[] = [];
  for (const mp of getXmlChildren(root, "meetpunt")) {
    try {
      const id = mp["@_unieke_id"];
      if (id == null) continue;
      if (xmlText(mp["defect"]) === "1") continue;
      const site = sites?.get(String(id));
      if (!site) continue;

      let bestIntensity = -1;
      let speedKph: number | undefined;
      let count = 0;
      const classSpeeds: Record<string, number> = {};
      for (const md of getXmlChildren(mp, "meetdata")) {
        const intensity = numNl(xmlText(md["verkeersintensiteit"]));
        const speed = numNl(xmlText(md["voertuigsnelheid_harmonisch"]));
        if (intensity == null || intensity < 0) continue;
        count += intensity;
        if (intensity === 0 || !plausibleSpeed(speed)) continue;
        const vehicleClass = MIV_CLASSES[String(md["@_klasse_id"] ?? "")];
        if (vehicleClass !== undefined) classSpeeds[vehicleClass] = speed;
        if (intensity > bestIntensity) {
          bestIntensity = intensity;
          speedKph = speed;
        }
      }
      if (speedKph == null) continue;
      const rekendata = getXmlChild(mp, "rekendata");
      const occupancy = rekendata ? numNl(xmlText(rekendata["bezettingsgraad"])) : undefined;
      const at = xmlText(mp["tijd_waarneming"]);

      readings.push({
        site: String(id),
        geometry: site.geometry,
        ...(at !== undefined ? { at } : {}),
        periodSec: MIV_PERIOD_SEC,
        los: "unknown",
        speedKph,
        volume: count * (3600 / MIV_PERIOD_SEC),
        ...(occupancy !== undefined && occupancy >= 0 && occupancy <= 100 ? { occupancy } : {}),
        ...(Object.keys(classSpeeds).length > 0 ? { classSpeeds } : {}),
        ...(site.name !== undefined ? { name: site.name } : {}),
        ...(site.nameLang !== undefined ? { nameLang: site.nameLang } : {}),
      });
    } catch (err) {
      console.warn("[miv-flow] skipped malformed meetpunt:", err);
    }
  }

  return { readings };
}
