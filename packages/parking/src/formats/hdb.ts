import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { ParkingLayout, ParkingVehicleType } from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import {
  type AreaInput,
  instantIn,
  occupancyDrafts,
  type ReadingInput,
  type SiteInput,
  siteDraft,
} from "../site.js";

/** One car park of the HDB car park information table (`datastore_search`). */
interface HdbCarPark {
  car_park_no?: string;
  address?: string;
  x_coord?: string | number;
  y_coord?: string | number;
  car_park_type?: string;
  free_parking?: string;
  gantry_height?: number | string | null;
}

/** One lot type of a car park in the availability feed; every count is a string. */
interface HdbLotInfo {
  total_lots?: string;
  lot_type?: string;
  lots_available?: string;
}

interface HdbAvailability {
  carpark_number?: string;
  update_datetime?: string;
  carpark_info?: HdbLotInfo[];
}

/**
 * SVY21 (EPSG:3414): a transverse Mercator on WGS84. The closed-form inverse
 * below follows cgcai/SVY21 (MIT), as OpenMapX had it.
 */
const A = 6378137;
const F = 1 / 298.257223563;
const ORIGIN_LAT = 1.366666;
const ORIGIN_LON = 103.833333;
const FALSE_NORTHING = 38744.572;
const FALSE_EASTING = 28001.642;
const K = 1;

const B = A * (1 - F);
const E2 = 2 * F - F * F;
const E4 = E2 * E2;
const E6 = E4 * E2;
const A0 = 1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256;
const A2 = (3 / 8) * (E2 + E4 / 4 + (15 * E6) / 128);
const A4 = (15 / 256) * (E4 + (3 * E6) / 4);
const A6 = (35 * E6) / 3072;
const N = (A - B) / (A + B);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N2 * N2;
const G = A * (1 - N) * (1 - N2) * (1 + (9 * N2) / 4 + (225 * N4) / 64) * (Math.PI / 180);

const RAD = Math.PI / 180;

function meridianArc(latDeg: number): number {
  const lat = latDeg * RAD;
  return A * (A0 * lat - A2 * Math.sin(2 * lat) + A4 * Math.sin(4 * lat) - A6 * Math.sin(6 * lat));
}

/** WGS84 `{ lat, lon }` of an SVY21 northing and easting, in metres. */
export function svy21ToWgs84(northing: number, easting: number): { lat: number; lon: number } {
  const mPrime = meridianArc(ORIGIN_LAT) + (northing - FALSE_NORTHING) / K;
  const sigma = (mPrime * Math.PI) / (180 * G);
  const latPrime =
    sigma +
    ((3 * N) / 2 - (27 * N3) / 32) * Math.sin(2 * sigma) +
    ((21 * N2) / 16 - (55 * N4) / 32) * Math.sin(4 * sigma) +
    ((151 * N3) / 96) * Math.sin(6 * sigma) +
    ((1097 * N4) / 512) * Math.sin(8 * sigma);

  const sin2 = Math.sin(latPrime) ** 2;
  const rho = (A * (1 - E2)) / (1 - E2 * sin2) ** 1.5;
  const v = A / Math.sqrt(1 - E2 * sin2);
  const psi = v / rho;
  const psi2 = psi * psi;
  const psi3 = psi2 * psi;
  const psi4 = psi3 * psi;
  const t = Math.tan(latPrime);
  const t2 = t * t;
  const t4 = t2 * t2;
  const t6 = t4 * t2;
  const e = easting - FALSE_EASTING;
  const x = e / (K * v);
  const x3 = x ** 3;
  const x5 = x ** 5;
  const x7 = x ** 7;

  const latFactor = t / (K * rho);
  const lat =
    latPrime -
    latFactor * ((e * x) / 2) +
    latFactor * ((e * x3) / 24) * (-4 * psi2 + 9 * psi * (1 - t2) + 12 * t2) -
    latFactor *
      ((e * x5) / 720) *
      (8 * psi4 * (11 - 24 * t2) -
        12 * psi3 * (21 - 71 * t2) +
        15 * psi2 * (15 - 98 * t2 + 15 * t4) +
        180 * psi * (5 * t2 - 3 * t4) +
        360 * t4) +
    latFactor * ((e * x7) / 40320) * (1385 - 3633 * t2 + 4095 * t4 + 1575 * t6);

  const sec = 1 / Math.cos(lat);
  const lon =
    ORIGIN_LON * RAD +
    x * sec -
    ((x3 * sec) / 6) * (psi + 2 * t2) +
    ((x5 * sec) / 120) *
      (-4 * psi3 * (1 - 6 * t2) + psi2 * (9 - 68 * t2) + 72 * psi * t2 + 24 * t4) -
    ((x7 * sec) / 5040) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);

  return { lat: lat / RAD, lon: lon / RAD };
}

