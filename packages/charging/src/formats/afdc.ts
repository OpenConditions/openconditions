import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import {
  type ConnectorInput,
  type EvseInput,
  type Lifecycle,
  type ParkingType,
  type SiteInput,
  siteDraft,
} from "../site.js";
import {
  isRecord,
  placeAt,
  positiveInteger,
  positiveNumber,
  type Raw,
  text,
  unplacedReason,
} from "./raw.js";

interface Plug {
  standard: string;
  /** The current the plug delivers on its own; Tesla and NACS plugs serve both. */
  current?: "ac" | "dc";
}

/**
 * AFDC's connector codes. `TESLA` is the Tesla plug, the NACS connector the
 * Society of Automotive Engineers standardised as J3400 (AFDC also writes it
 * `J3271`); the NEMA codes name the outlet, never a Schuko. NEMA 5-15 is
 * OCPI's household type B.
 */
const PLUGS: Readonly<Record<string, Plug>> = {
  J1772: { standard: "IEC_62196_T1", current: "ac" },
  J1772COMBO: { standard: "IEC_62196_T1_COMBO", current: "dc" },
  CHADEMO: { standard: "CHADEMO", current: "dc" },
  TESLA: { standard: "SAE_J3400" },
  J3271: { standard: "SAE_J3400" },
  NEMA515: { standard: "DOMESTIC_B", current: "ac" },
  NEMA520: { standard: "NEMA_5_20", current: "ac" },
  NEMA630: { standard: "NEMA_6_30", current: "ac" },
  NEMA650: { standard: "NEMA_6_50", current: "ac" },
  NEMA1030: { standard: "NEMA_10_30", current: "ac" },
  NEMA1050: { standard: "NEMA_10_50", current: "ac" },
  NEMA1430: { standard: "NEMA_14_30", current: "ac" },
  NEMA1450: { standard: "NEMA_14_50", current: "ac" },
};

const LIFECYCLES: Readonly<Record<string, Lifecycle>> = {
  E: "operational",
  P: "planned",
  T: "temporarily_closed",
};

const FACILITIES: Readonly<Record<string, ParkingType>> = {
  PARKING_GARAGE: "parking_garage",
  PARKING_LOT: "parking_lot",
  STREET_PARKING: "on_street",
  RV_PARK: "parking_lot",
  PUBLIC_GARAGE: "parking_garage",
};

/** The current the charging level names: Level 1 and 2 are AC, DC fast is DC. */
const levelCurrent = (level: string | undefined): "ac" | "dc" | undefined =>
  level === "1" || level === "2" ? "ac" : level === "dc_fast" ? "dc" : undefined;

/** A connector of one AFDC code; a code AFDC does not list is left unread and counted. */
function connectorOf(
  feedId: string,
  code: string,
  kw: number | undefined,
  level: string | undefined,
) {
  const plug = PLUGS[code];
  if (plug === undefined) recordSkipped(feedId, "unknown_value");
  const current = levelCurrent(level) ?? plug?.current;
  return {
    id: code,
    standard: plug?.standard ?? "UNKNOWN",
    ...(current === undefined ? {} : { current }),
    ...(kw === undefined ? {} : { maxPowerKw: kw }),
  } satisfies ConnectorInput;
}

/**
 * One EVSE per charging unit: a unit is one charge point, with a connector for
 * each type it lists (a CHAdeMO and a CCS cable on one point stay together).
 * A unit of several ports that all carry the one listed connector type is that
 * many identical charge points; a connector count above the unit's port count
 * is a count of cables, not of charge points.
 */
function unitsOf(feedId: string, units: unknown[]): EvseInput[] {
  const evses: EvseInput[] = [];
  units.filter(isRecord).forEach((unit, i) => {
    const connectors = isRecord(unit["connectors"]) ? unit["connectors"] : {};
    const level = text(unit["charging_level"]);
    const present = Object.entries(connectors).flatMap(([code, c]) => {
      const count = isRecord(c) ? (positiveInteger(c["port_count"]) ?? 0) : 0;
      return isRecord(c) && count > 0 ? [{ code, count, kw: positiveNumber(c["power_kw"]) }] : [];
    });
    if (present.length === 0) return;
    const ports = positiveInteger(unit["port_count"]);
    const only = present.length === 1 ? present[0] : undefined;
    const quantity =
      only !== undefined && ports !== undefined && ports >= 2 && only.count === ports
        ? ports
        : undefined;
    evses.push({
      key: `unit-${i + 1}`,
      ...(quantity === undefined ? {} : { quantity }),
      connectors: present.map((p) => connectorOf(feedId, p.code, p.kw, level)),
    });
  });
  return evses;
}

