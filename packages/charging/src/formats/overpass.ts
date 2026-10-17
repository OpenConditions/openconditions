import {
  decodeOverpass,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordSkipReason,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, AUTHENTICATION_METHODS, PAYMENT_METHODS } from "@openconditions/model";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { own } from "../records.js";
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
  /** NACS (SAE J3400) delivers AC or DC through one plug: the socket alone says neither. */
  current?: "ac" | "dc";
  format?: "socket" | "cable";
}

/**
 * `socket:<type>` → the plug standard, its current, and whether it is a
 * socket or a cable. The SAE J3105 pantographs are the infrastructure's
 * (`-1`, top down) and the vehicle's (`-2`, bottom up); the Tesla standard
 * connector is the North American one SAE standardised as J3400.
 */
const SOCKETS: Readonly<Record<string, Socket>> = {
  type2: { standard: "IEC_62196_T2", current: "ac", format: "socket" },
  type2_cable: { standard: "IEC_62196_T2", current: "ac", format: "cable" },
  type2_combo: { standard: "IEC_62196_T2_COMBO", current: "dc" },
  chademo: { standard: "CHADEMO", current: "dc" },
  chaoji: { standard: "CHAOJI", current: "dc" },
  mcs: { standard: "MCS", current: "dc", format: "cable" },
  type1: { standard: "IEC_62196_T1", current: "ac" },
  type1_cable: { standard: "IEC_62196_T1", current: "ac", format: "cable" },
  type1_combo: { standard: "IEC_62196_T1_COMBO", current: "dc" },
  type3a: { standard: "IEC_62196_T3A", current: "ac", format: "socket" },
  type3c: { standard: "IEC_62196_T3C", current: "ac", format: "socket" },
  tesla_supercharger: { standard: "TESLA_S", current: "dc" },
  tesla_supercharger_ccs: { standard: "IEC_62196_T2_COMBO", current: "dc" },
  tesla_standard: { standard: "SAE_J3400" },
  tesla_roadster: { standard: "TESLA_R", current: "ac" },
  nacs: { standard: "SAE_J3400" },
  schuko: { standard: "DOMESTIC_F", current: "ac", format: "socket" },
  typee: { standard: "DOMESTIC_E", current: "ac", format: "socket" },
  typec: { standard: "DOMESTIC_C", current: "ac", format: "socket" },
  typek: { standard: "DOMESTIC_K", current: "ac", format: "socket" },
  bs1363: { standard: "DOMESTIC_G", current: "ac", format: "socket" },
  as3112: { standard: "DOMESTIC_I", current: "ac", format: "socket" },
  sev1011_t13: { standard: "DOMESTIC_J", current: "ac", format: "socket" },
  nema_1_15: { standard: "DOMESTIC_A", current: "ac", format: "socket" },
  nema_5_15: { standard: "DOMESTIC_B", current: "ac", format: "socket" },
  nema_5_20: { standard: "NEMA_5_20", current: "ac", format: "socket" },
  nema_14_30: { standard: "NEMA_14_30", current: "ac", format: "socket" },
  nema_14_50: { standard: "NEMA_14_50", current: "ac", format: "socket" },
  cee_blue: { standard: "IEC_60309_2_single_16", current: "ac", format: "socket" },
  cee_red_16a: { standard: "IEC_60309_2_three_16", current: "ac", format: "socket" },
  cee_red_32a: { standard: "IEC_60309_2_three_32", current: "ac", format: "socket" },
  cee_red_63a: { standard: "IEC_60309_2_three_64", current: "ac", format: "socket" },
  gb_ac: { standard: "GBT_AC", current: "ac" },
  gb_dc: { standard: "GBT_DC", current: "dc" },
  "j3105-1": { standard: "PANTOGRAPH_TOP_DOWN", current: "dc" },
  "j3105-2": { standard: "PANTOGRAPH_BOTTOM_UP", current: "dc" },
};

/**
 * `payment:<method>=yes` → the means of payment; every other method OSM
 * names (a wallet, a brand, a voucher) is another means.
 */
const PAYMENT: Readonly<Record<string, (typeof PAYMENT_METHODS)[number]>> = {
  cash: "cash",
  coins: "cash",
  notes: "cash",
  credit_cards: "credit_card",
  visa: "credit_card",
  mastercard: "credit_card",
  american_express: "credit_card",
  debit_cards: "debit_card",
  maestro: "debit_card",
  contactless: "contactless",
  app: "app",
  sms: "sms",
  membership_card: "membership",
};

