import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, AUTHENTICATION_METHODS } from "@openconditions/model";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import {
  type ConnectorInput,
  type EvseInput,
  emi3Of,
  type Lifecycle,
  type ParkingType,
  type PowerType,
  type SiteInput,
  siteDraft,
} from "../site.js";
import { isRecord, placeAt, type Raw, text } from "./raw.js";

/** NOBIL attribute type ids that the records are read by. */
const ATTR = {
  accessibility: "1",
  availability: "2",
  location: "3",
  connector: "4",
  capacity: "5",
  reservable: "18",
  open24h: "24",
  fixedCable: "25",
  evseUid: "27",
  evseId: "28",
} as const;

interface Plug {
  standard: string;
  /** Always a socket or always a cable, whatever "Fixed cable" says. */
  format?: "socket" | "cable";
  /** Whether the capacity rating is this plug's own. */
  rated: boolean;
  powerType?: PowerType;
}

/** NOBIL's connector values (attribute 4) by value id. */
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

/** Hydrogen and biogas points are not charge points. */
const NOT_CHARGING = new Set(["70", "82"]);

const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  public: "public",
  visitors: "customers",
  employees: "restricted",
  "by appointment": "restricted",
  residents: "private",
};

const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number]>> = {
  open: "none",
  rfid: "rfid",
  "cellular phone": "app",
};

const PARKING: Readonly<Record<string, ParkingType>> = {
  street: "on_street",
  "car park": "parking_lot",
};

const LANGUAGES: Readonly<Record<string, string>> = { nor: "no", swe: "sv" };

/** `"(59.87447,10.49982)"` as `[lon, lat]`. */
function pointOf(value: unknown): [number, number] | undefined {
  const m = (text(value) ?? "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  return m?.[1] === undefined || m[2] === undefined
    ? undefined
    : placeAt(Number(m[1]), Number(m[2]));
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
  const attr = attrs[id];
  return isRecord(attr) ? attr : undefined;
};
/** The translated value of an attribute, else its free value. */
const attributeText = (attrs: Raw, id: string): string | undefined => {
  const attr = attrOf(attrs, id);
  return text(attr?.["trans"]) ?? text(attr?.["attrval"]);
};

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
 * "230V 1-phase max 16A": the kilowatts when written, else volts times amps
 * times phases.
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
  const derived =
    volts !== undefined && amps !== undefined
      ? Math.round(volts * amps * (phases === 3 ? 3 : 1)) / 1000
      : undefined;
  const power = written ?? derived;
  return {
    ...(powerType === undefined ? {} : { powerType }),
    ...(power === undefined ? {} : { maxPowerKw: power }),
    ...(volts === undefined ? {} : { maxVoltage: volts }),
    ...(amps === undefined ? {} : { maxAmperage: amps }),
  };
}

function evseOf(index: string, attrs: Raw): EvseInput | undefined {
  const valueId = text(attrOf(attrs, ATTR.connector)?.["attrvalid"]);
  if (valueId !== undefined && NOT_CHARGING.has(valueId)) return undefined;
  const plugs = (valueId === undefined ? undefined : PLUGS[valueId]) ?? [
    { standard: "UNKNOWN", rated: true },
  ];
  const fixed = attributeText(attrs, ATTR.fixedCable)?.toLowerCase();
  const capacity = capacityOf(attributeText(attrs, ATTR.capacity));
  const uid = text(attrOf(attrs, ATTR.evseUid)?.["attrval"]);
  const evseId = emi3Of(text(attrOf(attrs, ATTR.evseId)?.["attrval"]));
  const connectors: ConnectorInput[] = plugs.map((plug, i) => {
    const format =
      plug.format ?? (fixed === "yes" ? "cable" : fixed === "no" ? "socket" : undefined);
    const own = plug.rated ? capacity : {};
    const powerType = plug.powerType ?? own.powerType;
    return {
      id: String(i + 1),
      standard: plug.standard,
      ...(format === undefined ? {} : { format }),
      ...(powerType === undefined ? (plug.rated ? {} : { current: "ac" as const }) : { powerType }),
      ...(own.maxVoltage === undefined ? {} : { maxVoltage: own.maxVoltage }),
      ...(own.maxAmperage === undefined ? {} : { maxAmperage: own.maxAmperage }),
      ...(own.maxPowerKw === undefined ? {} : { maxPowerKw: own.maxPowerKw }),
    };
  });
  return {
    key: uid ?? evseId ?? index,
    ...(uid === undefined ? {} : { uid }),
    ...(evseId === undefined ? {} : { evseId }),
    ...(attributeText(attrs, ATTR.reservable)?.toLowerCase() === "yes"
      ? { capabilities: ["RESERVABLE"] }
      : {}),
    connectors,
  };
}

