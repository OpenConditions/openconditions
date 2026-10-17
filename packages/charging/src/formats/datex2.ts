import {
  type DatexEnergyConnector,
  type DatexEnergyOpeningHours,
  type DatexEnergyRate,
  type DatexEnergySite,
  type DatexEnergyStatus,
  type DatexRefillPoint,
  parseDatexEnergyStatus,
  parseDatexEnergyTable,
  parseXmlDocument,
} from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
  type StatusSubject,
} from "@openconditions/ingest-framework";
import type { AUTHENTICATION_METHODS, PAYMENT_METHODS } from "@openconditions/model";
import {
  DATEX2_CONNECTOR_FORMATS,
  DATEX2_CONNECTOR_STANDARDS,
  DATEX2_REFILL_POINT_STATUSES,
} from "@openconditions/model-charging";
import type { OcpiPriceComponent, OcpiRestrictions, OcpiTariff } from "@openconditions/ocpi";
import { colocateSites } from "../colocate.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { osmOpeningHours } from "../hours.js";
import { detached } from "../records.js";
import {
  type ConnectorInput,
  type EvseInput,
  type EvseStatus,
  instantIn,
  type ParkingType,
  type PowerType,
  type SiteInput,
  siteDraft,
  statusIsLive,
} from "../site.js";
import { indexStatus, type StatusIndexDraft, statusReader, subjectsOf } from "../status.js";
import { tariffDraft, tariffKeys } from "../tariff.js";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Counts a value the parser does not know under the feed, when there is one. */
type Unknown = (value: string | undefined) => void;

/**
 * The OCPI price component of a rate table line: a flat rate is flat; a
 * price per unit is per kilowatt-hour where the unit is the electric
 * charging point's (`kWh`, or none stated) and the table prices per delivery
 * unit or does not say. A price per unit of charging time names no time
 * unit in DATEX, and an incrementing or tiered rate has no single price, so
 * neither is read.
 */
function rateLineComponent(
  policy: string | undefined,
  line: DatexEnergyRate["lines"][number],
): OcpiPriceComponent | undefined {
  if (line.type === "flatRate") return { type: "FLAT", price: line.value };
  const perDeliveryUnit = policy === undefined || policy === "pricePerDeliveryUnit";
  if (line.type === "perUnit" && perDeliveryUnit) {
    return line.unit === undefined || line.unit === "kWh"
      ? { type: "ENERGY", price: line.value }
      : undefined;
  }
  return undefined;
}

/**
 * The OCPI price component of an AFIR energy price. A price per minute is
 * OCPI's time price, which is per hour; a base price is added to the rest,
 * as OCPI's flat price is. A price per kilogram is no electricity price.
 */
function energyPriceComponent(line: DatexEnergyRate["lines"][number]) {
  switch (line.type) {
    case "pricePerKWh":
      return { type: "ENERGY", price: line.value };
    case "pricePerMinute":
      return { type: "TIME", price: line.value * 60 };
    case "basePrice":
    case "flatRate":
      return { type: "FLAT", price: line.value };
    case "free":
      return { type: "FLAT", price: 0 };
    default:
      return undefined;
  }
}

/** An AFIR price's charging minutes and kilowatt-hours as OCPI restrictions. */
function restrictionsOf(line: DatexEnergyRate["lines"][number]): OcpiRestrictions | undefined {
  const r: OcpiRestrictions = {
    ...(line.fromMinute === undefined || line.fromMinute === 0
      ? {}
      : { min_duration: line.fromMinute * 60 }),
    ...(line.toMinute === undefined ? {} : { max_duration: line.toMinute * 60 }),
    ...(line.fromKWh === undefined || line.fromKWh === 0 ? {} : { min_kwh: line.fromKWh }),
    ...(line.toKWh === undefined ? {} : { max_kwh: line.toKWh }),
  };
  return Object.keys(r).length === 0 ? undefined : r;
}

/**
 * DATEX authentication and identification methods. The RFID cards and
 * chips (Calypso, Mifare, a phone's active chip) identify by RFID; PLC is
 * ISO 15118 communication over the charging cable, plug and charge; a phone
 * call, text message or website starts a charge remotely. Paying cash is a
 * payment method, not an identification, and is read as one. Over-the-air
 * ISO 15118 names a channel rather than a method, a PIN pad or prepaid card
 * may be any of several, and "no access" is no method: those say nothing.
 */
