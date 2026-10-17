import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { AUTHENTICATION_METHODS, PAYMENT_METHODS } from "@openconditions/model";
import type { OcpiTariff, OcpiTariffElement } from "@openconditions/ocpi";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours, type WeeklyPeriod } from "../hours.js";
import { own } from "../records.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  instantIn,
  type ParkingType,
  type SiteAddress,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";
import { tariffDraft } from "../tariff.js";
import {
  isRecord,
  placeAt,
  positiveInteger,
  positiveNumber,
  type Raw,
  text,
  unplacedReason,
} from "./raw.js";

const ZONE = "Asia/Taipei";

/**
 * The connector `Type` codes: 1 CCS1, 2 CCS2, 3 CHAdeMO, 4 Tesla, 5 J1772,
 * 6 Mennekes; 254 is another plug and 255 an unknown one, both a plug of no
 * standard the model names.
 */
const STANDARDS: Readonly<Record<string, string>> = {
  "1": "IEC_62196_T1_COMBO",
  "2": "IEC_62196_T2_COMBO",
  "3": "CHADEMO",
  "4": "TESLA_S",
  "5": "IEC_62196_T1",
  "6": "IEC_62196_T2",
  "254": "UNKNOWN",
  "255": "UNKNOWN",
};

/** `Power`: how the connector delivers its power. */
const CURRENTS: Readonly<Record<string, "ac" | "dc">> = { "1": "ac", "2": "dc" };

/**
 * A charging point's `Payment`: a credit card, a smart card (Taiwan's
 * stored-value cards), an electronic payment, another means.
 */
const PAYMENTS: Readonly<Record<string, (typeof PAYMENT_METHODS)[number]>> = {
  CreditCard: "credit_card",
  SmartCard: "prepaid_card",
  EPay: "app",
  Others: "other",
};

/** A charging point's `StartType`: by card, by app; by staff or otherwise names no method. */
const START_TYPES: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number] | null>> = {
  ByCard: "rfid",
  ByApp: "app",
  ByStaff: null,
  Others: null,
};

/** `ConnectorStatus`: 2 is "occupied or charging", which says no more than occupied. */
const STATES: Readonly<Record<string, EvseStatus>> = {
  "1": "available",
  "2": "occupied",
  "3": "out_of_order",
};

const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
/**
 * `DayType` 1 is every day, 2 weekdays, 3 the weekend; 4 to 8 (holidays,
 * special days, other) name days the model cannot.
 */
const DAY_TYPES: Readonly<Record<string, string[] | undefined>> = {
  "1": undefined,
  "2": WEEKDAYS,
  "3": ["SATURDAY", "SUNDAY"],
};

/** The weekdays each day type names, Monday 1. */
const DAY_NUMBERS: Readonly<Record<string, number[]>> = {
  "1": [1, 2, 3, 4, 5, 6, 7],
  "2": [1, 2, 3, 4, 5],
  "3": [6, 7],
};

/** A connector `Type`'s standard; a code TDX does not list is left unread and counted. */
function standardOf(feedId: string, type: string | undefined): string {
  const standard = own(STANDARDS, type);
  if (type !== undefined && standard === undefined) recordSkipped(feedId, "unknown_value");
  return standard ?? "UNKNOWN";
}

/** `220V`, `32A`, `7kW`: the number before its unit. */
const rating = (value: unknown): number | undefined =>
  positiveNumber(text(value)?.match(/^\s*(\d+(?:\.\d+)?)/)?.[1]);

/** The records of an answer: the wrapper's list, or the list itself. */
function rowsOf(bodies: readonly Buffer[] | undefined, key: string): Raw[] {
  return (bodies ?? []).flatMap((body) => {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const rows = isRecord(doc) ? doc[key] : doc;
    return Array.isArray(rows) ? rows.filter(isRecord) : [];
  });
}

const byStation = (rows: Raw[]) => {
  const map = new Map<string, Raw[]>();
  for (const row of rows) {
    const id = text(row["StationID"]);
    if (id !== undefined) map.set(id, [...(map.get(id) ?? []), row]);
  }
  return map;
};

/**
 * One rate as an OCPI tariff element. Free charging is a flat price of
 * nothing; per kWh an energy price; per hour a time price. Null for a rate
 * the model cannot hold, which is counted: RateType 3, which the schema calls
 * per minute but which stations also use for hourly prices, a holiday or
 * seasonal day type, a stay window of unstated unit.
 */