function lifecycleOf(csmd: Raw): Lifecycle {
  if (csmd["Active"] === false) return "decommissioned";
  return text(csmd["Station_status"]) === "1" ? "operational" : "unknown";
}

function siteOf(csmd: Raw, attr: Raw, stationId: string, point: [number, number]): SiteInput {
  const st = isRecord(attr["st"]) ? attr["st"] : {};
  const entries = entriesOf(attr["conn"]);
  const evses = entries.flatMap(({ index, attrs }) => {
    const evse = evseOf(index, attrs);
    return evse === undefined ? [] : [evse];
  });
  const countryCode = (text(csmd["Land_code"]) ?? "").toLowerCase();
  const audience = AUDIENCE[attributeText(st, ATTR.availability)?.toLowerCase() ?? ""];
  const parkingType = PARKING[attributeText(st, ATTR.location)?.toLowerCase() ?? ""];
  const authentication = entries.flatMap(({ attrs }) => {
    const method = AUTHENTICATION[attributeText(attrs, ATTR.accessibility)?.toLowerCase() ?? ""];
    return method === undefined ? [] : [method];
  });
  const owner = text(csmd["Owned_by"]);
  return {
    stationId,
    point,
    lang: LANGUAGES[countryCode] ?? "und",
    name: text(csmd["name"]),
    ...(owner === undefined ? {} : { owner: { name: owner } }),
    website: text(csmd["url"]),
    notes: text(csmd["Description_of_location"]),
    address: {
      street: text(csmd["Street"]),
      houseNumber: text(csmd["House_number"]),
      postalCode: text(csmd["Zipcode"]),
      city: text(csmd["City"]),
      country: text(csmd["Land_code"]),
    },
    lifecycle: lifecycleOf(csmd),
    ...(attributeText(st, ATTR.open24h)?.toLowerCase() === "yes" ? { twentyFourSeven: true } : {}),
    ...(audience === undefined ? {} : { audience }),
    ...(authentication.length === 0 ? {} : { authentication }),
    ...(parkingType === undefined ? {} : { parkingType }),
    evses,
  };
}

/**
 * The NOBIL data export: `chargerstations`, each with `csmd` (the station),
 * and `attr.st` (the station's attributes) and `attr.conn` (a connector's, or
 * a map of connectors by index). One EVSE per connector entry; a station's
 * advertised point count is not turned into points the record does not
 * describe. NOBIL publishes the station's status as a register state.
 */
export function parseNobil(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const docs = Array.isArray(doc) ? doc : [doc];
    const stations = docs.flatMap((d) =>
      isRecord(d) && Array.isArray(d["chargerstations"]) ? d["chargerstations"] : [],
    );
    for (const station of stations.filter(isRecord)) {
      const csmd = isRecord(station["csmd"]) ? station["csmd"] : undefined;
      const attr = isRecord(station["attr"]) ? station["attr"] : {};
      const id = text(csmd?.["International_id"]) ?? text(csmd?.["id"]);
      const point = pointOf(csmd?.["Position"]);
      if (csmd === undefined || id === undefined || point === undefined || seen.has(id)) {
        rejected++;
        continue;
      }
      seen.add(id);
      out.features.push(siteDraft(feed, siteOf(csmd, attr, id, point), ctx.fetchedAt));
    }
  }
  out.rejected = rejected;
  return out;
}
