import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, AUTHENTICATION_METHODS, PAYMENT_METHODS } from "@openconditions/model";
import { CONNECTOR_POWER_TYPES, OICP_EVSE_STATUSES } from "@openconditions/model-charging";
import { colocateSites } from "../colocate.js";
import type { EnergyMixInput } from "../energy-mix.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import {
  type BayInput,
  type ChargingMode,
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  type ParkingType,
  type PowerType,
  parsePowerKw,
  type SiteInput,
  siteDraft,
  type TextInput,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";
import { unplacedReason } from "./raw.js";

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
};

/**
 * A field of an OICP object by its name, whatever its case: Hubject writes
 * `EvseID` and `ChargingStationId`, the Swiss federal file `EVSEStatus`,
 * `ChargingPoolId`, `SuboperatorName` and a facility's `power` and
 * `powertype`, the EMP documentation an opening time's `On`.
 */
function field(record: unknown, name: string): unknown {
  if (!isRecord(record)) return undefined;
  if (record[name] !== undefined && record[name] !== null) return record[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lower && value !== undefined && value !== null) return value;
  }
  return undefined;
}

const textOf = (record: unknown, name: string) => text(field(record, name));

/** A number written as a number or as text (`"230"`). */
const num = (value: unknown): number | undefined => {
  const t = text(value);
  const n = t === undefined ? Number.NaN : Number(t.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** A list OICP writes as an array, or (in the Swiss federal file) as one object. */
const listOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

const strings = (value: unknown): string[] =>
  listOf(value).flatMap((v) => {
    const t = text(v);
    return t === undefined ? [] : [t];
  });

/**
 * OICP plug types → connector standard and whether the plug is a socket or
 * an attached cable. Tesla's connector (Type 2 or CCS2 in Europe), the
 * inductive paddles and AVCON's conductive connector have no OCPI standard;
 * an IEC 60309 three-phase plug is the one its facility's current names.
 */
const PLUGS: Readonly<Record<string, { standard: string; format?: "socket" | "cable" }>> = {
  "Small Paddle Inductive": { standard: "UNKNOWN" },
  "Large Paddle Inductive": { standard: "UNKNOWN" },
  "AVCON Connector": { standard: "UNKNOWN" },
  "Tesla Connector": { standard: "UNKNOWN" },
  "NEMA 5-20": { standard: "NEMA_5_20", format: "socket" },
  "Type E French Standard": { standard: "DOMESTIC_E", format: "socket" },
  "Type F Schuko": { standard: "DOMESTIC_F", format: "socket" },
  "Type G British Standard": { standard: "DOMESTIC_G", format: "socket" },
  "Type J Swiss Standard": { standard: "DOMESTIC_J", format: "socket" },
  "Type 1 Connector (Cable Attached)": { standard: "IEC_62196_T1", format: "cable" },
  "Type 2 Outlet": { standard: "IEC_62196_T2", format: "socket" },
  "Type 2 Connector (Cable Attached)": { standard: "IEC_62196_T2", format: "cable" },
  "Type 3 Outlet": { standard: "IEC_62196_T3C", format: "socket" },
  "IEC 60309 Single Phase": { standard: "IEC_60309_2_single_16", format: "socket" },
  "IEC 60309 Three Phase": { standard: "IEC_60309_2_three", format: "socket" },
  "CCS Combo 2 Plug (Cable Attached)": { standard: "IEC_62196_T2_COMBO", format: "cable" },
  "CCS Combo 1 Plug (Cable Attached)": { standard: "IEC_62196_T1_COMBO", format: "cable" },
  CHAdeMO: { standard: "CHADEMO", format: "cable" },
};

/** The three-phase IEC 60309 plug a facility's current rating names; unknown without one. */
function threePhase(amperes: number | undefined): string {
  if (amperes === undefined) return "UNKNOWN";
  if (amperes <= 16) return "IEC_60309_2_three_16";
  if (amperes <= 32) return "IEC_60309_2_three_32";
  return "IEC_60309_2_three_64";
}

const POWER_TYPES: ReadonlySet<string> = new Set(CONNECTOR_POWER_TYPES);

/** IEC 61851-1 charging modes, and CHAdeMO's own. */
const CHARGING_MODES: Readonly<Record<string, ChargingMode>> = {
  Mode_1: "mode1",
  Mode_2: "mode2",
  Mode_3: "mode3",
  Mode_4: "mode4",
  CHAdeMO: "chademo",
};

/**
 * `Accessibility`: free or paying, a public place is public. A test station
 * "may be restricted", which says nothing of who may charge.
 */
const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number] | null>> = {
  "Free publicly accessible": "public",
  "Paying publicly accessible": "public",
  "Restricted access": "restricted",
  "Test Station": null,
};

/**
 * `AuthenticationModes`. Both NFC cards identify by RFID; PnC is ISO 15118;
 * REMOTE is "App, QR-Code, Phone", a charge started remotely, as is direct
 * payment ("remote use via direct payment, e.g. intercharge direct"), which
 * also lets a driver pay for the session alone.
 */
const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number]>> = {
  "NFC RFID Classic": "rfid",
  "NFC RFID DESFire": "rfid",
  PnC: "plug_and_charge",
  REMOTE: "remote",
  "Direct Payment": "remote",
  "No Authentication Required": "none",
};