function elementOf(rate: Raw): OcpiTariffElement | null {
  const price = Number(text(rate["RatePrice"]));
  if (!Number.isFinite(price) || price < 0) return null;
  const component = (() => {
    switch (text(rate["RateType"])) {
      case "1":
        return { type: "FLAT", price: 0 };
      case "2":
        return { type: "ENERGY", price };
      case "4":
        return { type: "TIME", price };
      default:
        return undefined;
    }
  })();
  const dayType = text(rate["DayType"]);
  if (component === undefined || (dayType !== undefined && !Object.hasOwn(DAY_TYPES, dayType))) {
    return null;
  }
  if (rate["Summer"] != null || rate["StayStart"] != null || rate["StayEnd"] != null) return null;
  const start = text(rate["StartTime"]);
  const end = text(rate["EndTime"]);
  const allDay = start === "00:00" && (end === "24:00" || end === undefined);
  const days = own(DAY_TYPES, dayType);
  const minKw = positiveNumber(rate["StartKW"]);
  const maxKw = positiveNumber(rate["EndKW"]);
  const restrictions = {
    ...(allDay || start === undefined ? {} : { start_time: start }),
    // A day's end is OCPI's 00:00, the same as no end time after a start.
    ...(allDay || end === undefined || end === "24:00" ? {} : { end_time: end }),
    ...(days === undefined ? {} : { day_of_week: days }),
    ...(minKw === undefined ? {} : { min_power: minKw }),
    ...(maxKw === undefined ? {} : { max_power: maxKw }),
  };
  return {
    price_components: [component],
    ...(Object.keys(restrictions).length === 0 ? {} : { restrictions }),
  };
}

/** FNV-1a: a short stable key for a list of rates. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A connector's rates as a tariff, keyed by their content so the connectors
 * with the same rates share one. Undefined when a rate cannot be held: a
 * tariff with one of its rates dropped would state the others for its hours.
 */
function tariffOf(row: Raw, unread: () => void): OcpiTariff | undefined {
  const rates = (Array.isArray(row["Rates"]) ? row["Rates"] : [])
    .filter(isRecord)
    .map((rate, i) => ({ rate, order: positiveInteger(rate["RateSequence"]) ?? i }))
    .sort((a, b) => a.order - b.order)
    .map(({ rate }) => elementOf(rate));
  for (const element of rates) if (element === null) unread();
  if (rates.length === 0 || rates.some((e) => e === null)) return undefined;
  const elements = rates as OcpiTariffElement[];
  return {
    id: `rate-${hash(JSON.stringify(elements))}`,
    currency: "TWD",
    tax_included: "N/A",
    elements,
  };
}

/**
 * The station's address: the city (縣市), the road with its lane, alley and
 * number, and the whole as written; else the place's name.
 */
function addressOf(station: Raw): SiteAddress {
  const location = isRecord(station["Location"]) ? station["Location"] : {};
  const address = isRecord(location["Address"]) ? location["Address"] : undefined;
  if (address !== undefined) {
    const parts = ["City", "Town", "Road", "Lane", "Alley", "No"].flatMap(
      (k) => text(address[k]) ?? [],
    );
    const street = ["Road", "Lane", "Alley"].flatMap((k) => text(address[k]) ?? []).join("");
    if (parts.length > 0) {
      return {
        text: parts.join(""),
        ...(text(address["City"]) === undefined ? {} : { city: text(address["City"]) }),
        ...(street === "" ? {} : { street }),
        ...(text(address["No"]) === undefined ? {} : { houseNumber: text(address["No"]) }),
      };
    }
  }
  const place = isRecord(location["Place"]) ? location["Place"] : {};
  return { text: text(place["POI"]) };
}

/**
 * Where vehicles stand: on a motorway (`Location.Freeway`), in an off-street
 * car park (`Reference.CarPark`) or a stretch of kerbside bays
 * (`Reference.CurbParkingSegment`).
 */
function parkingOf(station: Raw): ParkingType | undefined {
  const location = isRecord(station["Location"]) ? station["Location"] : {};
  const reference = isRecord(station["Reference"]) ? station["Reference"] : {};
  if (isRecord(location["Freeway"])) return "along_motorway";
  if (isRecord(reference["CurbParkingSegment"])) return "on_street";
  if (isRecord(reference["CarPark"])) return "parking_lot";
  return undefined;
}

/**
 * A station's service times as OSM hours: each opening hour's day type and
 * span. Undefined where one names days the model cannot (holidays, special
 * days), which is counted, or none reads.
 */
