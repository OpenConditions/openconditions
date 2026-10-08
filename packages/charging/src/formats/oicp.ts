import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, AUTHENTICATION_METHODS } from "@openconditions/model";
import { CONNECTOR_POWER_TYPES, OICP_EVSE_STATUSES } from "@openconditions/model-charging";
import { colocateSites } from "../colocate.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  type ParkingType,
  type PowerType,
  parsePowerKw,
  type SiteInput,
  siteDraft,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
};

/** A number written as a number or as text (`"230"`). */
const num = (value: unknown): number | undefined => {
  const t = text(value);
  const n = t === undefined ? Number.NaN : Number(t.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** OICP plug names → connector standard and whether the plug is a socket or an attached cable. */
const PLUGS: Readonly<Record<string, { standard: string; format?: "socket" | "cable" }>> = {
  "Type 2 Outlet": { standard: "IEC_62196_T2", format: "socket" },
  "Type 2 Connector (Cable Attached)": { standard: "IEC_62196_T2", format: "cable" },
  "CCS Combo 2 Plug (Cable Attached)": { standard: "IEC_62196_T2_COMBO", format: "cable" },
  "CCS Combo 1 Plug (Cable Attached)": { standard: "IEC_62196_T1_COMBO", format: "cable" },
  "Type 1 Connector (Cable Attached)": { standard: "IEC_62196_T1", format: "cable" },
  CHAdeMO: { standard: "CHADEMO", format: "cable" },
  // Tesla's European sites are Type 2 or CCS2; the name says which neither.
  "Tesla Connector": { standard: "UNKNOWN" },
  "Type 3 Outlet": { standard: "IEC_62196_T3C", format: "socket" },
  "Type E French Standard": { standard: "DOMESTIC_E", format: "socket" },
  "Type F Schuko": { standard: "DOMESTIC_F", format: "socket" },
  "Type G British Standard": { standard: "DOMESTIC_G", format: "socket" },
  "Type J Swiss Standard": { standard: "DOMESTIC_J", format: "socket" },
  "IEC 60309 Single Phase": { standard: "IEC_60309_2_single_16", format: "socket" },
  "IEC 60309 Three Phase": { standard: "IEC_60309_2_three_16", format: "socket" },
  "NEMA 5-20": { standard: "NEMA_5_20", format: "socket" },
};

const POWER_TYPES: ReadonlySet<string> = new Set(CONNECTOR_POWER_TYPES);

const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  "Free publicly accessible": "public",
  "Paying publicly accessible": "public",
  "Restricted access": "restricted",
};

const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number]>> = {
  "NFC RFID Classic": "rfid",
  "NFC RFID DESFire": "rfid",
  REMOTE: "remote",
  PnC: "plug_and_charge",
};

const PARKING: Readonly<Record<string, ParkingType>> = {
  OnStreet: "on_street",
  ParkingGarage: "parking_garage",
  ParkingLot: "parking_lot",
  UndergroundParkingGarage: "underground_garage",
};

/** `"lat lon"` (`Google`), or a decimal-degree pair; `[lon, lat]`. */
function pointOf(geo: unknown): [number, number] | undefined {
  if (!isRecord(geo)) return undefined;
  let lat: number | undefined;
  let lon: number | undefined;
  const google = text(geo["Google"]);
  if (google !== undefined) {
    const [a, b] = google.split(/[\s,]+/).map(Number);
    lat = a;
    lon = b;
  } else if (isRecord(geo["DecimalDegree"])) {
    lat = Number(geo["DecimalDegree"]["Latitude"]);
    lon = Number(geo["DecimalDegree"]["Longitude"]);
  }
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return undefined;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return undefined;
  return [lon, lat];
}

/** The first name a record gives, with its language; OICP sends a list or one object. */
function nameOf(names: unknown): { name: string; lang: string } | undefined {
  const list = Array.isArray(names) ? names : [names];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const name = text(entry["value"]);
    if (name !== undefined) return { name, lang: text(entry["lang"])?.toLowerCase() ?? "und" };
  }
  return undefined;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        const t = text(v);
        return t === undefined ? [] : [t];
      })
    : [];

/**
 * A record's connectors: one per plug. A single facility applies to every
 * plug, one facility per plug pairs by position; otherwise power is left out
 * rather than guessed. OICP writes power in kW, as a number or as text.
 */
