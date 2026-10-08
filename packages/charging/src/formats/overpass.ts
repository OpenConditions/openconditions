import {
  decodeOverpass,
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
  parsePowerKw,
  type SiteInput,
  siteDraft,
} from "../site.js";

/** OSM text is in whatever language the mapper wrote it. */
const UNDETERMINED = "und";

interface Socket {
  standard: string;
  current: "ac" | "dc";
  format?: "socket" | "cable";
}

/** `socket:<type>` → the plug standard, its current, and whether it is a socket or a cable. */
const SOCKETS: Readonly<Record<string, Socket>> = {
  type2: { standard: "IEC_62196_T2", current: "ac", format: "socket" },
  type2_cable: { standard: "IEC_62196_T2", current: "ac", format: "cable" },
  type2_combo: { standard: "IEC_62196_T2_COMBO", current: "dc" },
  chademo: { standard: "CHADEMO", current: "dc" },
  type1: { standard: "IEC_62196_T1", current: "ac" },
  type1_combo: { standard: "IEC_62196_T1_COMBO", current: "dc" },
  tesla_supercharger: { standard: "TESLA_S", current: "dc" },
  tesla_supercharger_ccs: { standard: "IEC_62196_T2_COMBO", current: "dc" },
  nacs: { standard: "SAE_J3400", current: "dc" },
  schuko: { standard: "DOMESTIC_F", current: "ac", format: "socket" },
  typee: { standard: "DOMESTIC_E", current: "ac", format: "socket" },
  cee_blue: { standard: "IEC_60309_2_single_16", current: "ac", format: "socket" },
  cee_red_16a: { standard: "IEC_60309_2_three_16", current: "ac", format: "socket" },
  cee_red_32a: { standard: "IEC_60309_2_three_32", current: "ac", format: "socket" },
  gb_ac: { standard: "GBT_AC", current: "ac" },
  gb_dc: { standard: "GBT_DC", current: "dc" },
};

/** Household sockets: a station with only these serves e-bikes unless cars are named. */
const HOUSEHOLD = new Set(["schuko", "typee"]);

const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  yes: "public",
  permissive: "public",
  customers: "customers",
  permit: "permit",
  private: "private",
  no: "private",
  destination: "restricted",
  delivery: "restricted",
};

const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number]>> = {
  "authentication:none": "none",
  "authentication:app": "app",
  "authentication:membership_card": "rfid",
  "authentication:nfc": "nfc",
};

const tag = (tags: Record<string, string>, key: string): string | undefined => {
  const value = tags[key]?.trim();
  return value ? value : undefined;
};

const SOCKET_COUNT = /^socket:([a-z0-9_]+)$/;

/** The largest of a `;` list of powers with their units (`150kW;300kW`, `11000 W`). */
function outputKw(value: string | undefined): number | undefined {
  const powers = (value ?? "")
    .split(";")
    .map((p) => parsePowerKw(p))
    .filter((p) => p !== undefined);
  return powers.length === 0 ? undefined : Math.max(...powers);
}

/** A bare positive number (`400`, `32`); a value with words is left out. */
const amount = (value: string | undefined): number | undefined => {
  const n = value !== undefined && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
  return n > 0 ? n : undefined;
};

/** One EVSE per tagged socket type, standing for as many points as the count says. */
function evsesOf(tags: Record<string, string>): EvseInput[] {
  const ref = (tag(tags, "ref:EU:EVSE") ?? "")
    .split(";")
    .map((r) => emi3Of(r.trim()))
    .find((r) => r !== undefined);
  const evses: EvseInput[] = [];
  for (const key of Object.keys(tags)) {
    const type = key.match(SOCKET_COUNT)?.[1];
    const socket = type === undefined ? undefined : SOCKETS[type];
    if (type === undefined || socket === undefined) continue;
    const value = tag(tags, key);
    if (value === undefined || value === "no" || value === "0") continue;
    const count = /^\d+$/.test(value) ? Number(value) : undefined;
    const power = outputKw(tag(tags, `${key}:output`));
    const voltage = amount(tag(tags, `${key}:voltage`));
    const amperage = amount(tag(tags, `${key}:current`) ?? tag(tags, `${key}:amperage`));
    const connector: ConnectorInput = {
      id: "1",
      standard: socket.standard,
      ...(socket.format === undefined ? {} : { format: socket.format }),
      current: socket.current,
      ...(power === undefined ? {} : { maxPowerKw: power }),
      ...(voltage === undefined ? {} : { maxVoltage: voltage }),
      ...(amperage === undefined ? {} : { maxAmperage: amperage }),
    };
    evses.push({
      key: type,
      ...(evses.length === 0 && ref !== undefined ? { evseId: ref } : {}),
      ...(count !== undefined && count >= 2 ? { quantity: count } : {}),
      connectors: [connector],
    });
  }
  return evses;
}