/** `authentication:<method>=yes`; a phone call or text message starts a charge remotely. */
const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number]>> = {
  "authentication:none": "none",
  "authentication:app": "app",
  "authentication:membership_card": "rfid",
  "authentication:nfc": "nfc",
  "authentication:plug_and_charge": "plug_and_charge",
  "authentication:debit_card": "debit_card",
  "authentication:phone_call": "remote",
  "authentication:short_message": "remote",
};

/** The `yes` and `no` of a tag that says whether something holds. */
const YES_NO: Readonly<Record<string, boolean>> = { yes: true, no: false };

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

const tag = (tags: Record<string, string>, key: string): string | undefined => {
  const value = tags[key]?.trim();
  return value ? value : undefined;
};

const SOCKET_COUNT = /^socket:([a-z0-9_-]+)$/;

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

/**
 * One EVSE per tagged socket type, standing for as many points as the count
 * says. A count of several groups (`6;3`) beside as many outputs (`50
 * kW;150 kW`) is a group of points per output. A socket of one type is
 * powered as the station says where the socket does not, and `frequency=0`
 * is direct current. A socket type not read here, or a count that is no
 * number, is left out and counts as unknown.
 */
function evsesOf(tags: Record<string, string>, unknown: () => void): EvseInput[] {
  const ref = (tag(tags, "ref:EU:EVSE") ?? "")
    .split(";")
    .map((r) => emi3Of(r.trim()))
    .find((r) => r !== undefined);
  const types = Object.keys(tags).flatMap((key) => {
    const type = key.match(SOCKET_COUNT)?.[1];
    const value = tag(tags, key);
    return type === undefined || value === undefined || value === "no" || value === "0"
      ? []
      : [{ key, type, value }];
  });
  const floor = tag(tags, "level");
  const wheelchair = own(YES_NO, tag(tags, "wheelchair"));
  const dc = tag(tags, "frequency") === "0";
  const evses: EvseInput[] = [];
  for (const { key, type, value } of types) {
    const socket = own(SOCKETS, type);
    if (socket === undefined) {
      unknown();
      continue;
    }
    const counts = value.split(";").map((c) => c.trim());
    if (!counts.every((c) => /^\d+$/.test(c)) && value !== "yes") unknown();
    const outputs = (tag(tags, `${key}:output`) ?? "").split(";").map((o) => parsePowerKw(o));
    const only = types.length === 1;
    const voltage =
      amount(tag(tags, `${key}:voltage`)) ?? (only ? amount(tag(tags, "voltage")) : undefined);
    const amperage =
      amount(tag(tags, `${key}:current`) ?? tag(tags, `${key}:amperage`)) ??
      (only ? amount(tag(tags, "amperage")) : undefined);
    const current = socket.current ?? (dc ? "dc" : undefined);
    // Several counts each with its own output are groups of points; else one group of all.
    const groups =
      counts.length > 1 && counts.length === outputs.length
        ? counts.map((c, i) => ({ count: Number(c), power: outputs[i], suffix: `-${i + 1}` }))
        : [
            {
              count: counts.every((c) => /^\d+$/.test(c))
                ? counts.reduce((sum, c) => sum + Number(c), 0)
                : undefined,
              power: outputKw(tag(tags, `${key}:output`)),
              suffix: "",
            },
          ];
    for (const { count, power, suffix } of groups) {
      const connector: ConnectorInput = {
        id: "1",
        standard: socket.standard,
        ...(socket.format === undefined ? {} : { format: socket.format }),
        ...(current === undefined ? {} : { current }),
        ...(power === undefined ? {} : { maxPowerKw: power }),
        ...(voltage === undefined ? {} : { maxVoltage: voltage }),
        ...(amperage === undefined ? {} : { maxAmperage: amperage }),
      };
      evses.push({
        key: `${type}${suffix}`,
        ...(evses.length === 0 && ref !== undefined ? { evseId: ref } : {}),
        ...(count !== undefined && count >= 2 ? { quantity: count } : {}),
        ...(floor === undefined ? {} : { floorLevel: floor }),
        ...(wheelchair === undefined ? {} : { wheelchairAccessible: wheelchair }),
        connectors: [connector],
      });
    }
  }
  return evses;
}

/**
 * The means of payment a station's `payment:*` tags say yes to; a value
 * other than yes or no is counted.
 */