const LAYOUTS: Readonly<Record<string, ParkingLayout>> = {
  "MULTI-STOREY CAR PARK": "multi_storey",
  "BASEMENT CAR PARK": "underground",
  "SURFACE CAR PARK": "surface",
  "COVERED CAR PARK": "covered",
  "MECHANISED CAR PARK": "automated",
};

/** The availability feed's lot types: cars, motorcycles and heavy vehicles. */
const LOT_TYPES: Readonly<Record<string, ParkingVehicleType>> = {
  C: "car",
  Y: "motorcycle",
  H: "truck",
};

/** Singapore, with a margin: a converted point outside it is a bad coordinate. */
const BOUNDS = { minLat: 1.1, maxLat: 1.5, minLon: 103.5, maxLon: 104.1 };

const TIME_ZONE = "Asia/Singapore";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** A number, or a numeric string as the tables write counts and coordinates. */
function number(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** The table's upper-case address in title case, its abbreviations kept. */
function nameOf(address: string): string {
  return address
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bHdb\b/g, "HDB")
    .replace(/\bMrt\b/g, "MRT");
}

interface Lots {
  vehicleType: ParkingVehicleType;
  total?: number;
  available?: number;
}

interface Availability {
  at?: string;
  lots: Lots[];
}

/** The availability per car park: one entry per lot type, the first of a repeated type winning. */
function availabilityOf(bodies: readonly Buffer[]): Map<string, Availability> {
  const out = new Map<string, Availability>();
  for (const body of bodies) {
    const doc = JSON.parse(body.toString("utf8")) as { items?: { carpark_data?: unknown }[] };
    if (!Array.isArray(doc?.items)) throw new Error("hdb: availability body has no items array");
    const data = doc.items[0]?.carpark_data;
    for (const carPark of (Array.isArray(data) ? data : []) as HdbAvailability[]) {
      const id = text(carPark.carpark_number);
      if (id === undefined || out.has(id)) continue;
      const lots: Lots[] = [];
      for (const info of carPark.carpark_info ?? []) {
        const vehicleType = LOT_TYPES[text(info.lot_type) ?? ""];
        if (vehicleType === undefined || lots.some((l) => l.vehicleType === vehicleType)) continue;
        const total = number(info.total_lots);
        const available = number(info.lots_available);
        lots.push({
          vehicleType,
          ...(total === undefined ? {} : { total }),
          ...(available === undefined ? {} : { available }),
        });
      }
      // Singapore time; a time with an offset is taken as given.
      const at = instantIn(TIME_ZONE, carPark.update_datetime);
      out.set(id, { ...(at === undefined ? {} : { at }), lots });
    }
  }
  return out;
}

/** The car parks of the table body: CKAN's `{ result: { records } }`. */
function carParksOf(body: Buffer): HdbCarPark[] {
  const doc = JSON.parse(body.toString("utf8")) as { result?: { records?: unknown } };
  const records = doc?.result?.records;
  if (!Array.isArray(records)) throw new Error("hdb: table body has no result.records array");
  return records as HdbCarPark[];
}