const AUTHENTICATION: Readonly<Record<string, (typeof AUTHENTICATION_METHODS)[number] | null>> = {
  activeRFIDChip: "rfid",
  apps: "app",
  calypso: "rfid",
  cashPayment: null,
  creditCard: "credit_card",
  debitCard: "debit_card",
  mifareClassic: "rfid",
  mifareDesfire: "rfid",
  nfc: "nfc",
  overTheAir: null,
  phoneDialog: "remote",
  phoneSMS: "remote",
  pinpad: null,
  plc: "plug_and_charge",
  prepaidCard: null,
  rfid: "rfid",
  website: "remote",
  unlimitedAccess: "none",
  noAccess: null,
  _extended: null,
};

const PAYMENT: Readonly<Record<string, (typeof PAYMENT_METHODS)[number]>> = {
  cashPayment: "cash",
};

/**
 * Where a site's vehicles stand, from its site type: inside a building is a
 * car park, an open space a parking lot. A roof or a company's ground says
 * nothing of how vehicles stand.
 */
const PARKING_TYPES: Readonly<Record<string, ParkingType | null>> = {
  "siteType:onstreet": "on_street",
  "siteType:inBuilding": "parking_garage",
  "siteType:openSpace": "parking_lot",
  "siteType:other": "other",
  "siteType:roofedStation": null,
  "siteType:onCompanySite": null,
  "siteType:_extended": null,
};

/**
 * Connector types as the crosswalk keys them, plus the AFIR profile's own
 * spellings: AFIR writes the domestic sockets `domesticFType` for
 * `domesticF` and adds the Megawatt Charging System. DATEX defines
 * `teslaConnectorEurope` as "modification of the Type 2 connector", which a
 * Type 2 plug fits, and `teslaConnectorAmerica` as Tesla's own American
 * connector, the one OCPI calls `TESLA_S`.
 */
const CONNECTOR_STANDARDS: Readonly<Record<string, string | null>> = {
  ...DATEX2_CONNECTOR_STANDARDS,
  ...Object.fromEntries(
    [..."ABCDEFGHIJKLMNO"].map((letter) => [`domestic${letter}Type`, `DOMESTIC_${letter}`]),
  ),
  mcs: "MCS",
  teslaConnectorEurope: "IEC_62196_T2",
  teslaConnectorAmerica: "TESLA_S",
};

/**
 * The power a charging mode names (IEC 61851-1 modes 1 to 3 are AC with
 * their phases, mode 4 is DC). A combined charging solution uses AC and DC
 * at once, and an inductive, other or unknown mode names no power type.
 */
const CHARGING_MODES: Readonly<Record<string, PowerType | null>> = {
  mode1AC1p: "AC_1_PHASE",
  mode1AC3p: "AC_3_PHASE",
  mode2AC1p: "AC_1_PHASE",
  mode2AC3p: "AC_3_PHASE",
  mode3AC3p: "AC_3_PHASE",
  mode4DC: "DC",
  legacyInductive: null,
  ccs: null,
  other: null,
  unknown: null,
  _extended: null,
};

const CURRENT_TYPES: Readonly<Record<string, "ac" | "dc" | null>> = {
  ac: "ac",
  dc: "dc",
  _extended: null,
};

/** A value of a table, counted as unknown when the table does not know it. */
function lookup<T>(
  table: Readonly<Record<string, T | null>>,
  value: string | undefined,
  unknown: Unknown,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(value in table)) {
    unknown(value);
    return undefined;
  }
  return table[value] ?? undefined;
}

function connectorOf(
  c: DatexEnergyConnector,
  i: number,
  point: DatexRefillPoint,
  tariffIds: string[],
  unknown: Unknown,
): ConnectorInput {
  const standard = lookup(CONNECTOR_STANDARDS, c.type, unknown);
  const format = lookup(DATEX2_CONNECTOR_FORMATS, c.format, unknown);
  // AFIR states the charging mode and the current on the point, the energy
  // infrastructure namespace the mode on each connector.
  const mode = lookup(CHARGING_MODES, c.chargingMode ?? point.chargingMode, unknown);
  const current = lookup(CURRENT_TYPES, point.currentType, unknown);
  const powerType = mode ?? (current === "dc" ? "DC" : undefined);
  return {
    id: String(i + 1),
    standard: standard ?? "UNKNOWN",
    ...(format === "socket" || format === "cable" ? { format } : {}),
    ...(powerType === undefined ? {} : { powerType }),
    ...(current === undefined ? {} : { current }),
    ...(c.maxPowerW === undefined ? {} : { maxPowerKw: Math.round(c.maxPowerW) / 1000 }),
    ...(c.voltage === undefined ? {} : { maxVoltage: c.voltage }),
    ...(c.maxCurrentA === undefined ? {} : { maxAmperage: c.maxCurrentA }),
    ...(tariffIds.length === 0 ? {} : { tariffIds }),
  };
}

