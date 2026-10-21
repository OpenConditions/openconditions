import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, PAYMENT_METHODS } from "@openconditions/model";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { own } from "../records.js";
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
  /** NEMA codes name an outlet; every other connector is the charger's cable. */
  format: "socket" | "cable";
}

/**
 * AFDC's connector codes. `TESLA` is the Tesla plug, the NACS connector the
 * Society of Automotive Engineers standardised as J3400; `J3271` is "MCS
 * (J3271 DC)", the megawatt charging system. The NEMA codes name the outlet,
 * never a Schuko. NEMA 5-15 is OCPI's household type B.
 */
const PLUGS: Readonly<Record<string, Plug>> = {
  J1772: { standard: "IEC_62196_T1", current: "ac", format: "cable" },
  J1772COMBO: { standard: "IEC_62196_T1_COMBO", current: "dc", format: "cable" },
  CHADEMO: { standard: "CHADEMO", current: "dc", format: "cable" },
  TESLA: { standard: "SAE_J3400", format: "cable" },
  J3271: { standard: "MCS", current: "dc", format: "cable" },
  NEMA515: { standard: "DOMESTIC_B", current: "ac", format: "socket" },
  NEMA520: { standard: "NEMA_5_20", current: "ac", format: "socket" },
  NEMA630: { standard: "NEMA_6_30", current: "ac", format: "socket" },
  NEMA650: { standard: "NEMA_6_50", current: "ac", format: "socket" },
  NEMA1030: { standard: "NEMA_10_30", current: "ac", format: "socket" },
  NEMA1050: { standard: "NEMA_10_50", current: "ac", format: "socket" },
  NEMA1430: { standard: "NEMA_14_30", current: "ac", format: "socket" },
  NEMA1450: { standard: "NEMA_14_50", current: "ac", format: "socket" },
};

const LIFECYCLES: Readonly<Record<string, Lifecycle>> = {
  E: "operational",
  P: "planned",
  T: "temporarily_closed",
};

/**
 * `facility_type`: where vehicles stand, for the parking facilities (paid or
 * not), and the venue a station belongs to as an amenity of it. The other
 * venues (offices, schools, government sites, fleet garages) name nothing the
 * site offers a driver.
 */
const FACILITIES: Readonly<Record<string, { parking?: ParkingType; amenity?: string }>> = {
  PARKING_GARAGE: { parking: "parking_garage" },
  PAY_GARAGE: { parking: "parking_garage" },
  PARKING_LOT: { parking: "parking_lot" },
  PAY_LOT: { parking: "parking_lot" },
  STREET_PARKING: { parking: "on_street" },
  RV_PARK: { parking: "parking_lot" },
  AIRPORT: { amenity: "airport" },
  AUTO_REPAIR: { amenity: "vehicle_maintenance" },
  B_AND_B: { amenity: "overnight_accommodation" },
  CAMPGROUND: { amenity: "overnight_accommodation" },
  CARWASH: { amenity: "car_wash" },
  CONVENIENCE_STORE: { amenity: "shop" },
  GAS_STATION: { amenity: "petrol_station" },
  GROCERY: { amenity: "supermarket" },
  HARDWARE_STORE: { amenity: "shop" },
  HOSPITAL: { amenity: "medical_facility" },
  HOTEL: { amenity: "hotel" },
  INN: { amenity: "overnight_accommodation" },
  MUSEUM: { amenity: "museum" },
  NATL_PARK: { amenity: "nature" },
  PARK: { amenity: "recreation_area" },
  PHARMACY: { amenity: "pharmacy" },
  REC_SPORTS_FACILITY: { amenity: "sport" },
  RENTAL_CAR_RETURN: { amenity: "car_rental" },
  RESTAURANT: { amenity: "restaurant" },
  RETAIL: { amenity: "shop" },
  SHOPPING_CENTER: { amenity: "mall" },
  SHOPPING_MALL: { amenity: "mall" },
  ...Object.fromEntries(
    [
      "ARENA",
      "BANK",
      "BREWERY_DISTILLERY_WINERY",
      "CAR_DEALER",
      "COLLEGE_CAMPUS",
      "CONVENTION_CENTER",
      "COOP",
      "FACTORY",
      "FED_GOV",
      "FIRE_STATION",
      "FLEET_GARAGE",
      "FUEL_RESELLER",
      "LIBRARY",
      "MIL_BASE",
      "MOTOR_POOL",
      "MULTI_UNIT_DWELLING",
      "MUNI_GOV",
      "OFFICE_BLDG",
      "OTHER",
      "OTHER_ENTERTAINMENT",
      "PLACE_OF_WORSHIP",
      "PRISON",
      "PRIVATE",
      "PUBLIC",
      "REFINERY",
      "RESEARCH_FACILITY",
      "REST_STOP",
      "SCHOOL",
      "STADIUM",
      "STANDALONE_STATION",
      "STATE_GOV",
      "STORAGE",
      "TNC",
      "TRAVEL_CENTER",
      "TRUCK_STOP",
      "UTILITY",
      "WORKPLACE",
    ].map((code) => [code, {}]),
  ),
};