/**
 * Whether a station charges e-bikes only: it says `motorcar=no`, or it is
 * for bicycles and has household sockets only without saying cars may
 * charge. `motor_vehicle` stands for `motorcar` where that is not tagged.
 */
function bicyclesOnly(tags: Record<string, string>): boolean {
  const motorcar = tag(tags, "motorcar") ?? tag(tags, "motor_vehicle");
  if (motorcar === "no") return true;
  const bicycle = tag(tags, "bicycle");
  if (bicycle !== "yes" && bicycle !== "designated") return false;
  if (motorcar === "yes" || motorcar === "designated") return false;
  const sockets = Object.keys(tags).flatMap((key) => {
    const type = key.match(SOCKET_COUNT)?.[1];
    const value = tag(tags, key);
    return type === undefined || value === "no" || value === "0" ? [] : [type];
  });
  return sockets.length > 0 && sockets.every((s) => HOUSEHOLD.has(s));
}

/**
 * OpenStreetMap charging stations (`amenity=charging_station`) as Overpass
 * answers for a cell, nodes at their position and ways and relations at
 * their centre. The site id is the element (`way/<id>`), and its `osm:<type>`
 * id the only id linking matches on. Its charge points are one EVSE per
 * socket type, with the tagged count as its quantity. OSM holds no live
 * state and no prices: no readings, no offers. E-bike chargers are left out.
 */
export function parseOverpassCharging(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  for (const payload of payloads["main"] ?? []) {
    for (const element of decodeOverpass(payload)) {
      const { tags } = element;
      if (tags["amenity"] !== "charging_station" || bicyclesOnly(tags)) continue;
      const audience = AUDIENCE[tag(tags, "access") ?? ""];
      const authentication = Object.entries(AUTHENTICATION).flatMap(([key, method]) => {
        const value = tag(tags, key);
        return value === undefined || value === "no" ? [] : [method];
      });
      const country = tag(tags, "addr:country");
      const operator = tag(tags, "operator");
      const wikidata = tag(tags, "operator:wikidata");
      const brand = tag(tags, "brand") ?? tag(tags, "network");
      const optional = <K extends keyof SiteInput>(key: K, value: SiteInput[K] | undefined) =>
        value === undefined ? {} : { [key]: value };
      const input: SiteInput = {
        stationId: `${element.type}/${element.id}`,
        providerId: false,
        point: [element.lon, element.lat],
        lang: UNDETERMINED,
        externalIds: [{ scheme: `osm:${element.type}`, id: String(element.id) }],
        ...optional("name", tag(tags, "name")),
        ...optional(
          "operator",
          operator === undefined
            ? undefined
            : { name: operator, ...(wikidata === undefined ? {} : { wikidata }) },
        ),
        ...optional("brand", brand),
        ...optional("website", tag(tags, "website") ?? tag(tags, "contact:website")),
        ...optional("openingHoursOsm", tag(tags, "opening_hours")),
        ...optional("audience", audience),
        ...(tag(tags, "fee") === "no" ? { payment: ["free" as const] } : {}),
        ...(authentication.length === 0 ? {} : { authentication }),
        ...(country === undefined
          ? {}
          : {
              address: {
                country,
                street: tag(tags, "addr:street"),
                houseNumber: tag(tags, "addr:housenumber"),
                postalCode: tag(tags, "addr:postcode"),
                city: tag(tags, "addr:city"),
              },
            }),
        evses: evsesOf(tags),
      };
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));
    }
  }
  return out;
}
