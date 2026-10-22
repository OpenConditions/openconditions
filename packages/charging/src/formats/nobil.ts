import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, AUTHENTICATION_METHODS, PAYMENT_METHODS } from "@openconditions/model";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { own } from "../records.js";
import {
  type ChargingMode,
  type ConnectorInput,
  type EvseInput,
  emi3Of,
  type Lifecycle,
  type ParkingType,
  type PowerType,
  type SiteInput,
  siteDraft,
} from "../site.js";
import { isRecord, placeAt, positiveNumber, type Raw, text, unplacedReason } from "./raw.js";

/** NOBIL attribute type ids that the records are read by. */
const ATTR = {
  accessibility: "1",
  availability: "2",
  location: "3",
  connector: "4",
  capacity: "5",
  voltage: "12",
  reservable: "18",
  payment: "19",
  chargeMode: "20",
  realTime: "21",
  manufacturer: "23",
  open24h: "24",
  fixedCable: "25",
  energyCarrier: "26",
  evseUid: "27",
  evseId: "28",
  connectorId: "29",
  amperage: "31",
} as const;

/** Counts an attribute value NOBIL does not list. */
type Unread = () => void;

interface Plug {
  standard: string;
  /** Always a socket or always a cable, whatever "Fixed cable" says. */
  format?: "socket" | "cable";
  /** Whether the capacity rating is this plug's own. */
  rated: boolean;
  powerType?: PowerType;
}

/**
 * NOBIL's connector values (attribute 4) by value id. Schuko (14) is no
 * longer in the attribute list but is the documentation's own example.
 */
const PLUGS: Readonly<Record<string, Plug[]>> = {
  "14": [{ standard: "DOMESTIC_F", format: "socket", rated: true }],
  "31": [{ standard: "IEC_62196_T1", rated: true }],
  "32": [{ standard: "IEC_62196_T2", rated: true }],
  "30": [{ standard: "CHADEMO", format: "cable", rated: true, powerType: "DC" }],
  "39": [{ standard: "IEC_62196_T2_COMBO", format: "cable", rated: true, powerType: "DC" }],
  "40": [{ standard: "TESLA_S", format: "cable", rated: true }],
  "87": [{ standard: "MCS", format: "cable", rated: true, powerType: "DC" }],
  "0": [{ standard: "UNKNOWN", rated: true }],
  // One outlet with both sockets; the rating is the Type 2's.
  "50": [
    { standard: "IEC_62196_T2", rated: true },
    { standard: "DOMESTIC_F", format: "socket", rated: false },
  ],
  "60": [
    { standard: "IEC_62196_T1", rated: true },
    { standard: "IEC_62196_T2", rated: true },
  ],
};

/** Hydrogen and biogas points (connectors 70 and 82, energy carriers 2 and 3) are not charge points. */
const NOT_CHARGING = new Set(["70", "82"]);
const ENERGY_CARRIERS: Readonly<Record<string, boolean>> = { "1": true, "2": false, "3": false };

/**
 * Charging capacity values (attribute 5) by value id, as NOBIL labels them.
 * The pressures and gases (26, 27, 34, 35) are hydrogen's and biogas's.
 */
const CAPACITIES: Readonly<Record<string, string | null>> = {
  "0": null,
  "7": "3,6 kW - 230V 1-phase max 16A",
  "8": "7,4 kW - 230V 1-phase max 32A",
  "10": "11 kW - 400V 3-phase max 16A",
  "11": "22 kW - 400V 3-phase max 32A",
  "12": "43 kW - 400V 3-phase max 63A",
  "13": "50 kW - 500VDC max 100A",
  "16": "230V 3-phase max 16A",
  "17": "230V 3-phase max 32A",
  "18": "230V 3-phase max 63A",
  "19": "20 kW - 500VDC max 50A",
  "22": "135 kW - 480VDC max 270A",
  "23": "100 kW - 500VDC max 200A",
  "26": null,
  "27": null,
  "34": null,
  "35": null,
  ...Object.fromEntries(
    [
      ["37", 30],
      ["38", 62.5],
      ["29", 75],
      ["24", 150],
      ["41", 175],
      ["42", 180],
      ["32", 200],
      ["30", 225],
      ["31", 250],
      ["33", 300],
      ["46", 320],
      ["25", 350],
      ["36", 400],
      ["39", 500],
      ["43", 600],
      ["44", 700],
      ["45", 800],
      ["47", 900],
      ["48", 1000],
      ["49", 1100],
      ["50", 1200],
      ["51", 1300],
      ["52", 1400],
      ["53", 1500],
    ].map(([id, kw]) => [id, `${kw} kW DC`]),
  ),
};