function serviceHoursOf(rows: readonly Raw[], unread: () => void): string | undefined {
  const periods: WeeklyPeriod[] = [];
  for (const hour of rows.flatMap((r) =>
    (Array.isArray(r["OpeningHours"]) ? r["OpeningHours"] : []).filter(isRecord),
  )) {
    const dayType = text(hour["DayType"]) ?? "1";
    const days = own(DAY_NUMBERS, dayType);
    const from = text(hour["StartTime"]);
    const to = text(hour["EndTime"]);
    if (days === undefined) {
      unread();
      return undefined;
    }
    if (from === undefined || to === undefined) continue;
    for (const day of days) periods.push({ day, from, to });
  }
  return osmOpeningHours(periods);
}

/** The flags of a point's `Payment` or `StartType` that are set, through a table. */
function flagsOf<T>(value: unknown, table: Readonly<Record<string, T | null>>, unread: () => void) {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, set]) => {
    if (set !== true) return [];
    const method = own(table, key);
    if (method === undefined) unread();
    return method ?? [];
  });
}

/**
 * The station's connector groups as charge points, where no live state names
 * its points: when the guns add up to the charge points, each gun is a charge
 * point and a group of one type stands for its `Quantity`; otherwise each
 * group is one charge point of uncounted plugs.
 */
function groupEvses(feedId: string, station: Raw, groups: Raw[]): EvseInput[] {
  const guns = groups.reduce((n, g) => n + (positiveInteger(g["Quantity"]) ?? 0), 0);
  const counted = guns > 0 && guns === positiveInteger(station["ChargingPoints"]);
  const keys = new Set<string>();
  return groups.flatMap((g, i) => {
    const type = text(g["Type"]);
    if (type === undefined) return [];
    let key = `type-${type}`;
    if (keys.has(key)) key = `${key}-${i + 1}`;
    keys.add(key);
    const current = own(CURRENTS, text(g["Power"]));
    const quantity = positiveInteger(g["Quantity"]);
    return [
      {
        key,
        ...(counted && quantity !== undefined ? { quantity } : {}),
        connectors: [
          {
            id: "1",
            standard: standardOf(feedId, type),
            ...(current === undefined ? {} : { current }),
          },
        ],
      },
    ];
  });
}

/**
 * Taiwan's TDX charging service, one city per URL: `Station` rows in `sites`,
 * `ChargingRate` rows per connector in `tariffs`, `ConnectorLiveStatus` rows
 * in `status`, and where a feed fetches them `Connector` rows (each plug's
 * rated voltage, current, power and floor) in `connectors`, `ChargingPoint`
 * rows (payment, how charging starts, floor, restrictions) in `points`,
 * `Operator` rows in `operators` and `ServiceTime` rows in `servicetimes`. A
 * station is a site. Its charge points are those the live states or the
 * connector rows name, each connector of each with its live state read as of
 * the fetch (unless its own time lies more than 30 days back); without
 * either, its connector groups. Each connector's rates are a TWD offer its
 * connector names, or the whole site's when no connector of the site is
 * known; TDX states no VAT, and a rate the model cannot hold is counted. The
 * station's charging-rate text is the site's tariff text, its parking rate,
 * description and use restriction notes, and its service time the opening
 * hours, as OSM hours where the service times read so. A station without its
 * id, or listed again under one, is malformed; one without a position, or
 * with one that places nothing, is counted as such.
 */