function pointOf(carPark: HdbCarPark): [number, number] | undefined {
  const x = number(carPark.x_coord);
  const y = number(carPark.y_coord);
  if (x === undefined || y === undefined || x === 0 || y === 0) return undefined;
  const { lat, lon } = svy21ToWgs84(y, x);
  if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon) {
    return undefined;
  }
  return [lon, lat];
}

const lotsArea = (lots: Lots): AreaInput => ({
  vehicleType: lots.vehicleType,
  userGroup: "any",
  ...(lots.total === undefined ? {} : { capacity: lots.total }),
});

function siteInput(
  carPark: HdbCarPark,
  stationId: string,
  point: [number, number],
  live: Availability | undefined,
): SiteInput {
  const address = text(carPark.address);
  const layout = LAYOUTS[text(carPark.car_park_type)?.toUpperCase() ?? ""];
  const free = text(carPark.free_parking);
  const height = number(carPark.gantry_height);
  const lots = (live?.lots ?? []).filter((l) => l.total !== undefined && l.total > 0);
  const car = lots.find((l) => l.vehicleType === "car");
  return {
    stationId,
    point,
    lang: "en",
    name: address === undefined ? `Car Park ${stationId}` : nameOf(address),
    ...(address === undefined ? {} : { address: { text: address } }),
    ...(layout === undefined ? {} : { layout }),
    // Free parking is a time window ("SUN & PH FR 7AM-10.30PM"), not a free car park.
    ...(free === undefined || free.toUpperCase() === "NO"
      ? {}
      : { tariffText: `Free parking: ${free}` }),
    ...(height !== undefined && height > 0 ? { heightLimitM: height } : {}),
    ...(car?.total === undefined ? {} : { capacityTotal: car.total }),
    areas: lots.map(lotsArea),
  };
}

function readingsOf(
  feed: ParkingCatalogFeed,
  reading: ReadingInput,
  live: Availability,
  ctx: ParseContext,
): RecordDraft[] {
  const counts = (lots: Lots) => ({
    ...(lots.available === undefined ? {} : { available: lots.available }),
    ...(lots.total === undefined ? {} : { capacity: lots.total }),
  });
  const out: RecordDraft[] = [];
  // Only lots with a count above zero are areas, and only car lots so counted are the site's.
  const counted = live.lots.filter((l) => l.total !== undefined && l.total > 0);
  const car = counted.find((l) => l.vehicleType === "car");
  if (car !== undefined) out.push(...occupancyDrafts(feed, reading, counts(car), ctx));
  for (const lots of counted) {
    const area = { vehicleType: lots.vehicleType, userGroup: "any" as const };
    out.push(...occupancyDrafts(feed, { ...reading, area }, counts(lots), ctx));
  }
  return out;
}

/**
 * HDB car parks (data.gov.sg): the `sites` table gives each car park, its
 * SVY21 point converted to WGS84; the `status` availability gives, per lot
 * type, the lots and the free ones. Car (`C`), motorcycle (`Y`) and
 * heavy-vehicle (`H`) lots are areas with their own readings; the car lots
 * are also the site's capacity and readings. Availability is dated by its
 * `update_datetime`, Singapore time. A car park without a point in
 * Singapore is rejected.
 */
export function parseHdb(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const availability = availabilityOf(payloads["status"] ?? []);
  let rejected = 0;
  for (const body of payloads["sites"] ?? []) {
    for (const carPark of carParksOf(body)) {
      const stationId = text(carPark.car_park_no);
      const point = pointOf(carPark);
      if (stationId === undefined || point === undefined) {
        rejected++;
        continue;
      }
      const live = availability.get(stationId);
      out.features.push(siteDraft(feed, siteInput(carPark, stationId, point, live), ctx.fetchedAt));
      if (live === undefined) continue;
      const reading = { stationId, at: live.at ?? ctx.fetchedAt, point };
      out.observations.push(...readingsOf(feed, reading, live, ctx));
    }
  }
  out.rejected = rejected;
  return out;
}