/**
 * Availability (attribute 2): visitors are a place's customers; a station
 * for employees or residents is theirs, which its charge points' parking
 * restriction says too.
 */
const AVAILABILITY: Readonly<
  Record<string, { audience: (typeof AUDIENCES)[number]; restriction?: string }>
> = {
  "1": { audience: "public" },
  "2": { audience: "customers" },
  "3": { audience: "restricted", restriction: "employees" },
  "4": { audience: "restricted" },
  "5": { audience: "private", restriction: "tenants" },
};

/**
 * Accessibility (attribute 1), how a driver starts charging: open, by RFID or
 * by phone. A standard key, "other" and "payment" name no method the model
 * holds.
 */
const ACCESSIBILITY: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number] | null>> = {
  "1": "none",
  "2": null,
  "3": null,
  "4": "rfid",
  "5": null,
  "6": "app",
};

/**
 * Payment method (attribute 19): a phone pays by app, a bank card by card, a
 * charging card is an RFID card, and miscellaneous is another means.
 */
const PAYMENT: Readonly<Record<string, (typeof PAYMENT_METHODS)[number][]>> = {
  "1": ["app"],
  "2": ["credit_card", "debit_card"],
  "10": ["other"],
  "20": ["app", "rfid"],
  "21": ["credit_card", "debit_card", "rfid"],
  "25": ["credit_card", "debit_card", "rfid", "app"],
};

/** Location (attribute 3): where vehicles stand, or the place the station belongs to. */
const LOCATION: Readonly<Record<string, { parking?: ParkingType; amenities?: string[] }>> = {
  "1": { parking: "on_street" },
  "2": { parking: "parking_lot" },
  "3": { amenities: ["airport"] },
  "4": { amenities: ["mall"] },
  "5": { amenities: ["public_transport_hub"] },
  "6": { amenities: ["hotel", "restaurant"] },
  "7": { amenities: ["petrol_station"] },
};

const CHARGE_MODES: Readonly<Record<string, ChargingMode>> = {
  "1": "mode1",
  "2": "mode2",
  "3": "mode3",
  "4": "mode4",
};

/** The yes and no of NOBIL's boolean attributes (6, 7, 18, 21, 24, 25). */
const YES_NO: Readonly<Record<string, boolean>> = { "1": true, "2": false };

const LANGUAGES: Readonly<Record<string, string>> = { nor: "no", swe: "sv" };