/**
 * `PaymentOptions`: no payment is free; a contract is a subscription; direct
 * payment ("e.g. Cash, Card, SMS") names no one means, but is ad hoc
 * charging.
 */
const PAYMENT: Readonly<Record<string, (typeof PAYMENT_METHODS)[number] | null>> = {
  "No Payment": "free",
  Direct: null,
  Contract: "membership",
};

/**
 * `ValueAddedServices` the model holds: a reservable point and a roof. The
 * others are services of the operator's back end (dynamic pricing, parking
 * sensors, dynamic maximum power, predicted usage, ISO 15118 charging plans)
 * the model has no place for, and `None` says there are none.
 */
const VALUE_ADDED_SERVICES: ReadonlySet<string> = new Set([
  "Reservation",
  "DynamicPricing",
  "ParkingSensors",
  "MaximumPowerCharging",
  "PredictiveChargePointUsage",
  "ChargingPlans",
  "RoofProvided",
  "None",
]);

const PARKING: Readonly<Record<string, ParkingType>> = {
  OnStreet: "on_street",
  ParkingGarage: "parking_garage",
  ParkingLot: "parking_lot",
  UndergroundParkingGarage: "underground_garage",
};

/** OICP energy types as an energy mix names its sources: OCPI's categories where they match. */
const ENERGY_SOURCES: Readonly<Record<string, string>> = {
  Solar: "solar",
  Wind: "wind",
  HydroPower: "water",
  GeothermalEnergy: "geothermal",
  Biomass: "biomass",
  Coal: "coal",
  NuclearEnergy: "nuclear",
  Petroleum: "petroleum",
  NaturalGas: "gas",
};

const CALIBRATION_LAW: Readonly<Record<string, string>> = {
  Local: "local",
  External: "external",
  "Not Available": "not_available",
};

/** `OpeningTimes.on`: a day, or the days a group names (workdays Monday to Friday). */
const OPENING_DAYS: Readonly<Record<string, number[]>> = {
  Monday: [1],
  Tuesday: [2],
  Wednesday: [3],
  Thursday: [4],
  Friday: [5],
  Saturday: [6],
  Sunday: [7],
  Workdays: [1, 2, 3, 4, 5],
  Weekend: [6, 7],
  Everyday: [1, 2, 3, 4, 5, 6, 7],
};