function hoursOf(hours: DatexEnergyOpeningHours | undefined): string | undefined {
  if (hours === undefined) return undefined;
  if (hours.twentyFourSeven) return "24/7";
  return osmOpeningHours(
    hours.periods.flatMap((p) =>
      p.days.map((day) => ({ day: WEEKDAYS.indexOf(day) + 1, from: p.from, to: p.to })),
    ),
  );
}

const RATE_LINE_TYPES = new Set(["flatRate", "incrementingRate", "flatRateTier", "perUnit"]);
const PRICE_TYPES = new Set([
  "pricePerMinute",
  "pricePerKg",
  "pricePerKWh",
  "basePrice",
  "flatRate",
  "free",
  "other",
]);
const PRICING_POLICIES = new Set([
  "pricePerChargingTime",
  "pricePerDeliveryUnit",
  "contract",
  "flatRate",
  "unknown",
  "free",
  "other",
]);
const RATE_POLICIES = new Set(["contract", "adHoc"]);

/**
 * A rate as the OCPI tariff it is. A rate table is one priced element of
 * its lines; a table that is free and lists no lines is a zero flat price.
 * An AFIR energy rate is an element per energy price, restricted to the
 * charging minutes and kilowatt-hours the price applies to. A rate with a
 * price that cannot be priced (a minimum, a time price without a unit, a
 * price for a period of its own) is no tariff: part of a price is a wrong
 * price. A rate a contract sets is no public price either; of an energy
 * rate, only the ad hoc price is.
 */
function tariffOf(id: string, rate: DatexEnergyRate, unknown: Unknown): OcpiTariff | undefined {
  const policies = rate.kind === "energyRate" ? RATE_POLICIES : PRICING_POLICIES;
  if (rate.pricingPolicy !== undefined && !policies.has(rate.pricingPolicy)) {
    unknown(rate.pricingPolicy);
  }
  const lineTypes = rate.kind === "energyRate" ? PRICE_TYPES : RATE_LINE_TYPES;
  for (const line of rate.lines) if (!lineTypes.has(line.type)) unknown(line.type);
  if (rate.pricingPolicy === "contract") return undefined;
  if (rate.kind === "energyRate" && rate.pricingPolicy !== "adHoc") return undefined;
  let elements: OcpiTariff["elements"];
  if (rate.kind === "energyRate") {
    if (rate.lines.some((line) => line.periodic)) return undefined;
    const priced = rate.lines.map((line) => {
      const component = energyPriceComponent(line);
      const restrictions = restrictionsOf(line);
      return component === undefined
        ? undefined
        : {
            price_components: [component],
            ...(restrictions === undefined ? {} : { restrictions }),
          };
    });
    if (priced.some((e) => e === undefined)) return undefined;
    elements = priced as OcpiTariff["elements"];
  } else if (rate.pricingPolicy === "free" && rate.lines.length === 0) {
    elements = [{ price_components: [{ type: "FLAT", price: 0 }] }];
  } else {
    const components = rate.lines.map((line) => rateLineComponent(rate.pricingPolicy, line));
    if (components.some((component) => component === undefined)) return undefined;
    elements = [{ price_components: components as OcpiPriceComponent[] }];
  }
  if (elements.length === 0) return undefined;
  const taxes = new Set(rate.lines.map((line) => line.taxIncluded));
  const taxIncluded = taxes.size === 1 ? [...taxes][0] : undefined;
  return {
    id,
    currency: rate.currency,
    elements,
    ...(taxIncluded === undefined ? {} : { tax_included: taxIncluded ? "YES" : "NO" }),
  };
}

/** A site serves only bicycles when every vehicle type it names is one. */
const bicyclesOnly = (site: DatexEnergySite) =>
  site.vehicleTypes !== undefined &&
  site.vehicleTypes.length > 0 &&
  site.vehicleTypes.every((t) => t === "bicycle");