function connectorsOf(record: Raw): ConnectorInput[] {
  const facilities = (
    Array.isArray(record["ChargingFacilities"]) ? record["ChargingFacilities"] : []
  ).filter(isRecord);
  const plugs = strings(record["Plugs"]);
  return plugs.map((plug, i) => {
    const facility =
      facilities.length === 1
        ? facilities[0]
        : facilities.length === plugs.length
          ? facilities[i]
          : undefined;
    const known = PLUGS[plug];
    const powerType = text(facility?.["powertype"])?.toUpperCase();
    const power = parsePowerKw(facility?.["power"]);
    const voltage = num(facility?.["Voltage"]);
    const amperage = num(facility?.["Amperage"]);
    return {
      id: String(i + 1),
      standard: known?.standard ?? "UNKNOWN",
      ...(known?.format === undefined ? {} : { format: known.format }),
      ...(powerType !== undefined && POWER_TYPES.has(powerType)
        ? { powerType: powerType as PowerType }
        : {}),
      ...(power === undefined ? {} : { maxPowerKw: power }),
      ...(voltage === undefined ? {} : { maxVoltage: voltage }),
      ...(amperage === undefined ? {} : { maxAmperage: amperage }),
    };
  });
}

interface Pool {
  point: [number, number];
  operator?: string;
  records: Raw[];
}

function siteOf(stationId: string, pool: Pool): SiteInput {
  const [first] = pool.records as [Raw, ...Raw[]];
  const named = nameOf(first["ChargingStationNames"]);
  const address = isRecord(first["Address"]) ? first["Address"] : {};
  const audience = AUDIENCE[text(first["Accessibility"]) ?? ""];
  const parkingType = PARKING[text(first["AccessibilityLocation"]) ?? ""];
  const authentication = [
    ...new Set(
      strings(first["AuthenticationModes"]).flatMap((m) =>
        AUTHENTICATION[m] === undefined ? [] : [AUTHENTICATION[m]],
      ),
    ),
  ];
  const evses: EvseInput[] = pool.records.flatMap((record) => {
    const evseId = text(record["EvseID"]);
    return evseId === undefined ? [] : [{ key: evseId, evseId, connectors: connectorsOf(record) }];
  });
  const street = [text(address["Street"]), text(address["HouseNum"])]
    .filter((p) => p !== undefined)
    .join(" ");
  return {
    stationId,
    point: pool.point,
    ...(named === undefined ? {} : { name: named.name, lang: named.lang }),
    ...(pool.operator === undefined ? {} : { operator: { name: pool.operator } }),
    address: {
      street: street === "" ? undefined : street,
      postalCode: text(address["PostalCode"]),
      city: text(address["City"]),
      country: text(address["Country"]),
    },
    ...(first["IsOpen24Hours"] === true ? { twentyFourSeven: true } : {}),
    ...(audience === undefined ? {} : { audience }),
    ...(authentication.length === 0 ? {} : { authentication }),
    ...(parkingType === undefined ? {} : { parkingType }),
    evses,
  };
}

/**
 * The Hubject OICP EVSE data and status files: an EVSE per `EvseID`, the
 * EVSEs of a `ChargingPoolID` one site, others one site per position (to
 * five decimals, about a metre), and one operator's sites within 15 m one
 * site. The status file carries no times, so a reading is as of the fetch.
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
  let rejected = 0;
  for (const body of main) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const groups = isRecord(doc) && Array.isArray(doc["EVSEData"]) ? doc["EVSEData"] : [];
    for (const group of groups.filter(isRecord)) {
      const operator = text(group["OperatorName"]) ?? text(group["OperatorID"]);
      const records = Array.isArray(group["EVSEDataRecord"]) ? group["EVSEDataRecord"] : [];
      for (const record of records.filter(isRecord)) {
        const evseId = text(record["EvseID"]);
        const point = pointOf(record["GeoCoordinates"]);
        if (evseId === undefined || point === undefined) {
          rejected++;
          continue;
        }
        if (index.has(evseId)) continue;
        const stationId =
          text(record["ChargingPoolID"]) ??
          text(record["ChargingPoolId"]) ??
          `${point[1].toFixed(5)},${point[0].toFixed(5)}`;
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
    out.features.push(siteDraft(feed, siteOf(stationId, pool), ctx.fetchedAt));
  }
  out.rejected = rejected;
  out.statusIndex = index;
  colocateSites(out);
  out.observations = parseOicpStatus(feed, payloads, ctx, index).observations;
  return out;
}

/**
 * The status file: a reading per record of an indexed EVSE, as of the fetch;
 * a record of an EVSE the index does not hold is rejected.
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
    const groups = isRecord(doc) && Array.isArray(doc["EVSEStatuses"]) ? doc["EVSEStatuses"] : [];
    for (const group of groups.filter(isRecord)) {
      const records = Array.isArray(group["EVSEStatusRecord"]) ? group["EVSEStatusRecord"] : [];
      for (const record of records.filter(isRecord)) {
        const subjects = subjectsOf(index, text(record["EvseID"]));
        if (subjects.length === 0) {
          reader.reject();
          continue;
        }
        const status = OICP_EVSE_STATUSES[text(record["EVSEStatus"]) ?? ""];
        if (typeof status !== "string") continue;
        for (const subject of subjects) reader.read(subject, status as EvseStatus, undefined);
      }
    }
  }
  return reader.output();
}