/** One `DegreeMinuteSeconds` coordinate, `52°28'49.782''`, in decimal degrees. */
function degreesOf(value: unknown): number | undefined {
  const m = text(value)?.match(/^(-?)(\d{1,3})°\s?(\d{1,2})'\s?(\d{1,2}(?:\.\d+)?)''$/);
  if (m === null || m === undefined) return undefined;
  const degrees = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
  return m[1] === "-" ? -degrees : degrees;
}

/**
 * A position from any of OICP's three coordinate formats; `[lon, lat]`.
 * `Google` is `{ Coordinates: "lat lon" }`, which the Swiss federal file
 * writes as the bare string.
 */
function pointOf(geo: unknown): [number, number] | undefined {
  if (!isRecord(geo)) return undefined;
  let lat: number | undefined;
  let lon: number | undefined;
  const googleField = field(geo, "Google");
  const google = text(isRecord(googleField) ? field(googleField, "Coordinates") : googleField);
  const decimal = field(geo, "DecimalDegree");
  const dms = field(geo, "DegreeMinuteSeconds");
  if (google !== undefined) {
    const [a, b] = google.split(/[\s,]+/).map(Number);
    lat = a;
    lon = b;
  } else if (isRecord(decimal)) {
    lat = Number(field(decimal, "Latitude"));
    lon = Number(field(decimal, "Longitude"));
  } else if (isRecord(dms)) {
    lat = degreesOf(field(dms, "Latitude"));
    lon = degreesOf(field(dms, "Longitude"));
  }
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return undefined;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return undefined;
  return [lon, lat];
}

/** Why `pointOf` placed nothing: no coordinates written, or unreadable ones. */
function unplacedOf(geo: unknown): "no_geometry" | "malformed" {
  const googleField = field(geo, "Google");
  const google = text(isRecord(googleField) ? field(googleField, "Coordinates") : googleField);
  if (google !== undefined) {
    const [lat, lon] = google.split(/[\s,]+/);
    return unplacedReason(lat, lon);
  }
  for (const format of ["DecimalDegree", "DegreeMinuteSeconds"]) {
    const c = field(geo, format);
    if (isRecord(c)) return unplacedReason(field(c, "Latitude"), field(c, "Longitude"));
  }
  return "no_geometry";
}

/** `InfoTextType` texts; OICP sends a list, the Swiss federal file sometimes one object. */
function infoTexts(value: unknown): TextInput[] {
  return listOf(value).flatMap((entry) => {
    const t = textOf(entry, "value");
    return t === undefined
      ? []
      : [{ lang: textOf(entry, "lang")?.toLowerCase() ?? "und", text: t }];
  });
}

/** Counts an enumerated value OICP does not define. */
type Unread = () => void;

/**
 * A record's connectors: one per plug. A single facility applies to every
 * plug, one facility per plug pairs by position; otherwise power is left out
 * rather than guessed. OICP writes power in kW, as a number or as text. A
 * plug, power type or charging mode outside OICP's lists is left unread and
 * counted.
 */
function connectorsOf(record: Raw, unread: Unread): ConnectorInput[] {
  const facilities = listOf(field(record, "ChargingFacilities")).filter(isRecord);
  const plugs = strings(field(record, "Plugs"));
  return plugs.map((plug, i) => {
    const facility =
      facilities.length === 1
        ? facilities[0]
        : facilities.length === plugs.length
          ? facilities[i]
          : undefined;
    const known = PLUGS[plug];
    if (known === undefined) unread();
    const powerType = textOf(facility, "PowerType")?.toUpperCase();
    if (powerType !== undefined && !POWER_TYPES.has(powerType)) unread();
    const power = parsePowerKw(field(facility, "Power"));
    const voltage = num(field(facility, "Voltage"));
    const amperage = num(field(facility, "Amperage"));
    const modes = strings(field(facility, "ChargingModes")).flatMap((m) => {
      const mode = CHARGING_MODES[m];
      if (mode === undefined) unread();
      return mode === undefined ? [] : [mode];
    });
    const standard =
      known?.standard === "IEC_60309_2_three"
        ? threePhase(amperage)
        : (known?.standard ?? "UNKNOWN");
    return {
      id: String(i + 1),
      standard,
      ...(known?.format === undefined ? {} : { format: known.format }),
      ...(powerType !== undefined && POWER_TYPES.has(powerType)
        ? { powerType: powerType as PowerType }
        : {}),
      ...(power === undefined ? {} : { maxPowerKw: power }),
      ...(voltage === undefined ? {} : { maxVoltage: voltage }),
      ...(amperage === undefined ? {} : { maxAmperage: amperage }),
      ...(modes.length === 0 ? {} : { chargingModes: modes }),
    };
  });
}

/** The value-added services a record names, each OICP does not define counted. */
function servicesOf(record: Raw, unread: Unread): string[] {
  return strings(field(record, "ValueAddedServices")).filter((s) => {
    if (VALUE_ADDED_SERVICES.has(s)) return true;
    unread();
    return false;
  });
}

function evseOf(evseId: string, record: Raw, unread: Unread): EvseInput {
  const address = field(record, "Address");
  const floor = textOf(address, "Floor");
  const spot = textOf(address, "ParkingSpot");
  const image = textOf(record, "ChargingStationImage");
  const manufacturer = textOf(record, "HardwareManufacturer");
  const directions = infoTexts(field(record, "ChargingStationLocationReference"));
  const reservable = servicesOf(record, () => {}).includes("Reservation");
  return {
    key: evseId,
    evseId,
    ...(reservable ? { capabilities: ["RESERVABLE"] } : {}),
    ...(floor === undefined ? {} : { floorLevel: floor }),
    ...(spot === undefined ? {} : { bays: [{ key: spot }] }),
    ...(image === undefined ? {} : { images: [{ url: image, category: "equipment" as const }] }),
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(directions.length === 0 ? {} : { directions }),
    connectors: connectorsOf(record, unread),
  };
}

/**
 * Opening times as weekly periods; a day OICP does not define is counted.
 * `Period` is a list, which some publishers write as one object.
 */
function openingPeriods(value: unknown, unread: Unread): WeeklyPeriod[] {
  return listOf(value).flatMap((entry) => {
    const on = textOf(entry, "on");
    const days = on === undefined ? undefined : OPENING_DAYS[on];
    if (on !== undefined && days === undefined) unread();
    if (days === undefined) return [];
    return listOf(field(entry, "Period")).flatMap((period) => {
      const from = textOf(period, "begin");
      const to = textOf(period, "end");
      return from === undefined || to === undefined ? [] : days.map((day) => ({ day, from, to }));
    });
  });
}

/** The energy a record says it supplies: renewable or not, its sources and their impact per kWh. */
function energyMixOf(record: Raw, unread: Unread): EnergyMixInput | undefined {
  const renewable = field(record, "RenewableEnergy");
  const sources = listOf(field(record, "EnergySource")).flatMap((entry) => {
    const energy = textOf(entry, "Energy");
    const pct = Number(field(entry, "Percentage"));
    const source = energy === undefined ? undefined : ENERGY_SOURCES[energy];
    if (energy !== undefined && source === undefined) unread();
    return source === undefined || !Number.isFinite(pct) ? [] : [{ source, pct }];
  });
  const impact = field(record, "EnvironmentalImpact");
  const amount = (name: string) => {
    const n = Number(field(impact, name));
    return field(impact, name) === undefined || !Number.isFinite(n) ? undefined : n;
  };
  const co2 = amount("CO2Emission");
  const waste = amount("NuclearWaste");
  const impacts = [
    ...(co2 === undefined ? [] : [{ category: "carbon_dioxide" as const, gPerKwh: co2 }]),
    ...(waste === undefined ? [] : [{ category: "nuclear_waste" as const, gPerKwh: waste }]),
  ];
  const mix = {
    ...(typeof renewable === "boolean" ? { isGreen: renewable } : {}),
    ...(sources.length === 0 ? {} : { sources }),
    ...(impacts.length === 0 ? {} : { impacts }),
  };
  return Object.keys(mix).length === 0 ? undefined : mix;
}

interface Pool {
  point: [number, number];
  operator?: string;
  records: Raw[];
}

/** A value of an enumerated field from a table, counted when OICP does not define it. */
function lookup<T>(
  table: Readonly<Record<string, T | null>>,
  value: string | undefined,
  unread: Unread,
): T | undefined {
  if (value === undefined) return undefined;
  if (!Object.hasOwn(table, value)) {
    unread();
    return undefined;
  }
  return table[value] ?? undefined;
}

function siteOf(stationId: string, pool: Pool, unread: Unread): SiteInput {
  const [first] = pool.records as [Raw, ...Raw[]];
  const [named] = infoTexts(field(first, "ChargingStationNames"));
  const address = field(first, "Address");
  const audience = lookup(AUDIENCE, textOf(first, "Accessibility"), unread);
  const parkingType = lookup(PARKING, textOf(first, "AccessibilityLocation"), unread);
  const all = (name: string) => [...new Set(pool.records.flatMap((r) => strings(field(r, name))))];
  const authModes = all("AuthenticationModes");
  const paymentOptions = all("PaymentOptions");
  const authentication = [
    ...new Set(authModes.flatMap((m) => lookup(AUTHENTICATION, m, unread) ?? [])),
  ];
  const payment = [...new Set(paymentOptions.flatMap((p) => lookup(PAYMENT, p, unread) ?? []))];
  const adHoc = paymentOptions.includes("Direct") || authModes.includes("Direct Payment");
  const services = new Set(pool.records.flatMap((r) => servicesOf(r, unread)));
  const evses = pool.records.map((record) =>
    evseOf(textOf(record, "EvseID") as string, record, unread),
  );
  const bays: BayInput[] = [
    ...new Set(pool.records.flatMap((r) => textOf(field(r, "Address"), "ParkingSpot") ?? [])),
  ].map((spot) => ({ key: spot, physicalReference: spot, details: {} }));
  const street = [textOf(address, "Street"), textOf(address, "HouseNum")]
    .filter((p) => p !== undefined)
    .join(" ");
  const twentyFourSeven = field(first, "IsOpen24Hours") === true;
  const hours = twentyFourSeven
    ? undefined
    : osmOpeningHours(openingPeriods(field(first, "OpeningTimes"), unread));
  const calibration = lookup(
    CALIBRATION_LAW,
    textOf(first, "CalibrationLawDataAvailability"),
    unread,
  );
  const dynamic = textOf(first, "DynamicInfoAvailable")?.toLowerCase();
  if (dynamic !== undefined && !["true", "false", "auto"].includes(dynamic)) unread();
  const suboperator = textOf(first, "SubOperatorName");
  const hotline = textOf(first, "HotlinePhoneNumber");
  const [notes] = infoTexts(field(first, "AdditionalInfo"));
  const entrance = pointOf(field(first, "GeoChargingPointEntrance"));
  const hub = textOf(first, "HubOperatorID");
  const locationImage = textOf(first, "LocationImage");
  const energyMix = energyMixOf(first, unread);
  return {
    stationId,
    point: pool.point,
    ...(named === undefined ? {} : { name: named.text, lang: named.lang }),
    ...(pool.operator === undefined ? {} : { operator: { name: pool.operator } }),
    ...(suboperator === undefined ? {} : { suboperator: { name: suboperator } }),
    address: {
      street: street === "" ? undefined : street,
      postalCode: textOf(address, "PostalCode"),
      city: textOf(address, "City"),
      region: textOf(address, "Region"),
      country: textOf(address, "Country"),
    },
    ...(twentyFourSeven ? { twentyFourSeven: true } : {}),
    ...(hours === undefined ? {} : { openingHoursOsm: hours }),
    ...(audience === undefined ? {} : { audience }),
    ...(authentication.length === 0 ? {} : { authentication }),
    ...(payment.length === 0 ? {} : { payment }),
    ...(adHoc ? { adHocCharging: true } : {}),
    ...(services.has("Reservation") ? { reservation: true } : {}),
    ...(services.has("RoofProvided") ? { roofed: true } : {}),
    ...(parkingType === undefined ? {} : { parkingType }),
    ...(hotline === undefined ? {} : { hotline }),
    ...(notes === undefined ? {} : { notes: notes.text }),
    ...(entrance === undefined ? {} : { entrance }),
    ...(energyMix === undefined ? {} : { energyMix }),
    ...(calibration === undefined ? {} : { calibrationLaw: calibration }),
    ...(dynamic === "true" || dynamic === "false" || dynamic === "auto"
      ? { dynamicInfoAvailable: dynamic }
      : {}),
    ...(hub === undefined ? {} : { hubOperatorId: hub }),
    ...(locationImage === undefined
      ? {}
      : { images: [{ url: locationImage, category: "site" as const }] }),
    evses,
    ...(bays.length === 0 ? {} : { bays }),
  };
}

/** A block of one operator's records, as every layout groups them. */
interface OperatorBlock {
  operator?: string;
  records: unknown[];
}

/**
 * The operator blocks of an EVSE data document in any of the layouts it is
 * published in: the Swiss federal file's `EVSEData` list of operator blocks,
 * OICP 2.1 and 2.2's `EvseData.OperatorEvseData`, a push request's
 * `OperatorEvseData`, and OICP 2.3's paged `content`, whose records carry
 * their operator themselves; a bare list of records is read as the last.
 */
function dataBlocks(doc: unknown): OperatorBlock[] {
  const blocks = (value: unknown): OperatorBlock[] =>
    listOf(value)
      .filter(isRecord)
      .map((block) => {
        const operator = textOf(block, "OperatorName") ?? textOf(block, "OperatorID");
        return {
          ...(operator === undefined ? {} : { operator }),
          records: listOf(field(block, "EvseDataRecord")),
        };
      });
  if (Array.isArray(doc)) return [{ records: doc }];
  const data = field(doc, "EvseData");
  if (Array.isArray(data)) return blocks(data);
  if (isRecord(data)) return blocks(field(data, "OperatorEvseData"));
  if (field(doc, "OperatorEvseData") !== undefined) return blocks(field(doc, "OperatorEvseData"));
  const content = field(doc, "content");
  return Array.isArray(content) ? [{ records: content }] : [];
}

/**
 * The status records of a status document in any of its layouts: the Swiss
 * federal file's `EVSEStatuses` list of operator blocks, OICP's
 * `EvseStatuses.OperatorEvseStatus`, a push request's `OperatorEvseStatus`
 * and the by-id answer's `EVSEStatusRecords.EvseStatusRecord`.
 */
function statusRecords(doc: unknown): unknown[] {
  const inBlocks = (value: unknown) =>
    listOf(value)
      .filter(isRecord)
      .flatMap((block) => listOf(field(block, "EvseStatusRecord")));
  const statuses = field(doc, "EvseStatuses");
  if (Array.isArray(statuses)) return inBlocks(statuses);
  if (isRecord(statuses)) return inBlocks(field(statuses, "OperatorEvseStatus"));
  if (field(doc, "OperatorEvseStatus") !== undefined) {
    return inBlocks(field(doc, "OperatorEvseStatus"));
  }
  return listOf(field(field(doc, "EvseStatusRecords"), "EvseStatusRecord"));
}

/**
 * The Hubject OICP EVSE data and status files, in any of the layouts OICP
 * and its publishers use (`dataBlocks`, `statusRecords`): an EVSE per
 * `EvseID`, the EVSEs of a `ChargingPoolID` one site, others one site per
 * position (to five decimals, about a metre), and one operator's sites
 * within 15 m one site. A record an update marks deleted is no EVSE. The
 * status file carries no times, so a reading is as of the fetch. An
 * enumerated value OICP does not define is left out and counted as
 * `unknown_value`.
 */
export function parseOicp(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const main = payloads["main"] ?? [];
  if (main.length === 0) return out;
  const pools = new Map<string, Pool>();
  const index: StatusIndexDraft = new Map();
  const unread = () => recordSkipped(feed.id, "unknown_value");
  for (const body of main) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    for (const block of dataBlocks(doc)) {
      for (const record of block.records) {
        if (!isRecord(record)) {
          recordSkipped(feed.id, "malformed");
          continue;
        }
        if (textOf(record, "deltaType") === "delete") continue;
        const evseId = textOf(record, "EvseID");
        if (evseId === undefined) {
          recordSkipped(feed.id, "malformed");
          continue;
        }
        const point = pointOf(field(record, "GeoCoordinates"));
        if (point === undefined) {
          recordSkipped(feed.id, unplacedOf(field(record, "GeoCoordinates")));
          continue;
        }
        if (index.has(evseId)) continue;
        const operator =
          textOf(record, "OperatorName") ?? textOf(record, "OperatorID") ?? block.operator;
        const stationId =
          textOf(record, "ChargingPoolID") ?? `${point[1].toFixed(5)},${point[0].toFixed(5)}`;
        const pool = pools.get(stationId);
        if (pool === undefined) {
          pools.set(stationId, {
            point,
            ...(operator === undefined ? {} : { operator }),
            records: [record],
          });
        } else pool.records.push(record);
        indexStatus(index, evseId, { stationId, evseKey: evseId, point: pool?.point ?? point });
      }
    }
  }
  for (const [stationId, pool] of pools) {
    out.features.push(siteDraft(feed, siteOf(stationId, pool, unread), ctx.fetchedAt));
  }
  out.statusIndex = index;
  colocateSites(out);
  out.observations = parseOicpStatus(feed, payloads, ctx, index).observations;
  return out;
}

/**
 * The status file: a reading per record of an indexed EVSE, as of the fetch;
 * a record of an EVSE the index does not hold is rejected; one without a
 * status, or with a status outside OICP's list, is no reading and counted.
 */
export function parseOicpStatus(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  const reader = statusReader(feed, ctx);
  for (const body of payloads["status"] ?? []) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    for (const record of statusRecords(doc).filter(isRecord)) {
      const subjects = subjectsOf(index, textOf(record, "EvseID"));
      if (subjects.length === 0) {
        reader.reject();
        continue;
      }
      const written = textOf(record, "EvseStatus");
      const status = written === undefined ? undefined : OICP_EVSE_STATUSES[written];
      if (typeof status !== "string") {
        recordSkipped(feed.id, written === undefined ? "malformed" : "unknown_value");
        continue;
      }
      for (const subject of subjects) reader.read(subject, status as EvseStatus, undefined);
    }
  }
  return reader.output();
}
