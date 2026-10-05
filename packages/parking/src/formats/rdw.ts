import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { ParkingSiteType } from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { type AreaInput, type SiteInput, siteDraft } from "../site.js";

/** One row of SPECIFICATIES PARKEERGEBIED (`b3us-f26s`); every value is a string. */
interface RdwSpecs {
  areamanagerid?: string;
  areaid?: string;
  capacity?: string;
  chargingpointcapacity?: string;
  disabledaccess?: string;
  maximumvehicleheight?: string;
}

/** One row of the garage, P+R or carpool area datasets. */
interface RdwArea {
  areamanagerid?: string;
  areaid?: string;
  areadesc?: string;
  location?: { latitude?: string; longitude?: string };
  usageid?: string;
  aantal_parkeer_plaatsen?: string;
  aantal_laad_punten?: string;
  toegankelijk_voor_gehandicapten?: string;
  maximale_inrij_hoogte?: string;
}

const USAGES: Readonly<Record<string, { type: ParkingSiteType; usage?: string }>> = {
  GARAGEP: { type: "off_street" },
  PARKRIDE: { type: "park_and_ride", usage: "park_and_ride" },
  CARPOOL: { type: "off_street", usage: "carpool" },
};

/** How the datasets write yes: `1` (live), `True` and `Ja` (older exports). */
const YES = new Set(["1", "true", "ja", "j", "yes", "y"]);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** A count above zero. */
function positive(value: unknown): number | undefined {
  const t = text(value);
  if (t === undefined || !/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n > 0 ? n : undefined;
}

/** A height in metres: the datasets write centimetres, but a value below 10 is metres. */
function heightM(value: unknown): number | undefined {
  const n = Number.parseFloat(text(value) ?? "");
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 10 ? n : Math.round(n) / 100;
}

const yes = (value: unknown) => {
  const t = text(value)?.toLowerCase();
  return t === undefined ? undefined : YES.has(t);
};

const keyOf = (row: { areamanagerid?: string; areaid?: string }) => {
  const manager = text(row.areamanagerid);
  const area = text(row.areaid);
  return manager === undefined || area === undefined ? undefined : `${manager}/${area}`;
};

/** A JSON array of Socrata rows. */
function rows<T>(body: Buffer, role: string): T[] {
  const doc = JSON.parse(body.toString("utf8")) as unknown;
  if (!Array.isArray(doc)) throw new Error(`rdw: ${role} body is not an array`);
  return doc as T[];
}

function pointOf(area: RdwArea): [number, number] | undefined {
  const lat = Number.parseFloat(text(area.location?.latitude) ?? "");
  const lon = Number.parseFloat(text(area.location?.longitude) ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return undefined;
  return [lon, lat];
}

/**
 * The specification's value wins over the area dataset's; the area
 * dataset's own fields fill in only where there is no specification.
 */
function siteInput(
  area: RdwArea,
  specs: RdwSpecs | undefined,
  stationId: string,
  point: [number, number],
): SiteInput {
  const usage = USAGES[text(area.usageid) ?? "GARAGEP"] ?? { type: "off_street" };
  const fromSpecs = <T>(read: (v: unknown) => T | undefined, spec: unknown, own: unknown) =>
    specs === undefined || text(spec) === undefined ? read(own) : read(spec);
  const capacity = fromSpecs(positive, specs?.capacity, area.aantal_parkeer_plaatsen);
  const charging = fromSpecs(positive, specs?.chargingpointcapacity, area.aantal_laad_punten);
  const disabled = fromSpecs(yes, specs?.disabledaccess, area.toegankelijk_voor_gehandicapten);
  const height = fromSpecs(heightM, specs?.maximumvehicleheight, area.maximale_inrij_hoogte);
  const name = text(area.areadesc);
  const areas: AreaInput[] = [
    ...(capacity === undefined
      ? []
      : [{ vehicleType: "car", userGroup: "any", capacity } as const]),
    // A count of charging points and a yes for disabled access: such spaces exist.
    ...(charging === undefined ? [] : [{ vehicleType: "car", userGroup: "ev_charging" } as const]),
    ...(disabled === true ? [{ vehicleType: "car", userGroup: "disabled" } as const] : []),
  ];
  return {
    stationId,
    point,
    lang: "nl",
    ...(name === undefined ? {} : { name }),
    type: usage.type,
    ...(usage.usage === undefined ? {} : { usage: [usage.usage] }),
    ...(capacity === undefined ? {} : { capacityTotal: capacity }),
    ...(height === undefined ? {} : { heightLimitM: height }),
    areas,
  };
}

/**
 * RDW (Netherlands): the `specs` payload holds the parking specifications,
 * the `areas` payloads the garage, P+R and carpool area datasets with their
 * points. An area is a site, joined to its specification on
 * `areamanagerid/areaid`; the first area of an id wins, so a garage that is
 * also a P+R area stays one site. No readings: the datasets are static.
 */
export function parseRdw(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const specs = new Map<string, RdwSpecs>();
  for (const body of payloads["specs"] ?? []) {
    for (const row of rows<RdwSpecs>(body, "specs")) {
      const key = keyOf(row);
      if (key !== undefined && !specs.has(key)) specs.set(key, row);
    }
  }
  const seen = new Set<string>();
  let rejected = 0;
  for (const body of payloads["areas"] ?? []) {
    for (const area of rows<RdwArea>(body, "areas")) {
      const stationId = keyOf(area);
      const point = pointOf(area);
      if (stationId === undefined || point === undefined) {
        rejected++;
        continue;
      }
      if (seen.has(stationId)) continue;
      seen.add(stationId);
      const input = siteInput(area, specs.get(stationId), stationId, point);
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));
    }
  }
  out.rejected = rejected;
  return out;
}
