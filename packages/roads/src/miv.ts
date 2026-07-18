import type { Point } from "geojson";
import type { RoadFlow } from "./model.js";
import type { SiteGeometry } from "./siteTable.js";
import type { SourceDescriptor } from "./types.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";
import { getXmlChild, getXmlChildren, isXmlObject, parseXmlDocument, xmlText } from "./xml.js";

// MIV's no-data speed sentinel is 252 km/h; anything at/above this plausibility
// bound is not a real vehicle speed.
const ABSURD_SPEED_KPH = 250;

/** Parse a MIV number, which uses a comma decimal separator (no thousands sep). */
function numNl(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw.trim().replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build a `unieke_id → Point` map from the Flanders MIV configuration document
 * (`miv.opendata.belfla.be/miv/configuratie/xml`). Each `<meetpunt>` carries
 * WGS84 coordinates directly (`lengtegraad_EPSG_4326`/`breedtegraad_EPSG_4326`,
 * comma decimals), so no reprojection is needed. The id joins to the traffic
 * feed's `<meetpunt unieke_id>`. Points without a valid coordinate are skipped.
 */
export function parseMivConfig(input: string | Buffer): Map<string, SiteGeometry> {
  const map = new Map<string, SiteGeometry>();
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
    map.set(String(id), { type: "Point", coordinates: [lon, lat] });
  }
  return map;
}

/**
 * Parse the Flanders MIV traffic feed (`miv.opendata.belfla.be/miv/verkeersdata`)
 * into RoadFlow point measurements. Each `<meetpunt>` reports per-vehicle-class
 * `<meetdata>` with a `verkeersintensiteit` (count/min) and a
 * `voertuigsnelheid_harmonisch` (harmonic mean speed, km/h); the representative
 * speed is the harmonic speed of the highest-intensity valid class (252 = no
 * data). Geometry comes from the config `siteMap`, joined on `unieke_id`. los is
 * left "unknown" (absolute speed is road-class–dependent) for baseline
 * enrichment. Faulty (`defect`), ungeolocated, or no-vehicle points are
 * skipped. (`geldig` is NOT a per-cycle data-validity flag — it is 0 for the
 * vast majority of live points that nonetheless carry real speeds — so the
 * 252-km/h no-data sentinel and a positive intensity are the validity signal.)
 */
export function parseMivFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, SiteGeometry>
): FlowParseResult {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) => n === "meetpunt" || n === "meetdata",
    });
  } catch {
    return { flows: [], events: [], failed: true };
  }
  const root = isXmlObject(doc) ? (getXmlChild(doc, "miv") ?? doc) : null;
  if (!root) return { flows: [], events: [], failed: true };

  const points = getXmlChildren(root, "meetpunt");
  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];

  for (const mp of points) {
    try {
      const id = mp["@_unieke_id"];
      if (id == null) continue;
      if (xmlText(mp["defect"]) === "1") continue;

      const geom = siteMap?.get(String(id)) as Point | undefined;
      if (!geom) continue;

      // Representative speed = harmonic speed of the highest-intensity valid class.
      let bestIntensity = -1;
      let speedKph: number | undefined;
      for (const md of getXmlChildren(mp, "meetdata")) {
        const intensity = numNl(xmlText(md["verkeersintensiteit"]));
        const speed = numNl(xmlText(md["voertuigsnelheid_harmonisch"]));
        if (intensity == null || speed == null) continue;
        if (intensity <= 0 || speed < 0 || speed >= ABSURD_SPEED_KPH) continue;
        if (intensity > bestIntensity) {
          bestIntensity = intensity;
          speedKph = speed;
        }
      }
      if (speedKph == null) continue;

      const measuredAt = xmlText(mp["tijd_waarneming"]) ?? now;
      flows.push({
        id: `${src.id}:${id}`,
        source: src.id,
        sourceFormat: "miv",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        value: speedKph,
        unit: "km/h",
        level: "unknown",
        aggregation: "live",
        status: "active",
        geometry: geom,
        los: "unknown",
        speedKph,
        origin,
        dataUpdatedAt: measuredAt,
        fetchedAt: now,
        isStale: false,
      });
    } catch (err) {
      console.warn("[miv-flow] skipped malformed meetpunt:", err);
    }
  }

  return { flows, events: [] };
}
