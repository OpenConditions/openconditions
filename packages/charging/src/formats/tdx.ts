import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { OcpiTariff, OcpiTariffElement } from "@openconditions/ocpi";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  instantIn,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";
import { tariffDraft } from "../tariff.js";
import { isRecord, placeAt, positiveInteger, positiveNumber, type Raw, text } from "./raw.js";

const ZONE = "Asia/Taipei";

/** The connector `Type` codes: 1 CCS1, 2 CCS2, 3 CHAdeMO, 4 Tesla, 5 J1772, 6 Mennekes. */
const STANDARDS: Readonly<Record<string, string>> = {
  "1": "IEC_62196_T1_COMBO",
  "2": "IEC_62196_T2_COMBO",
  "3": "CHADEMO",
  "4": "TESLA_S",
  "5": "IEC_62196_T1",
  "6": "IEC_62196_T2",
};

/** `ConnectorStatus`: 2 is "occupied or charging", which says no more than occupied. */
const STATES: Readonly<Record<string, EvseStatus>> = {
  "1": "available",
  "2": "occupied",
  "3": "out_of_order",
};

const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
/** `DayType` 1 is every day, 2 weekdays, 3 the weekend; the rest name holidays the model cannot. */
const DAY_TYPES: Readonly<Record<string, string[] | undefined>> = {
  "1": undefined,
  "2": WEEKDAYS,
  "3": ["SATURDAY", "SUNDAY"],
};

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
 * the model cannot hold: RateType 3, which the schema calls per minute but
 * which stations also use for hourly prices, a holiday or seasonal day type,
 * a stay window of unstated unit.
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
  if (component === undefined || (dayType !== undefined && !(dayType in DAY_TYPES))) return null;
  if (rate["Summer"] != null || rate["StayStart"] != null || rate["StayEnd"] != null) return null;
  const start = text(rate["StartTime"]);
  const end = text(rate["EndTime"]);
  const allDay = start === "00:00" && (end === "24:00" || end === undefined);
  const days = dayType === undefined ? undefined : DAY_TYPES[dayType];
  const minKw = positiveNumber(rate["StartKW"]);
  const maxKw = positiveNumber(rate["EndKW"]);
  const restrictions = {
    ...(allDay || start === undefined ? {} : { start_time: start }),
    ...(allDay || end === undefined ? {} : { end_time: end }),
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
function tariffOf(row: Raw): OcpiTariff | undefined {
  const rates = (Array.isArray(row["Rates"]) ? row["Rates"] : [])
    .filter(isRecord)
    .map((rate, i) => ({ rate, order: positiveInteger(rate["RateSequence"]) ?? i }))
    .sort((a, b) => a.order - b.order)
    .map(({ rate }) => elementOf(rate));
  if (rates.length === 0 || rates.some((e) => e === null)) return undefined;
  const elements = rates as OcpiTariffElement[];
  return {
    id: `rate-${hash(JSON.stringify(elements))}`,
    currency: "TWD",
    tax_included: "N/A",
    elements,
  };
}

function addressOf(station: Raw): string | undefined {
  const location = isRecord(station["Location"]) ? station["Location"] : {};
  const address = isRecord(location["Address"]) ? location["Address"] : undefined;
  if (address !== undefined) {
    const parts = ["City", "Town", "Road", "Lane", "Alley", "No"].flatMap(
      (k) => text(address[k]) ?? [],
    );
    if (parts.length > 0) return parts.join("");
  }
  const place = isRecord(location["Place"]) ? location["Place"] : {};
  return text(place["POI"]);
}

/**
 * The station's connector groups as charge points, where no live state names
 * its points: when the guns add up to the charge points, each gun is a charge
 * point and a group of one type stands for its `Quantity`; otherwise each
 * group is one charge point of uncounted plugs.
 */
function groupEvses(station: Raw, groups: Raw[]): EvseInput[] {
  const guns = groups.reduce((n, g) => n + (positiveInteger(g["Quantity"]) ?? 0), 0);
  const counted = guns > 0 && guns === positiveInteger(station["ChargingPoints"]);
  const keys = new Set<string>();
  return groups.flatMap((g, i) => {
    const type = text(g["Type"]);
    if (type === undefined) return [];
    let key = `type-${type}`;
    if (keys.has(key)) key = `${key}-${i + 1}`;
    keys.add(key);
    const power = text(g["Power"]);
    const quantity = positiveInteger(g["Quantity"]);
    return [
      {
        key,
        ...(counted && quantity !== undefined ? { quantity } : {}),
        connectors: [
          {
            id: "1",
            standard: STANDARDS[type] ?? "UNKNOWN",
            ...(power === "1"
              ? { current: "ac" as const }
              : power === "2"
                ? { current: "dc" as const }
                : {}),
          },
        ],
      },
    ];
  });
}

/**
 * Taiwan's TDX charging service, one city per URL: `Station` rows in `sites`,
 * `ChargingRate` rows per connector in `tariffs`, `ConnectorLiveStatus` rows
 * in `status`. A station is a site. Its charge points are those the live
 * states name, each connector of each with its live state read as of the
 * fetch (unless its own time lies more than 30 days back); without live
 * states, its connector groups. Each connector's rates are a TWD offer its
 * connector names, or the whole site's when no connector of the site is
 * known; TDX states no VAT. The station's charging-rate text is the site's
 * tariff text, its parking rate a note, and its service time the opening
 * hours as written.
 */
export function parseTdx(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const liveRows = rowsOf(payloads["status"], "LiveStatuses");
  const live = byStation(liveRows);
  const rates = byStation(rowsOf(payloads["tariffs"], "ChargingRates"));
  const index: StatusIndexDraft = new Map();
  let rejected = 0;
  const seen = new Set<string>();
  for (const station of rowsOf(payloads["sites"], "Stations")) {
    const stationId = text(station["StationID"]);
    const point = placeAt(Number(station["PositionLat"]), Number(station["PositionLon"]));
    if (stationId === undefined || point === undefined || seen.has(stationId)) {
      rejected++;
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
      if (powers.size !== 1) return undefined;
      return power === "1" ? ("ac" as const) : power === "2" ? ("dc" as const) : undefined;
    };

    const tariffs = new Map<string, OcpiTariff>();
    const tariffOfConnector = new Map<string, string>();
    for (const row of rates.get(stationId) ?? []) {
      const tariff = tariffOf(row);
      const connectorId = text(row["ConnectorID"]);
      if (tariff === undefined) continue;
      tariffs.set(tariff.id, tariff);
      if (connectorId !== undefined) tariffOfConnector.set(connectorId, tariff.id);
    }

    const rows = live.get(stationId) ?? [];
    const points = new Map<string, ConnectorInput[]>();
    for (const row of rows) {
      const pointId = text(row["ChargingPointID"]);
      const connectorId = text(row["ConnectorID"]);
      if (pointId === undefined || connectorId === undefined) continue;
      const type = text(row["ConnectorType"]);
      const current = currentOf(type);
      const tariff = tariffOfConnector.get(connectorId);
      points.set(pointId, [
        ...(points.get(pointId) ?? []),
        {
          id: connectorId,
          standard: STANDARDS[type ?? ""] ?? "UNKNOWN",
          ...(current === undefined ? {} : { current }),
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
        ? [...points].map(([key, connectors]) => ({ key, connectors }))
        : groupEvses(station, groups);

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
          address: { text: addressOf(station) },
          openingHoursText: text(station["ServiceTime"]),
          tariffText: text(station["ChargingRate"]),
          notes: text(station["ParkingRate"]),
          evses,
        },
        ctx.fetchedAt,
      ),
    );
    for (const tariff of tariffs.values()) {
      const offer = tariffDraft(feed, stationId, tariff, { fetchedAt: ctx.fetchedAt, point });
      if (offer !== undefined) out.offers.push(offer);
    }
  }
  out.rejected = rejected;
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
 * of a connector the index does not hold is rejected.
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
    const status = STATES[text(row["ConnectorStatus"]) ?? ""];
    if (status === undefined) continue;
    const at = instantIn(ZONE, row["LastUpdateTime"]);
    if (!statusIsLive(at, ctx.fetchedAt)) continue;
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