/**
 * A DATEX II v3 energy infrastructure table (`main`) and, optionally, its
 * status publication (`status`): a site per energy infrastructure site, an
 * EVSE per refill point with its connectors, an offer per rate table that
 * the point's connectors name, and a reading per refill point status, as of
 * the fetch. A refill point's id may be unique only within its station
 * (Lithuania numbers them), so a status is joined on site, station and point.
 * A planned point has no live state but its lifecycle; a removed one is no
 * charge point, and a site of removed points no site; a status last changed
 * more than 30 days back is no reading. An offer says whether its price
 * includes VAT only where every price of an AFIR energy rate says so; a rate
 * table does not say. One operator's sites within 15 m are one site.
 *
 * A site without a placeable point is counted as `no_geometry`, and a code
 * none of the tables here knows as `unknown_value`, under the feed; the
 * decoder counts what it cannot read at all as `malformed`.
 */
export function parseDatex2(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const main = payloads["main"] ?? [];
  if (main.length === 0) return out;
  const options = { sourceId: feed.id };
  const unknown: Unknown = (value) => {
    if (value !== undefined) recordSkipped(feed.id, "unknown_value");
  };
  const sites = main.flatMap((body) => parseDatexEnergyTable(parseXmlDocument(body), options));
  // A status names its refill point by site, station and point, or by the
  // bare point id where that is unique in the table.
  const points = new Map<string, number>();
  for (const station of sites.flatMap((s) => s.stations)) {
    for (const refill of station.points) points.set(refill.id, (points.get(refill.id) ?? 0) + 1);
  }
  const unique = (pointId: string) => points.get(pointId) === 1;
  const statuses = statusesOf(payloads["status"] ?? [], feed.id);
  const statusOf = (siteId: string, stationId: string, pointId: string) =>
    statuses.get(pointKey(siteId, stationId, pointId)) ??
    (unique(pointId) ? statuses.get(pointKey(undefined, undefined, pointId)) : undefined);
  const index: StatusIndexDraft = new Map();
  const seen = new Set<string>();
  let unplaced = 0;
  for (const site of sites) {
    if (bicyclesOnly(site)) continue;
    if (site.point === undefined) {
      unplaced++;
      continue;
    }
    if (seen.has(site.id)) continue;
    seen.add(site.id);
    const point = site.point;
    const stationId = site.id;
    const evseKeys = new Set<string>();
    const tariffs = new Map<string, OcpiTariff>();
    const evses: EvseInput[] = [];
    const subjects: [keys: string[], subject: StatusSubject][] = [];
    let listed = 0;
    for (const station of site.stations) {
      for (const refill of station.points) {
        listed++;
        const status = statusOf(site.id, station.id, refill.id);
        const value =
          status === undefined ? undefined : DATEX2_REFILL_POINT_STATUSES[status.status];
        // A point taken away is no charge point any more.
        if (value === "removed") continue;
        let key = refill.emi3 ?? refill.id;
        if (evseKeys.has(key)) key = `${station.id}-${refill.id}`;
        evseKeys.add(key);
        const tariffIds = refill.rates.flatMap((rate, i) => {
          const tariff = tariffOf(rate.id ?? `${key}-${i + 1}`, rate, unknown);
          if (tariff === undefined) return [];
          tariffs.set(tariff.id, tariff);
          return [tariff.id];
        });
        evses.push({
          key,
          ...(refill.emi3 === undefined ? {} : { evseId: refill.emi3 }),
          ...(value === "planned" ? { lifecycle: "planned" as const } : {}),
          connectors: refill.connectors.map((c, i) =>
            connectorOf(c, i, refill, tariffIds, unknown),
          ),
        });
        // A point not yet built takes its live state from the next full parse.
        if (value === "planned") continue;
        // The document's own strings would keep it alive as long as the index.
        subjects.push([
          [
            detached(pointKey(site.id, station.id, refill.id)),
            ...(unique(refill.id) ? [detached(pointKey(undefined, undefined, refill.id))] : []),
          ],
          { stationId: detached(stationId), evseKey: detached(key), point },
        ]);
      }
    }
    // Every charge point taken away: the site is gone.
    if (listed > 0 && evses.length === 0) continue;
    for (const [keys, subject] of subjects) {
      for (const k of keys) indexStatus(index, k, subject);
    }
    const keys = tariffKeys(tariffs.keys());
    const offered = new Set<string>();
    for (const tariff of tariffs.values()) {
      const offer = tariffDraft(feed, stationId, tariff, {
        fetchedAt: ctx.fetchedAt,
        point,
        key: keys.get(tariff.id) ?? tariff.id,
      });
      if (offer === undefined) continue;
      if (tariff.tax_included === undefined) {
        const { priceIncludesVat: _unstated, ...stated } = offer;
        out.offers.push(stated);
      } else {
        out.offers.push(offer);
      }
      offered.add(tariff.id);
    }
    for (const evse of evses) {
      for (const connector of evse.connectors) {
        const ids = (connector.tariffIds ?? []).flatMap((id) =>
          offered.has(id) ? [keys.get(id) ?? id] : [],
        );
        if (ids.length === 0) delete connector.tariffIds;
        else connector.tariffIds = ids;
      }
    }
    const name = site.names[0];
    const methods = site.stations.flatMap((s) => s.authMethods);
    const authentication = [
      ...new Set(
        methods.flatMap((m) => {
          const method = lookup(AUTHENTICATION, m, unknown);
          return method === undefined ? [] : [method];
        }),
      ),
    ];
    const payment = [
      ...new Set(methods.flatMap((m) => (PAYMENT[m] === undefined ? [] : [PAYMENT[m]]))),
    ];
    const parkingType = lookup(PARKING_TYPES, site.siteType, unknown);
    const hours = hoursOf(site.openingHours);
    const input: SiteInput = {
      stationId,
      point,
      ...(name === undefined ? {} : { name: name.value, lang: name.lang }),
      ...(site.operator?.name === undefined ? {} : { operator: { name: site.operator.name } }),
      ...(site.address === undefined ? {} : { address: site.address }),
      ...(hours === undefined ? {} : { openingHoursOsm: hours }),
      ...(authentication.length === 0 ? {} : { authentication }),
      ...(payment.length === 0 ? {} : { payment }),
      ...(parkingType === undefined ? {} : { parkingType }),
      evses,
    };
    out.features.push(siteDraft(feed, input, ctx.fetchedAt));
  }
  recordSkipped(feed.id, "no_geometry", unplaced);
  out.statusIndex = index;
  colocateSites(out);
  out.observations = datexStatusReadings(feed, statuses, index, ctx).observations;
  return out;
}