/**
 * Without charging units the listed connector types are all the record says:
 * one EVSE for each, and a count only where one type is every port.
 */
function typesOf(feedId: string, station: Raw): EvseInput[] {
  const types = Array.isArray(station["ev_connector_types"])
    ? station["ev_connector_types"].flatMap((t) => text(t) ?? [])
    : [];
  const levels = ["ev_level1_evse_num", "ev_level2_evse_num", "ev_dc_fast_num"]
    .map((field) => positiveInteger(station[field]))
    .filter((n) => n !== undefined);
  // One type is every port only where a single level has any, as a type may serve several levels.
  const ports = levels.length === 1 ? levels[0] : undefined;
  return types.map((code) => ({
    key: `type-${code}`,
    ...(types.length === 1 && ports !== undefined && ports >= 2 ? { quantity: ports } : {}),
    connectors: [connectorOf(feedId, code, undefined, undefined)],
  }));
}

function siteOf(
  feedId: string,
  station: Raw,
  stationId: string,
  point: [number, number],
): SiteInput {
  const network = text(station["ev_network"]);
  const facility = FACILITIES[text(station["facility_type"]) ?? ""];
  const hours = text(station["access_days_time"]);
  const units = Array.isArray(station["ev_charging_units"]) ? station["ev_charging_units"] : [];
  const fromUnits = unitsOf(feedId, units);
  const status = text(station["status_code"]);
  const lifecycle = status === undefined ? undefined : LIFECYCLES[status];
  if (status !== undefined && lifecycle === undefined) recordSkipped(feedId, "unknown_value");
  const around24h = hours !== undefined && /^24 hours daily\.?$/i.test(hours);
  return {
    stationId,
    point,
    lang: "en",
    name: text(station["station_name"]),
    // "Non-Networked" says no network runs the station.
    ...(network === undefined || /^non-networked$/i.test(network)
      ? {}
      : { operator: { name: network } }),
    website: text(station["ev_network_web"]),
    address: {
      street: text(station["street_address"]),
      city: text(station["city"]),
      postalCode: text(station["zip"]),
      country: text(station["country"]),
    },
    lifecycle: lifecycle ?? "unknown",
    ...(facility === undefined ? {} : { parkingType: facility }),
    ...(around24h
      ? { twentyFourSeven: true }
      : hours === undefined
        ? {}
        : { openingHoursText: hours }),
    tariffText: text(station["ev_pricing"]),
    evses: fromUnits.length > 0 ? fromUnits : typesOf(feedId, station),
  };
}

/**
 * The Alternative Fuel Stations API, electric stations: `fuel_stations` of
 * one `v1.json` answer. The register states each station's status code
 * (E, P, T) and no live state, so nothing is read as a reading. A station
 * without an id, or listed again under one, is malformed; one without a
 * position, or with one that places nothing, is counted as such.
 */
export function parseAfdc(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const stations =
      isRecord(doc) && Array.isArray(doc["fuel_stations"]) ? doc["fuel_stations"] : [];
    for (const station of stations) {
      if (!isRecord(station)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (station["fuel_type_code"] !== undefined && station["fuel_type_code"] !== "ELEC") continue;
      const id = text(station["id"]);
      if (id === undefined || seen.has(id)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      // A missing coordinate is not zero: Number(null) would place the station at the equator.
      const point = placeAt(
        Number(text(station["latitude"]) ?? Number.NaN),
        Number(text(station["longitude"]) ?? Number.NaN),
      );
      if (point === undefined) {
        recordSkipped(feed.id, unplacedReason(station["latitude"], station["longitude"]));
        continue;
      }
      seen.add(id);
      out.features.push(siteDraft(feed, siteOf(feed.id, station, id, point), ctx.fetchedAt));
    }
  }
  return out;
}