export function parseTdx(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const unread = () => recordSkipped(feed.id, "unknown_value");
  const liveRows = rowsOf(payloads["status"], "LiveStatuses");
  const live = byStation(liveRows);
  const rates = byStation(rowsOf(payloads["tariffs"], "ChargingRates"));
  const plugRows = byStation(rowsOf(payloads["connectors"], "Connectors"));
  const pointRows = byStation(rowsOf(payloads["points"], "ChargingPoints"));
  const serviceTimes = byStation(rowsOf(payloads["servicetimes"], "ServiceTimes"));
  const operators = new Map<string, Raw>();
  for (const row of rowsOf(payloads["operators"], "Operators")) {
    const id = text(row["OperatorID"]) ?? text(row["BAN"]);
    if (id !== undefined) operators.set(id, row);
  }
  const index: StatusIndexDraft = new Map();
  const seen = new Set<string>();
  for (const station of rowsOf(payloads["sites"], "Stations")) {
    const stationId = text(station["StationID"]);
    if (stationId === undefined || seen.has(stationId)) {
      recordSkipped(feed.id, "malformed");
      continue;
    }
    const point = placeAt(Number(station["PositionLat"]), Number(station["PositionLon"]));
    if (point === undefined) {
      recordSkipped(feed.id, unplacedReason(station["PositionLat"], station["PositionLon"]));
      continue;
    }
    seen.add(stationId);

    const groups = (Array.isArray(station["Connectors"]) ? station["Connectors"] : []).filter(
      isRecord,
    );
    const currentOf = (type: string | undefined) => {
      const powers = new Set(
        groups.filter((g) => text(g["Type"]) === type).map((g) => text(g["Power"])),
      );
      const [power] = powers;
      return powers.size === 1 ? own(CURRENTS, power) : undefined;
    };

    const tariffs = new Map<string, OcpiTariff>();
    const tariffOfConnector = new Map<string, string>();
    for (const row of rates.get(stationId) ?? []) {
      const tariff = tariffOf(row, unread);
      const connectorId = text(row["ConnectorID"]);
      if (tariff === undefined) continue;
      tariffs.set(tariff.id, tariff);
      if (connectorId !== undefined) tariffOfConnector.set(connectorId, tariff.id);
    }

    // Each plug's own row, where the feed fetches them: its rating, current and floor.
    const plugs = new Map<string, Raw>();
    for (const row of plugRows.get(stationId) ?? []) {
      const connectorId = text(row["ConnectorID"]);
      if (connectorId !== undefined) plugs.set(connectorId, row);
    }
    const pointInfo = new Map<string, Raw>();
    for (const row of pointRows.get(stationId) ?? []) {
      const pointId = text(row["ChargingPointID"]);
      if (pointId !== undefined) pointInfo.set(pointId, row);
    }

    // The live states name the charge points and their connectors; else the plugs' rows do.
    const named =
      (live.get(stationId) ?? []).length > 0
        ? (live.get(stationId) ?? [])
        : (plugRows.get(stationId) ?? []);
    const points = new Map<string, ConnectorInput[]>();
    const floors = new Map<string, string>();
    for (const row of named) {
      const pointId = text(row["ChargingPointID"]);
      const connectorId = text(row["ConnectorID"]);
      if (pointId === undefined || connectorId === undefined) continue;
      const plug = plugs.get(connectorId);
      const type = text(row["ConnectorType"]) ?? text(plug?.["Type"]);
      const current = own(CURRENTS, text(plug?.["Power"])) ?? currentOf(type);
      const tariff = tariffOfConnector.get(connectorId);
      const kw = rating(plug?.["PowerRating"]);
      const volts = rating(plug?.["Voltage"]);
      const amps = rating(plug?.["CurrentRating"]);
      const floor = text(plug?.["Floor"]);
      if (floor !== undefined && !floors.has(pointId)) floors.set(pointId, floor);
      points.set(pointId, [
        ...(points.get(pointId) ?? []),
        {
          id: connectorId,
          standard: standardOf(feed.id, type),
          ...(current === undefined ? {} : { current }),
          ...(kw === undefined ? {} : { maxPowerKw: kw }),
          ...(volts === undefined ? {} : { maxVoltage: volts }),
          ...(amps === undefined ? {} : { maxAmperage: amps }),
          ...(tariff === undefined ? {} : { tariffIds: [tariff] }),
        },
      ]);
      indexStatus(index, connectorRef(stationId, pointId, connectorId), {
        stationId,
        evseKey: pointId,
        connectorId,
        point,
      });
    }
    const evses: EvseInput[] =
      points.size > 0
        ? [...points].map(([key, connectors]) => {
            const floor = text(pointInfo.get(key)?.["Floor"]) ?? floors.get(key);
            const restriction = text(pointInfo.get(key)?.["UsageRestriction"]);
            return {
              key,
              ...(floor === undefined ? {} : { floorLevel: floor }),
              ...(restriction === undefined
                ? {}
                : { directions: [{ lang: "zh-TW", text: restriction }] }),
              connectors,
            };
          })
        : groupEvses(feed.id, station, groups);

    const infos = [...pointInfo.values()];
    const payment = [...new Set(infos.flatMap((p) => flagsOf(p["Payment"], PAYMENTS, unread)))];
    const authentication = [
      ...new Set(infos.flatMap((p) => flagsOf(p["StartType"], START_TYPES, unread))),
    ];
    const operatorRow = operators.get(text(station["OperatorID"]) ?? "");
    const operatorName = isRecord(operatorRow?.["OperatorName"])
      ? (text(operatorRow["OperatorName"]["Zh_tw"]) ?? text(operatorRow["OperatorName"]["En"]))
      : undefined;
    const ban = text(operatorRow?.["BAN"]);
    const logo = text(operatorRow?.["LogoURL"]);
    const operatorWebsite = text(operatorRow?.["WebURL"]);
    const operatorPhone = text(operatorRow?.["Telephone"]);
    const terms = text(operatorRow?.["TsAndCsURL"]);
    const photos = (Array.isArray(station["PhotoURLs"]) ? station["PhotoURLs"] : []).flatMap(
      (url) => text(url) ?? [],
    );
    const hours = serviceHoursOf(serviceTimes.get(stationId) ?? [], unread);
    const parkingType = parkingOf(station);
    // Publishers repeat the parking rate as the description; each text once.
    const notes = [
      ...new Set(
        [
          text(station["Description"]),
          text(station["UsageRestriction"]),
          text(station["ParkingRate"]),
        ].filter((n) => n !== undefined),
      ),
    ].join("; ");
    const floorsText = text(station["Floors"]);

    const name = isRecord(station["StationName"]) ? station["StationName"] : {};
    const zh = text(name["Zh_tw"]);
    out.features.push(
      siteDraft(
        feed,
        {
          stationId,
          point,
          name: zh ?? text(name["En"]),
          lang: zh === undefined ? "en" : "zh-TW",
          ...(operatorName === undefined
            ? {}
            : {
                operator: {
                  name: operatorName,
                  ...(operatorWebsite === undefined ? {} : { website: operatorWebsite }),
                  ...(operatorPhone === undefined ? {} : { phone: operatorPhone }),
                  // A Taiwanese business administration number (統一編號), the register's id.
                  ...(ban === undefined
                    ? {}
                    : { ids: [{ scheme: "cpo", id: ban, authority: feed.id }] }),
                },
              }),
          address: addressOf(station),
          ...(hours === undefined
            ? { openingHoursText: text(station["ServiceTime"]) }
            : { openingHoursOsm: hours }),
          tariffText: text(station["ChargingRate"]),
          notes,
          ...(text(station["Telephone"]) === undefined
            ? {}
            : { hotline: text(station["Telephone"]) }),
          ...(floorsText === undefined
            ? {}
            : { directions: [{ lang: "zh-TW", text: floorsText }] }),
          ...(parkingType === undefined ? {} : { parkingType }),
          ...(payment.length === 0 ? {} : { payment }),
          ...(authentication.length === 0 ? {} : { authentication }),
          images: [
            ...photos.map((url) => ({ url, category: "site" as const })),
            ...(logo === undefined ? [] : [{ url: logo, category: "operator_logo" as const }]),
          ],
          evses:
            terms === undefined
              ? evses
              : evses.map((e) => ({
                  ...e,
                  connectors: e.connectors.map((c) => ({ ...c, termsUrl: terms })),
                })),
        },
        ctx.fetchedAt,
      ),
    );
    for (const tariff of tariffs.values()) {
      const offer = tariffDraft(feed, stationId, tariff, { fetchedAt: ctx.fetchedAt, point });
      if (offer !== undefined) out.offers.push(offer);
    }
  }
  out.statusIndex = index;
  out.observations = tdxStatusReadings(feed, liveRows, index, ctx).observations;
  return out;
}