/** `"(59.87447,10.49982)"` as `[lon, lat]`. */
function pointOf(value: unknown): [number, number] | undefined {
  const m = (text(value) ?? "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  return m?.[1] === undefined || m[2] === undefined
    ? undefined
    : placeAt(Number(m[1]), Number(m[2]));
}

/** Why `pointOf` placed nothing: no position written, or an unreadable one. */
function unplacedOf(value: unknown): "no_geometry" | "malformed" {
  const t = text(value);
  if (t === undefined) return "no_geometry";
  const [lat, lon] = t.replace(/[()\s]/g, "").split(",");
  return unplacedReason(lat, lon);
}

const isAttribute = (value: unknown): value is Raw => isRecord(value) && "attrtypeid" in value;

/**
 * A station's connector entries: the attribute maps by connector index, or,
 * as the documentation's example writes a single connector, the attribute map
 * itself.
 */
function entriesOf(conn: unknown): { index: string; attrs: Raw }[] {
  if (!isRecord(conn)) return [];
  if (Object.values(conn).some(isAttribute)) return [{ index: "1", attrs: conn }];
  return Object.entries(conn).flatMap(([index, attrs]) =>
    isRecord(attrs) ? [{ index, attrs }] : [],
  );
}

const attrOf = (attrs: Raw, id: string): Raw | undefined => {
  const attr = own(attrs, id);
  return isRecord(attr) ? attr : undefined;
};
/** An attribute's value id, which NOBIL's value lists are keyed by. */
const valueId = (attrs: Raw, id: string): string | undefined =>
  text(attrOf(attrs, id)?.["attrvalid"]);
/** A free attribute's value (an id, a manufacturer, a number). */
const freeValue = (attrs: Raw, id: string): string | undefined =>
  text(attrOf(attrs, id)?.["attrval"]);

/** An attribute's entry of a value table, its value id counted when NOBIL does not list it. */
function valued<T>(
  attrs: Raw,
  id: string,
  table: Readonly<Record<string, T>>,
  unread: Unread,
): T | undefined {
  const code = valueId(attrs, id);
  const value = own(table, code);
  if (code !== undefined && value === undefined) unread();
  return value;
}

interface Capacity {
  powerType?: PowerType;
  maxPowerKw?: number;
  maxVoltage?: number;
  maxAmperage?: number;
}

const RATING = /(\d+)\s*V\s*(DC)?\s*(?:(\d)-phase)?\s*max\s*(\d+)\s*A/i;
const KILOWATTS = /(\d+(?:[.,]\d+)?)\s*kW/i;

/**
 * "22 kW - 400V 3-phase max 32A", "50 kW - 500VDC max 100A", "30 kW DC" and
 * "230V 3-phase max 16A": the kilowatts when written, else derived from the
 * rating. 230 V three-phase is Norway's IT grid, 230 V between the phases,
 * so its power is √3 times volts times amps; one phase is volts times amps.
 */
function capacityOf(label: string | undefined): Capacity {
  if (label === undefined) return {};
  const rating = label.match(RATING);
  const kw = label.match(KILOWATTS)?.[1];
  const dc = /DC/i.test(label);
  const phases = rating?.[3] === undefined ? undefined : Number(rating[3]);
  const volts = rating?.[1] === undefined ? undefined : Number(rating[1]);
  const amps = rating?.[4] === undefined ? undefined : Number(rating[4]);
  const powerType: PowerType | undefined = dc
    ? "DC"
    : phases === 1
      ? "AC_1_PHASE"
      : phases === 3
        ? "AC_3_PHASE"
        : undefined;
  const written = kw === undefined ? undefined : Number(kw.replace(",", "."));
  const factor = phases === 3 ? (volts === 230 ? Math.sqrt(3) : 3) : 1;
  const derived =
    volts !== undefined && amps !== undefined
      ? Math.round(volts * amps * factor) / 1000
      : undefined;
  const power = written ?? derived;
  return {
    ...(powerType === undefined ? {} : { powerType }),
    ...(power === undefined ? {} : { maxPowerKw: power }),
    ...(volts === undefined ? {} : { maxVoltage: volts }),
    ...(amps === undefined ? {} : { maxAmperage: amps }),
  };
}

/**
 * The capacity a connector entry states: its value id's label, else, without
 * one, the label as written; the free voltage and amperage attributes fill
 * what the label leaves open.
 */
function entryCapacity(attrs: Raw, unread: Unread): Capacity {
  const code = valueId(attrs, ATTR.capacity);
  const label =
    code === undefined
      ? text(attrOf(attrs, ATTR.capacity)?.["trans"])
      : (valued(attrs, ATTR.capacity, CAPACITIES, unread) ?? undefined);
  const capacity = capacityOf(label);
  const volts = positiveNumber(freeValue(attrs, ATTR.voltage));
  const amps = positiveNumber(freeValue(attrs, ATTR.amperage));
  return {
    ...capacity,
    ...(capacity.maxVoltage === undefined && volts !== undefined ? { maxVoltage: volts } : {}),
    ...(capacity.maxAmperage === undefined && amps !== undefined ? { maxAmperage: amps } : {}),
  };
}

/**
 * A connector entry's charge point; a value NOBIL does not list is left
 * unread and counted. A hydrogen or biogas entry is none.
 */
function evseOf(index: string, attrs: Raw, unread: Unread): EvseInput | undefined {
  const connectorId = valueId(attrs, ATTR.connector);
  if (connectorId !== undefined && NOT_CHARGING.has(connectorId)) return undefined;
  if (valued(attrs, ATTR.energyCarrier, ENERGY_CARRIERS, unread) === false) return undefined;
  const known = own(PLUGS, connectorId);
  if (connectorId !== undefined && known === undefined) unread();
  const plugs = known ?? [{ standard: "UNKNOWN", rated: true }];
  const fixed = valued(attrs, ATTR.fixedCable, YES_NO, unread);
  const capacity = entryCapacity(attrs, unread);
  const mode = valued(attrs, ATTR.chargeMode, CHARGE_MODES, unread);
  const uid = freeValue(attrs, ATTR.evseUid);
  const evseId = emi3Of(freeValue(attrs, ATTR.evseId));
  const plugId = freeValue(attrs, ATTR.connectorId);
  const manufacturer = freeValue(attrs, ATTR.manufacturer);
  const reservable = valued(attrs, ATTR.reservable, YES_NO, unread);
  const connectors: ConnectorInput[] = plugs.map((plug, i) => {
    const format =
      plug.format ?? (fixed === true ? "cable" : fixed === false ? "socket" : undefined);
    const rated = plug.rated ? capacity : {};
    const powerType = plug.powerType ?? rated.powerType;
    return {
      id: plugs.length === 1 && plugId !== undefined ? plugId : String(i + 1),
      standard: plug.standard,
      ...(format === undefined ? {} : { format }),
      ...(powerType === undefined ? (plug.rated ? {} : { current: "ac" as const }) : { powerType }),
      ...(rated.maxVoltage === undefined ? {} : { maxVoltage: rated.maxVoltage }),
      ...(rated.maxAmperage === undefined ? {} : { maxAmperage: rated.maxAmperage }),
      ...(rated.maxPowerKw === undefined ? {} : { maxPowerKw: rated.maxPowerKw }),
      ...(mode === undefined || !plug.rated ? {} : { chargingModes: [mode] }),
    };
  });
  return {
    key: uid ?? evseId ?? index,
    ...(uid === undefined ? {} : { uid }),
    ...(evseId === undefined ? {} : { evseId }),
    ...(reservable === true ? { capabilities: ["RESERVABLE"] } : {}),
    ...(manufacturer === undefined ? {} : { manufacturer }),
    connectors,
  };
}

/** `Station_status` 1 is a station in operation; NOBIL documents no other value. */
function lifecycleOf(csmd: Raw, unread: Unread): Lifecycle {
  if (csmd["Active"] === false) return "decommissioned";
  const status = text(csmd["Station_status"]);
  if (status === "1") return "operational";
  if (status !== undefined) unread();
  return "unknown";
}

/** NOBIL hosts a station's photo by its file name. */
const IMAGES = "https://nobil.no/img/ladestasjonbilder/";

/** A UTF-16 surrogate without its pair, which no URL can encode. */
const UNPAIRED_SURROGATE = /\p{Surrogate}/u;

function siteOf(
  csmd: Raw,
  attr: Raw,
  stationId: string,
  point: [number, number],
  unread: Unread,
): SiteInput {
  const st = isRecord(attr["st"]) ? attr["st"] : {};
  const entries = entriesOf(attr["conn"]);
  const availability = valued(st, ATTR.availability, AVAILABILITY, unread);
  const evses = entries.flatMap(({ index, attrs }) => {
    const evse = evseOf(index, attrs, unread);
    if (evse === undefined) return [];
    return availability?.restriction === undefined
      ? [evse]
      : [{ ...evse, parkingRestrictions: [availability.restriction] }];
  });
  const countryCode = (text(csmd["Land_code"]) ?? "").toLowerCase();
  const lang = own(LANGUAGES, countryCode) ?? "und";
  const location = valued(st, ATTR.location, LOCATION, unread);
  const authentication = entries.flatMap(
    ({ attrs }) => valued(attrs, ATTR.accessibility, ACCESSIBILITY, unread) ?? [],
  );
  const payment = entries.flatMap(
    ({ attrs }) => valued(attrs, ATTR.payment, PAYMENT, unread) ?? [],
  );
  const open24h = valued(st, ATTR.open24h, YES_NO, unread);
  const realTime = valued(st, ATTR.realTime, YES_NO, unread);
  const owner = text(csmd["Owned_by"]);
  let image = text(csmd["Image"]);
  if (image !== undefined && UNPAIRED_SURROGATE.test(image)) {
    unread();
    image = undefined;
  }
  const directions = text(csmd["Description_of_location"]);
  return {
    stationId,
    point,
    lang,
    name: text(csmd["name"]),
    ...(owner === undefined ? {} : { owner: { name: owner } }),
    website: text(csmd["url"]),
    ...(directions === undefined ? {} : { directions: [{ lang, text: directions }] }),
    notes: text(csmd["User_comment"]),
    address: {
      street: text(csmd["Street"]),
      houseNumber: text(csmd["House_number"]),
      postalCode: text(csmd["Zipcode"]),
      city: text(csmd["City"]),
      region: text(csmd["County"]),
      country: text(csmd["Land_code"]),
    },
    lifecycle: lifecycleOf(csmd, unread),
    ...(open24h === true ? { twentyFourSeven: true } : {}),
    ...(realTime === undefined ? {} : { dynamicInfoAvailable: realTime ? "true" : "false" }),
    ...(availability === undefined ? {} : { audience: availability.audience }),
    ...(authentication.length === 0 ? {} : { authentication }),
    ...(payment.length === 0 ? {} : { payment }),
    ...(location?.parking === undefined ? {} : { parkingType: location.parking }),
    ...(location?.amenities === undefined ? {} : { amenities: location.amenities }),
    ...(image === undefined
      ? {}
      : { images: [{ url: `${IMAGES}${encodeURIComponent(image)}`, category: "site" as const }] }),
    evses,
  };
}

/**
 * The NOBIL data export: `chargerstations`, each with `csmd` (the station),
 * and `attr.st` (the station's attributes) and `attr.conn` (a connector's, or
 * a map of connectors by index). Attributes are read by their value ids, the
 * lists NOBIL publishes for each attribute type. One EVSE per connector
 * entry; a station's advertised point count is not turned into points the
 * record does not describe. NOBIL publishes the station's status as a
 * register state. A station without its `csmd` or an id, or listed again
 * under one, is malformed; one without a position, or with one that places
 * nothing, is counted as such; a value id NOBIL does not list is counted as
 * `unknown_value`.
 */
export function parseNobil(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  const unread = () => recordSkipped(feed.id, "unknown_value");
  for (const body of payloads["main"] ?? []) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const docs = Array.isArray(doc) ? doc : [doc];
    const stations = docs.flatMap((d) =>
      isRecord(d) && Array.isArray(d["chargerstations"]) ? d["chargerstations"] : [],
    );
    for (const station of stations) {
      const csmd = isRecord(station) && isRecord(station["csmd"]) ? station["csmd"] : undefined;
      const id = text(csmd?.["International_id"]) ?? text(csmd?.["id"]);
      if (csmd === undefined || id === undefined || seen.has(id)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const point = pointOf(csmd["Position"]);
      if (point === undefined) {
        recordSkipped(feed.id, unplacedOf(csmd["Position"]));
        continue;
      }
      const attr = isRecord(station["attr"]) ? station["attr"] : {};
      seen.add(id);
      out.features.push(siteDraft(feed, siteOf(csmd, attr, id, point, unread), ctx.fetchedAt));
    }
  }
  return out;
}