/**
 * The key a status names its refill point by: site, station and point, or
 * the bare point id (a key of its own) where the status names no more.
 */
const pointKey = (siteId: string | undefined, stationId: string | undefined, pointId: string) =>
  siteId !== undefined && stationId !== undefined
    ? `${siteId}|${stationId}|${pointId}`
    : `|${pointId}`;

/**
 * The statuses of the status bodies by the key they name their refill point
 * by. A status value the refill point statuses do not know is counted as
 * `unknown_value`.
 */
function statusesOf(bodies: readonly Buffer[], feedId: string): Map<string, DatexEnergyStatus> {
  const statuses = new Map<string, DatexEnergyStatus>();
  for (const body of bodies) {
    for (const status of parseDatexEnergyStatus(parseXmlDocument(body), { sourceId: feedId })) {
      if (!(status.status in DATEX2_REFILL_POINT_STATUSES)) {
        recordSkipped(feedId, "unknown_value");
      }
      statuses.set(pointKey(status.siteId, status.stationId, status.refillPointId), status);
    }
  }
  return statuses;
}

/**
 * A reading per indexed refill point with a live status, as of its site
 * status's `lastUpdated`: the status naming its site, station and point, else the one naming the
 * bare point where that is unique in the table (the index holds the bare
 * key only then). A point that is removed or planned has no live state, nor
 * has a status last changed more than 30 days back; a status the index does
 * not place is rejected.
 */
function datexStatusReadings(
  feed: ChargingCatalogFeed,
  statuses: ReadonlyMap<string, DatexEnergyStatus>,
  index: StatusIndex,
  ctx: ParseContext,
): StatusOutput {
  const reader = statusReader(feed, ctx);
  const chosen = new Map<StatusSubject, DatexEnergyStatus>();
  const bare: [StatusSubject, DatexEnergyStatus][] = [];
  for (const [key, status] of statuses) {
    const subjects = subjectsOf(index, key);
    if (subjects.length === 0) reader.reject();
    for (const subject of subjects) {
      if (key.startsWith("|")) bare.push([subject, status]);
      else chosen.set(subject, status);
    }
  }
  for (const [subject, status] of bare) if (!chosen.has(subject)) chosen.set(subject, status);
  for (const [subject, status] of chosen) {
    const value = DATEX2_REFILL_POINT_STATUSES[status.status];
    if (typeof value !== "string" || value === "planned" || value === "removed") continue;
    const at = instantIn("UTC", status.at);
    if (!statusIsLive(at, ctx.fetchedAt)) continue;
    reader.read(subject, value as EvseStatus, at);
  }
  return reader.output();
}

/** The status-only reading of a DATEX II energy infrastructure status publication. */
export function parseDatex2Status(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  return datexStatusReadings(feed, statusesOf(payloads["status"] ?? [], feed.id), index, ctx);
}