const connectorRef = (
  stationId: string | undefined,
  pointId: string | undefined,
  connectorId: string | undefined,
) => `${stationId}\u0000${pointId}\u0000${connectorId}`;

/**
 * A reading per live state of an indexed connector, as of its
 * `LastUpdateTime`, and none when that lies more than 30 days back; a state
 * of a connector the index does not hold is rejected, and a status code TDX
 * does not list is no reading and counted.
 */
function tdxStatusReadings(
  feed: ChargingCatalogFeed,
  rows: readonly Raw[],
  index: StatusIndex,
  ctx: ParseContext,
): StatusOutput {
  const reader = statusReader(feed, ctx);
  for (const row of rows) {
    const key = connectorRef(
      text(row["StationID"]),
      text(row["ChargingPointID"]),
      text(row["ConnectorID"]),
    );
    const subjects = subjectsOf(index, key);
    if (subjects.length === 0) {
      reader.reject();
      continue;
    }
    const at = instantIn(ZONE, row["LastUpdateTime"]);
    if (!statusIsLive(at, ctx.fetchedAt)) continue;
    const code = text(row["ConnectorStatus"]);
    const status = own(STATES, code);
    if (status === undefined) {
      if (code !== undefined) recordSkipped(feed.id, "unknown_value");
      continue;
    }
    for (const subject of subjects) reader.read(subject, status, at);
  }
  return reader.output();
}

/** The status-only reading of the `ConnectorLiveStatus` rows. */
export function parseTdxStatus(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  return tdxStatusReadings(feed, rowsOf(payloads["status"], "LiveStatuses"), index, ctx);
}