/**
 * `cards_accepted`: the card brands are credit cards, the phone wallets
 * contactless payment; checks, account balances and the fleet cards are
 * means of payment the model names no further.
 */
const CARDS: Readonly<Record<string, (typeof PAYMENT_METHODS)[number]>> = {
  A: "credit_card",
  CREDIT: "credit_card",
  D: "credit_card",
  M: "credit_card",
  V: "credit_card",
  Debit: "debit_card",
  Cash: "cash",
  APPLE_PAY: "contactless",
  ANDROID_PAY: "contactless",
  ...Object.fromEntries(
    [
      "Checks",
      "ACCOUNT_BALANCE",
      "ALLIANCE",
      "ARI",
      "CleanEnergy",
      "Comdata",
      "CFN",
      "EFS",
      "FleetOne",
      "FuelMan",
      "GasCard",
      "PacificPride",
      "PHH",
      "Proprietor",
      "Speedway",
      "SuperPass",
      "TCH",
      "Tchek",
      "Trillium",
      "Voyager",
      "Wright_Exp",
    ].map((code) => [code, "other" as const]),
  ),
};

/**
 * `access_detail_code`: fleet or government only is a restricted station,
 * a residential one private; a credit card at all times or after hours is a
 * means of payment. Calling ahead, a card key and limited hours say nothing
 * the model holds.
 */
const ACCESS_DETAILS: Readonly<
  Record<string, { audience?: (typeof AUDIENCES)[number]; payment?: "credit_card" }>
> = {
  CALL: {},
  KEY_AFTER_HOURS: {},
  KEY_ALWAYS: {},
  CREDIT_CARD_AFTER_HOURS: { payment: "credit_card" },
  CREDIT_CARD_ALWAYS: { payment: "credit_card" },
  FLEET: { audience: "restricted" },
  GOVERNMENT: { audience: "restricted" },
  LIMITED_HOURS: {},
  RESIDENTIAL: { audience: "private" },
};

const ACCESS: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  public: "public",
  private: "private",
};

const LEVELS: Readonly<Record<string, "ac" | "dc">> = { "1": "ac", "2": "ac", dc_fast: "dc" };