function paymentOf(
  tags: Record<string, string>,
  unknown: () => void,
): (typeof PAYMENT_METHODS)[number][] {
  const methods = Object.keys(tags).flatMap((key) => {
    const method = key.match(/^payment:([^:]+)$/)?.[1];
    if (method === undefined) return [];
    const accepted = own(YES_NO, tag(tags, key));
    if (accepted === undefined) unknown();
    if (accepted !== true) return [];
    const known = own(PAYMENT, method);
    return [known ?? "other"];
  });
  return [...new Set(methods)];
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
 * An `access` value or a socket type not read here counts as unknown.
 */
export function parseOverpassCharging(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const skip = (reason: RecordSkipReason) => recordSkipped(feed.id, reason);
  const unknown = () => recordSkipped(feed.id, "unknown_value");
  for (const payload of payloads["main"] ?? []) {
    for (const element of decodeOverpass(payload, skip)) {
      const { tags } = element;
      if (tags["amenity"] !== "charging_station" || bicyclesOnly(tags)) continue;
      const access = tag(tags, "access");
      const audience = own(AUDIENCE, access);
      if (access !== undefined && audience === undefined) unknown();
      const authentication = Object.keys(tags).flatMap((key) => {
        if (!key.startsWith("authentication:")) return [];
        const accepted = own(YES_NO, tag(tags, key));
        if (accepted === undefined) unknown();
        const method = own(AUTHENTICATION, key);
        // A method the model has no term for (a key, a chip or money card, autocharge) says nothing.
        return accepted === true && method !== undefined ? [method] : [];
      });
      const fee = own(YES_NO, tag(tags, "fee"));
      const payment = [...(fee === false ? (["free"] as const) : []), ...paymentOf(tags, unknown)];
      const country = tag(tags, "addr:country");
      const operator = tag(tags, "operator");
      const wikidata = tag(tags, "operator:wikidata");
      const email = tag(tags, "contact:email") ?? tag(tags, "email");
      const owner = tag(tags, "owner");
      const brand = tag(tags, "brand") ?? tag(tags, "network");
      const covered = own(YES_NO, tag(tags, "covered"));
      const image = tag(tags, "image");
      const charge = tag(tags, "charge");
      const crossFeed = [
        ...(tag(tags, "ref:ocm") === undefined
          ? []
          : [{ scheme: "ocm", id: tag(tags, "ref:ocm")! }]),
        ...(tag(tags, "ref:afdc") === undefined
          ? []
          : [{ scheme: "afdc", id: tag(tags, "ref:afdc")! }]),
      ];
      const optional = <K extends keyof SiteInput>(key: K, value: SiteInput[K] | undefined) =>
        value === undefined ? {} : { [key]: value };
      const input: SiteInput = {
        stationId: `${element.type}/${element.id}`,
        providerId: false,
        point: [element.lon, element.lat],
        lang: UNDETERMINED,
        externalIds: [{ scheme: `osm:${element.type}`, id: String(element.id) }, ...crossFeed],
        ...optional("name", tag(tags, "name")),
        ...optional(
          "operator",
          operator === undefined
            ? undefined
            : {
                name: operator,
                ...(wikidata === undefined ? {} : { wikidata }),
                ...(email === undefined ? {} : { email }),
              },
        ),
        ...optional("owner", owner === undefined ? undefined : { name: owner }),
        ...optional("brand", brand),
        ...optional("website", tag(tags, "website") ?? tag(tags, "contact:website")),
        ...optional("hotline", tag(tags, "phone") ?? tag(tags, "contact:phone")),
        ...optional("notes", tag(tags, "description")),
        ...optional("openingHoursOsm", tag(tags, "opening_hours")),
        ...optional("audience", audience),
        ...(payment.length === 0 ? {} : { payment }),
        ...(authentication.length === 0 ? {} : { authentication }),
        ...(covered === undefined ? {} : { roofed: covered }),
        // `charge` is the price as the mapper wrote it, `fee=yes` without one says only that it costs.
        ...optional("tariffText", charge),
        ...(image === undefined || !/^https?:\/\//i.test(image)
          ? {}
          : { images: [{ url: image, category: "site" as const }] }),
        ...(country === undefined
          ? {}
          : {
              address: {
                country,
                street: tag(tags, "addr:street"),
                houseNumber: tag(tags, "addr:housenumber"),
                postalCode: tag(tags, "addr:postcode"),
                city: tag(tags, "addr:city"),
                region: tag(tags, "addr:state"),
              },
            }),
        evses: evsesOf(tags, unknown),
      };
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));
    }
  }
  return out;
}