/** A connector of one AFDC code; a code AFDC does not list is left unread and counted. */
function connectorOf(
  feedId: string,
  code: string,
  kw: number | undefined,
  level: string | undefined,
) {
  const plug = own(PLUGS, code);
  if (plug === undefined) recordSkipped(feedId, "unknown_value");
  // Level 1 and 2 are AC, DC fast is DC.
  const fromLevel = own(LEVELS, level);
  if (level !== undefined && fromLevel === undefined) recordSkipped(feedId, "unknown_value");
  const current = fromLevel ?? plug?.current;
  return {
    id: code,
    standard: plug?.standard ?? "UNKNOWN",
    ...(plug === undefined ? {} : { format: plug.format }),
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

/** A network of the electric networks list: its name and web page. */
interface Network {
  name?: string;
  url?: string;
}

/** The electric networks list (`electric-networks.json`) by network key. */
function networksOf(bodies: readonly Buffer[]): Map<string, Network> {
  const networks = new Map<string, Network>();
  for (const body of bodies) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    for (const entry of Array.isArray(doc) ? doc.filter(isRecord) : []) {
      const key = text(entry["key"]);
      const name = text(entry["name"]);
      const url = text(entry["url"]);
      if (key !== undefined) {
        networks.set(key, {
          ...(name === undefined ? {} : { name }),
          ...(url === undefined ? {} : { url }),
        });
      }
    }
  }
  return networks;
}

/** A code of a table, counted when AFDC does not list it. */
function coded<T>(feedId: string, table: Readonly<Record<string, T>>, code: string | undefined) {
  const value = own(table, code);
  if (code !== undefined && value === undefined) recordSkipped(feedId, "unknown_value");
  return value;
}

function siteOf(
  feedId: string,
  station: Raw,
  stationId: string,
  point: [number, number],
  networks: ReadonlyMap<string, Network>,
): SiteInput {
  const networkKey = text(station["ev_network"]);
  const network = networkKey === undefined ? undefined : networks.get(networkKey);
  const facility = coded(feedId, FACILITIES, text(station["facility_type"]));
  const hours = text(station["access_days_time"]);
  const units = Array.isArray(station["ev_charging_units"]) ? station["ev_charging_units"] : [];
  const fromUnits = unitsOf(feedId, units);
  const status = text(station["status_code"]);
  const lifecycle = coded(feedId, LIFECYCLES, status);
  const around24h = hours !== undefined && /^24 hours daily\.?$/i.test(hours);
  const detail = coded(feedId, ACCESS_DETAILS, text(station["access_detail_code"]));
  // A station "reserved for patrons of a business" is for its customers.
  const audience =
    detail?.audience ??
    (station["restricted_access"] === true
      ? "customers"
      : coded(feedId, ACCESS, text(station["access_code"])));
  const cards = (text(station["cards_accepted"]) ?? "")
    .split(/\s+/)
    .filter((c) => c !== "")
    .flatMap((c) => coded(feedId, CARDS, c) ?? []);
  const payment = [...cards, ...(detail?.payment === undefined ? [] : [detail.payment])];
  const zip = text(station["zip"]);
  const plus4 = text(station["plus4"]);
  const directions = [
    ["en", text(station["intersection_directions"])],
    ["fr", text(station["intersection_directions_fr"])],
  ].flatMap(([lang, t]) => (t === undefined ? [] : [{ lang: lang as string, text: t }]));
  const agency = isRecord(station["federal_agency"])
    ? text(station["federal_agency"]["name"])
    : undefined;
  const networkIds = isRecord(station["ev_network_ids"]) ? station["ev_network_ids"] : {};
  const stationIds = Array.isArray(networkIds["station"])
    ? networkIds["station"].flatMap((id) => text(id) ?? [])
    : [];
  // An employer's station is "primarily used for employee charging".
  const workplace = station["ev_workplace_charging"] === true;
  const evses = (fromUnits.length > 0 ? fromUnits : typesOf(feedId, station)).map((evse) =>
    workplace ? { ...evse, parkingRestrictions: ["employees"] } : evse,
  );
  const website = text(station["ev_network_web"]) ?? network?.url;
  return {
    stationId,
    point,
    lang: "en",
    name: text(station["station_name"]),
    // "Non-Networked" says no network runs the station.
    ...(networkKey === undefined || /^non-networked$/i.test(networkKey)
      ? {}
      : {
          operator: {
            name: network?.name ?? networkKey,
            ...(website === undefined ? {} : { website }),
          },
        }),
    // The station's AFDC id, which OSM tags `ref:afdc`, and its network's own ids.
    externalIds: [
      { scheme: "afdc", id: stationId },
      ...(networkKey === undefined
        ? []
        : stationIds.map((id) => ({ scheme: "cpo", id, authority: networkKey }))),
    ],
    ...(agency === undefined ? {} : { owner: { name: agency } }),
    address: {
      street: text(station["street_address"]),
      city: text(station["city"]),
      region: text(station["state"]),
      postalCode: zip === undefined || plus4 === undefined ? zip : `${zip}-${plus4}`,
      country: text(station["country"]),
    },
    lifecycle: lifecycle ?? "unknown",
    ...(facility?.parking === undefined ? {} : { parkingType: facility.parking }),
    ...(facility?.amenity === undefined ? {} : { amenities: [facility.amenity] }),
    ...(audience === undefined ? {} : { audience }),
    ...(payment.length === 0 ? {} : { payment }),
    ...(around24h
      ? { twentyFourSeven: true }
      : hours === undefined
        ? {}
        : { openingHoursText: hours }),
    ...(text(station["station_phone"]) === undefined
      ? {}
      : { hotline: text(station["station_phone"]) }),
    ...(directions.length === 0 ? {} : { directions }),
    tariffText: text(station["ev_pricing"]),
    evses,
  };
}

/**
 * The Alternative Fuel Stations API, electric stations: `fuel_stations` of
 * one `v1.json` answer, the networks named by the electric networks list
 * (`networks`) where it is fetched, else by their keys. The register states each station's status code
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
  const networks = networksOf(payloads["networks"] ?? []);
  for (const body of payloads["main"] ?? []) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const stations =
      isRecord(doc) && Array.isArray(doc["fuel_stations"]) ? doc["fuel_stations"] : [];
    for (const station of stations) {
      if (!isRecord(station)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      // A station of another fuel is no charging site, but it is a record of the answer.
      if (station["fuel_type_code"] !== undefined && station["fuel_type_code"] !== "ELEC") {
        recordSkipped(feed.id, "unknown_type");
        continue;
      }
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
      out.features.push(
        siteDraft(feed, siteOf(feed.id, station, id, point, networks), ctx.fetchedAt),
      );
    }
  }
  return out;
}
