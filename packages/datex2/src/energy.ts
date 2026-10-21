import { type DatexPublication, datexPublications } from "./publication.js";
import { type DatexDecodeOptions, skipped } from "./skips.js";
import {
  elementType,
  localAttribute,
  localChild,
  localChildren,
  localChildText,
  localChildTexts,
  multilingual,
  pointOf,
} from "./values.js";
import type { XmlObject } from "./xml.js";

/**
 * DATEX II v3 energy infrastructure table and status publications, decoded to
 * plain records. Codes stay as published: connector types, formats and charging
 * modes bare (`iec62196T2`, `socket`, `mode3AC3p`), the site type prefixed
 * (`siteType:onstreet`) as the charging crosswalk is keyed, and a refill point
 * status as the v3.7 enumeration value (`outOfOrder`).
 *
 * Both v3.7 energy namespaces are read: `energyInfrastructure` and the AFIR
 * profile `afirEnergyInfrastructure`, whose element names are the same where
 * they say the same thing. AFIR moves the charging mode from the connector to
 * the refill point, adds the point's current type, and prices a point by the
 * energy rates of its energy products instead of a rate table.
 *
 * A site, station, refill point or connector without the identity or type the
 * schema requires of it, a rate without a currency or with a line that cannot
 * be read, and a status that names no refill point or no status are counted
 * as `malformed` under the options' feed.
 */

export interface DatexEnergyConnector {
  type: string;
  format?: string;
  chargingMode?: string;
  /** Watts. */
  maxPowerW?: number;
  voltage?: number;
  maxCurrentA?: number;
}

export interface DatexEnergyRateLine {
  /** A rate table line's `rateLineType`, or an AFIR energy price's `priceType`. */
  type: string;
  value: number;
  /** The refill point's delivery unit, on a per-unit line. */
  unit?: string;
  description?: string;
  /** An AFIR price's charging minutes it applies from and up to. */
  fromMinute?: number;
  toMinute?: number;
  /** An AFIR price's delivered kWh it applies from and up to. */
  fromKWh?: number;
  toKWh?: number;
  /** Whether the price includes tax, where it says. */
  taxIncluded?: boolean;
  /** The price applies only in periods of its own (`overallPeriod`). */
  periodic?: boolean;
  /** A rate table line's `incrementPeriod`, in seconds: the time each increment of an incrementing rate buys. */
  incrementSeconds?: number;
  /**
   * A rate table line's `durationStart` and `durationEnd`: seconds since the
   * session began where its collection's times are relative, else times of
   * day (`HH:MM`).
   */
  fromSecond?: number;
  toSecond?: number;
  fromTime?: string;
  toTime?: string;
  /** A time the line names that cannot be read. */
  unreadableTime?: boolean;
}

/** The energy mix of the energy a refill point supplies. */
export interface DatexEnergyMix {
  productName?: string;
  isGreen?: boolean;
  /** Grams per kWh. */
  carbonDioxide?: number;
  nuclearWaste?: number;
  /** `ElectricEnergySourceTypeEnum` values, as published. */
  sources: { source: string; percentage: number }[];
}

export interface DatexEnergyRate {
  /** `rateTable`: a facilities rate table; `energyRate`: an AFIR energy rate. */
  kind: "rateTable" | "energyRate";
  /** The rate's own id, where it has one. */
  id?: string;
  /** ISO 4217, upper case. */
  currency: string;
  /** A rate table's `pricingPolicy`, an energy rate's `ratePolicy`. */
  pricingPolicy?: string;
  lines: DatexEnergyRateLine[];
}

export interface DatexRefillPoint {
  id: string;
  externalId?: string;
  /** The eMI3 EVSE id, as published, when the name or external identifier is one. */
  emi3?: string;
  /** The point's own charging mode, where AFIR states it on the point. */
  chargingMode?: string;
  /** AFIR's `currentType`: `ac` or `dc`. */
  currentType?: string;
  connectors: DatexEnergyConnector[];
  rates: DatexEnergyRate[];
  /** The first energy mix the point names: `electricEnergyMix`, or AFIR's electric `energyProduct`. */
  energyMix?: DatexEnergyMix;
}

export interface DatexEnergyStation {
  id: string;
  authMethods: string[];
  points: DatexRefillPoint[];
}

export interface DatexEnergyOpeningPeriod {
  /** English day names as DATEX writes them (`monday`). */
  days: string[];
  /** `HH:MM`, local to the site. */
  from: string;
  to: string;
}

export interface DatexEnergyOpeningHours {
  twentyFourSeven: boolean;
  periods: DatexEnergyOpeningPeriod[];
}

export interface DatexEnergySite {
  id: string;
  version?: string;
  names: { lang: string; value: string }[];
  point?: [number, number];
  address?: { street?: string; postalCode?: string; city?: string; country?: string };
  operator?: { id?: string; name?: string; legalName?: string };
  /** `siteType:<code>`. */
  siteType?: string;
  brand?: string;
  /** `[lon, lat]` of the site's entrance. */
  entrance?: [number, number];
  /** The vehicle types the site serves (`car`, `bicycle`), when it says. */
  vehicleTypes?: string[];
  openingHours?: DatexEnergyOpeningHours;
  lastUpdated?: string;
  stations: DatexEnergyStation[];
}

export interface DatexEnergyStatus {
  refillPointId: string;
  siteId?: string;
  stationId?: string;
  /** The connector a status wire addresses a refill point's status by, when it does. */
  connectorIndex?: string;
  at?: string;
  /** A refill point status enumeration value (`available`, `outOfOrder`). */
  status: string;
}

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

function firstText(node: unknown): string | undefined {
  return multilingual(node)[0]?.value;
}

/** A measurement as published; zero is the placeholder some feeds write for unknown. */
function positive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** ISO country, operator, `E`, then the outlet id; the separators are optional. */
const EMI3_EVSE_ID = /^[A-Za-z]{2}\*?[A-Za-z0-9]{3}\*?E[A-Za-z0-9*]+$/;

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const SPANISH_WEEKDAYS: Readonly<Record<string, string>> = {
  lunes: "monday",
  martes: "tuesday",
  miercoles: "wednesday",
  jueves: "thursday",
  viernes: "friday",
  sabado: "saturday",
  domingo: "sunday",
};

const withoutAccents = (text: string): string =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "");

function clock(raw: string | undefined): string | undefined {
  const [, hours, minutes] = raw?.match(/^(\d{1,2}):(\d{2})/) ?? [];
  return hours === undefined || minutes === undefined
    ? undefined
    : `${hours.padStart(2, "0")}:${minutes}`;
}

function periodsOf(hours: XmlObject): DatexEnergyOpeningPeriod[] {
  const out: DatexEnergyOpeningPeriod[] = [];
  const overall = localChildren(hours, "overallPeriod");
  for (const period of overall) {
    for (const valid of localChildren(period, "validPeriod")) {
      const days = localChildTexts(
        localChild(valid, "recurringDayWeekMonthPeriod"),
        "applicableDay",
      );
      const times = localChild(valid, "recurringTimePeriodOfDay");
      const from = clock(localChildText(times, "startTimeOfPeriod"));
      const to = clock(localChildText(times, "endTimeOfPeriod"));
      if (days.length > 0 && from !== undefined && to !== undefined) out.push({ days, from, to });
    }
  }
  return out;
}

/**
 * Spain publishes the weekly timetable as one free-text label
 * (`Lunes (08:30 - 17:30) Martes (08:30 - 17:30)`); days with the same hours
 * form one period.
 */
function labelPeriods(label: string): DatexEnergyOpeningPeriod[] {
  const byHours = new Map<string, DatexEnergyOpeningPeriod>();
  for (const m of label.matchAll(
    /([\p{L}]+)\s*\(\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*\)/gu,
  )) {
    const name = withoutAccents(m[1] ?? "").toLowerCase();
    // Only the table's own days: a word such as "constructor" names none.
    const day = Object.hasOwn(SPANISH_WEEKDAYS, name) ? SPANISH_WEEKDAYS[name] : undefined;
    const from = clock(m[2]);
    const to = clock(m[3]);
    if (day === undefined || from === undefined || to === undefined) continue;
    const key = `${from}-${to}`;
    const seen = byHours.get(key);
    if (seen) seen.days.push(day);
    else byHours.set(key, { days: [day], from, to });
  }
  return [...byHours.values()];
}

function openingHoursOf(site: XmlObject): DatexEnergyOpeningHours | undefined {
  const hours = localChild(site, "operatingHours");
  if (!hours) return undefined;
  const label = present(localChildText(hours, "label"));
  const periods = periodsOf(hours);
  const resolved = periods.length > 0 ? periods : label === undefined ? [] : labelPeriods(label);
  const wholeDays = new Set(
    resolved.filter((p) => p.from === "00:00" && p.to >= "23:59").flatMap((p) => p.days),
  );
  const twentyFourSeven =
    localAttribute(hours, "id")?.trim() === "24/7" ||
    label?.replace(/\s+/g, "") === "24/7" ||
    WEEKDAYS.every((day) => wholeDays.has(day));
  if (!twentyFourSeven && resolved.length === 0) return undefined;
  return { twentyFourSeven, periods: twentyFourSeven && periods.length === 0 ? [] : resolved };
}

const ADDRESS_LABEL = /^\s*([^:\d]{2,30}?)\s*:\s*(.*)$/s;

function addressOf(site: XmlObject): DatexEnergySite["address"] {
  const location = localChild(site, "locationReference");
  const address = localChild(
    localChild(localChild(location, "_locationReferenceExtension"), "facilityLocation"),
    "address",
  );
  if (!address) return undefined;
  let street: string | undefined;
  let city = firstText(localChild(address, "city"));
  for (const line of localChildren(address, "addressLine")) {
    const text = firstText(localChild(line, "text"));
    if (text === undefined) continue;
    const [, rawLabel, rawBody] = text.match(ADDRESS_LABEL) ?? [];
    const label = rawLabel === undefined ? undefined : withoutAccents(rawLabel).toLowerCase();
    const body = rawBody === undefined ? text : rawBody.trim();
    if (body === "") continue;
    if (localChildText(line, "type") === "street" || label === "direccion") street ??= body;
    else if (label === "municipio") city ??= body;
  }
  const postalCode = present(localChildText(address, "postcode"));
  const country = present(localChildText(address, "countryCode"));
  const out = {
    ...(street === undefined ? {} : { street }),
    ...(postalCode === undefined ? {} : { postalCode }),
    ...(city === undefined ? {} : { city }),
    ...(country === undefined ? {} : { country }),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

function operatorOf(site: XmlObject): DatexEnergySite["operator"] {
  const operator = localChild(site, "operator");
  if (!operator) return undefined;
  const id = present(localAttribute(operator, "id"));
  const name = firstText(localChild(operator, "name"));
  const legalName = firstText(localChild(operator, "legalName"));
  const out = {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(legalName === undefined ? {} : { legalName }),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

function connectorOf(
  connector: XmlObject,
  options: DatexDecodeOptions,
): DatexEnergyConnector | undefined {
  const type = localChildText(connector, "connectorType");
  if (type === undefined) {
    skipped(options, "malformed");
    return undefined;
  }
  const format = localChildText(connector, "connectorFormat");
  const chargingMode = localChildText(connector, "chargingMode");
  const maxPowerW = positive(localChildText(connector, "maxPowerAtSocket"));
  const voltage = positive(localChildText(connector, "voltage"));
  const maxCurrentA = positive(localChildText(connector, "maximumCurrent"));
  return {
    type,
    ...(format === undefined ? {} : { format }),
    ...(chargingMode === undefined ? {} : { chargingMode }),
    ...(maxPowerW === undefined ? {} : { maxPowerW }),
    ...(voltage === undefined ? {} : { voltage }),
    ...(maxCurrentA === undefined ? {} : { maxCurrentA }),
  };
}

function ratesOf(point: XmlObject, options: DatexDecodeOptions): DatexEnergyRate[] {
  const deliveryUnit = localChildText(point, "deliveryUnit");
  const out: DatexEnergyRate[] = [];
  for (const table of localChildren(point, "rates")) {
    if (elementType(table) !== "RateTable") continue;
    const collections = localChildren(table, "rateLineCollection");
    const currency = isoCurrency(
      localChildText(table, "applicableCurrency") ??
        collections
          .map((c) => localChildText(c, "applicableCurrency"))
          .find((c) => c !== undefined),
    );
    const lines: DatexEnergyRateLine[] = [];
    let unreadable = currency === undefined;
    for (const collection of collections) {
      const relative = localChildText(collection, "relativeTimes") === "true";
      for (const line of localChildren(collection, "rateLine")) {
        const type = localChildText(line, "rateLineType");
        const value = amount(localChildText(line, "value"));
        if (type === undefined || value === undefined) {
          unreadable = true;
          continue;
        }
        const description = firstText(localChild(line, "description"));
        lines.push({
          type,
          value,
          ...(type === "perUnit" && deliveryUnit !== undefined ? { unit: deliveryUnit } : {}),
          ...(description === undefined ? {} : { description }),
          ...lineTimes(line, relative),
        });
      }
    }
    // Part of a price is a wrong price: a table missing its currency or a line is not read.
    if (unreadable || currency === undefined) {
      skipped(options, "malformed");
      continue;
    }
    const pricingPolicy = localChildText(localChild(table, "energyPricingPolicy"), "pricingPolicy");
    const id = present(localAttribute(table, "id"));
    out.push({
      kind: "rateTable",
      ...(id === undefined ? {} : { id }),
      currency,
      ...(pricingPolicy === undefined ? {} : { pricingPolicy }),
      lines,
    });
  }
  for (const rate of localChildren(point, "energyProduct").flatMap((p) =>
    localChildren(p, "energyRate"),
  )) {
    const energyRate = energyRateOf(rate);
    if (energyRate === undefined) skipped(options, "malformed");
    else out.push(energyRate);
  }
  return out;
}

/** An `xs:duration` of days, hours, minutes and seconds (`PT15M`), in seconds. */
function durationSeconds(raw: string | undefined): number | undefined {
  const m = raw?.trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (m === null || m === undefined || raw?.trim() === "P" || raw?.trim().endsWith("T")) {
    return undefined;
  }
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  const seconds = Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
  return seconds > 0 ? seconds : undefined;
}

/** An `xs:time` (`01:30:00`) as seconds since midnight. */
function timeSeconds(raw: string | undefined): number | undefined {
  const m = raw?.trim().match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/);
  if (m === null || m === undefined) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? "0");
}

/**
 * A rate line's increment period and the times it applies between: seconds
 * into the session where its collection's times are relative, else times of
 * day.
 */
function lineTimes(line: XmlObject, relative: boolean): Partial<DatexEnergyRateLine> {
  const out: Partial<DatexEnergyRateLine> = {};
  const increment = localChildText(line, "incrementPeriod");
  if (increment !== undefined) {
    const seconds = durationSeconds(increment);
    if (seconds === undefined) out.unreadableTime = true;
    else out.incrementSeconds = seconds;
  }
  for (const [field, second, time] of [
    ["durationStart", "fromSecond", "fromTime"],
    ["durationEnd", "toSecond", "toTime"],
  ] as const) {
    const raw = localChildText(line, field);
    if (raw === undefined) continue;
    const seconds = timeSeconds(raw);
    if (seconds === undefined) out.unreadableTime = true;
    else if (relative) out[second] = seconds;
    else out[time] = raw.trim().slice(0, 5);
  }
  return out;
}

/** An ISO 4217 currency code, upper-cased; undefined for anything else, which no price can be in. */
function isoCurrency(raw: string | undefined): string | undefined {
  const code = raw?.trim().toUpperCase();
  return code !== undefined && /^[A-Z]{3}$/.test(code) ? code : undefined;
}

function amount(raw: string | undefined): number | undefined {
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * An AFIR energy rate, a line per energy price. Undefined when it names no
 * currency or a price lacks its type or value.
 */
function energyRateOf(rate: XmlObject): DatexEnergyRate | undefined {
  const currency = isoCurrency(localChildText(rate, "applicableCurrency"));
  if (currency === undefined) return undefined;
  const lines: DatexEnergyRateLine[] = [];
  for (const price of localChildren(rate, "energyPrice")) {
    const type = localChildText(price, "priceType");
    const value = amount(localChildText(price, "value"));
    if (type === undefined || value === undefined) return undefined;
    const time = localChild(price, "timeBasedApplicability");
    const energy = localChild(price, "energyBasedApplicability");
    const fromMinute = amount(localChildText(time, "fromMinute"));
    const toMinute = amount(localChildText(time, "toMinute"));
    const fromKWh = amount(localChildText(energy, "fromKWh"));
    const toKWh = amount(localChildText(energy, "toKWh"));
    const tax = localChildText(price, "taxIncluded");
    const description = firstText(localChild(price, "additionalInformation"));
    lines.push({
      type,
      value,
      ...(description === undefined ? {} : { description }),
      ...(fromMinute === undefined ? {} : { fromMinute }),
      ...(toMinute === undefined ? {} : { toMinute }),
      ...(fromKWh === undefined ? {} : { fromKWh }),
      ...(toKWh === undefined ? {} : { toKWh }),
      ...(tax === "true" || tax === "false" ? { taxIncluded: tax === "true" } : {}),
      ...(localChildren(price, "overallPeriod").length > 0 ? { periodic: true } : {}),
    });
  }
  const pricingPolicy = localChildText(rate, "ratePolicy");
  const id = present(localAttribute(rate, "id"));
  return {
    kind: "energyRate",
    ...(id === undefined ? {} : { id }),
    currency,
    ...(pricingPolicy === undefined ? {} : { pricingPolicy }),
    lines,
  };
}

function refillPointOf(
  point: XmlObject,
  options: DatexDecodeOptions,
): DatexRefillPoint | undefined {
  const id = present(localAttribute(point, "id"));
  if (id === undefined) {
    skipped(options, "malformed");
    return undefined;
  }
  const externalId = present(localChildText(point, "externalIdentifier"));
  const names = multilingual(localChild(point, "name")).map((n) => n.value);
  // Spain names the point by its EVSE id; Slovenia gives the EVSE id as the point's own id.
  // A generated id (Spain's) can look like one by chance, so only a delimited id counts.
  const emi3 = [
    ...names,
    ...(externalId === undefined ? [] : [externalId]),
    ...(id.includes("*") ? [id] : []),
  ].find((candidate) => EMI3_EVSE_ID.test(candidate));
  const chargingMode = localChildText(point, "chargingMode");
  const currentType = localChildText(point, "currentType");
  return {
    id,
    ...(externalId === undefined ? {} : { externalId }),
    ...(emi3 === undefined ? {} : { emi3 }),
    ...(chargingMode === undefined ? {} : { chargingMode }),
    ...(currentType === undefined ? {} : { currentType }),
    connectors: localChildren(point, "connector")
      .map((c) => connectorOf(c, options))
      .filter((c): c is DatexEnergyConnector => c !== undefined),
    rates: ratesOf(point, options),
    ...energyMixOf(point),
  };
}

/**
 * The point's first energy mix: the energy infrastructure namespace's
 * `electricEnergyMix`, or the AFIR profile's `energyProduct` (an
 * `ElectricEnergy` carries the impacts and sources). Undefined when it says
 * nothing.
 */
function energyMixOf(point: XmlObject): { energyMix?: DatexEnergyMix } {
  const node =
    localChildren(point, "electricEnergyMix")[0] ?? localChildren(point, "energyProduct")[0];
  if (node === undefined) return {};
  const productName = firstText(localChild(node, "energyProductName"));
  const green = localChildText(node, "isGreenEnergy");
  const carbonDioxide = amount(localChildText(node, "carbonDioxideImpact"));
  const nuclearWaste = amount(localChildText(node, "nuclearWasteImpact"));
  const sources = localChildren(node, "electricEnergySourceRatio").flatMap((ratio) => {
    const source = localChildText(ratio, "energySource");
    const percentage = amount(localChildText(localChild(ratio, "sourceRatioValue"), "percentage"));
    return source === undefined || percentage === undefined ? [] : [{ source, percentage }];
  });
  const mix: DatexEnergyMix = {
    ...(productName === undefined ? {} : { productName }),
    ...(green === "true" || green === "false" ? { isGreen: green === "true" } : {}),
    ...(carbonDioxide === undefined ? {} : { carbonDioxide }),
    ...(nuclearWaste === undefined ? {} : { nuclearWaste }),
    sources,
  };
  return Object.keys(mix).length === 1 && sources.length === 0 ? {} : { energyMix: mix };
}

function stationOf(
  station: XmlObject,
  options: DatexDecodeOptions,
): DatexEnergyStation | undefined {
  const id = present(localAttribute(station, "id"));
  if (id === undefined) {
    skipped(options, "malformed");
    return undefined;
  }
  return {
    id,
    authMethods: [...new Set(localChildTexts(station, "authenticationAndIdentificationMethods"))],
    points: localChildren(station, "refillPoint")
      // Hydrogen and gas refill points share the table; only charging is read.
      .filter((p) => ["", "ElectricChargingPoint"].includes(elementType(p)))
      .map((p) => refillPointOf(p, options))
      .filter((p): p is DatexRefillPoint => p !== undefined),
  };
}

function siteOf(site: XmlObject, options: DatexDecodeOptions): DatexEnergySite | undefined {
  const id = present(localAttribute(site, "id"));
  if (id === undefined) {
    skipped(options, "malformed");
    return undefined;
  }
  const version = present(localAttribute(site, "version"));
  const point = pointOf(localChild(site, "locationReference"));
  const address = addressOf(site);
  const operator = operatorOf(site);
  const typeOfSite = localChildText(site, "typeOfSite");
  const vehicleTypes = [
    ...new Set(
      localChildren(site, "applicableForVehicles").flatMap((v) =>
        localChildTexts(v, "vehicleType"),
      ),
    ),
  ];
  const openingHours = openingHoursOf(site);
  const lastUpdated = localChildText(site, "lastUpdated");
  const brand = firstText(localChild(site, "brand"));
  const entrance = pointOf(localChild(site, "entrance"));
  return {
    id,
    ...(version === undefined ? {} : { version }),
    names: multilingual(localChild(site, "name")),
    ...(point === undefined ? {} : { point }),
    ...(address === undefined ? {} : { address }),
    ...(operator === undefined ? {} : { operator }),
    ...(typeOfSite === undefined ? {} : { siteType: `siteType:${typeOfSite}` }),
    ...(brand === undefined ? {} : { brand }),
    ...(entrance === undefined ? {} : { entrance }),
    ...(vehicleTypes.length === 0 ? {} : { vehicleTypes }),
    ...(openingHours === undefined ? {} : { openingHours }),
    ...(lastUpdated === undefined ? {} : { lastUpdated }),
    stations: localChildren(site, "energyInfrastructureStation")
      .map((s) => stationOf(s, options))
      .filter((s): s is DatexEnergyStation => s !== undefined),
  };
}

const isEnergyPublication = (p: DatexPublication, type: string): boolean =>
  p.type === type || p.type === "";

/** Every site in the document's energy infrastructure table publications. */
export function parseDatexEnergyTable(
  doc: XmlObject,
  options: DatexDecodeOptions = {},
): DatexEnergySite[] {
  return datexPublications(doc)
    .filter((p) => isEnergyPublication(p, "EnergyInfrastructureTablePublication"))
    .flatMap((p) => localChildren(p.body, "energyInfrastructureTable"))
    .flatMap((table) => localChildren(table, "energyInfrastructureSite"))
    .map((s) => siteOf(s, options))
    .filter((s): s is DatexEnergySite => s !== undefined);
}

const REFILL_POINT_STATUSES = [
  "available",
  "blocked",
  "charging",
  "faulted",
  "inoperative",
  "occupied",
  "outOfOrder",
  "outOfStock",
  "planned",
  "removed",
  "reserved",
  "unavailable",
  "unknown",
] as const;

/**
 * The enumeration value a status is, whatever its case: Lithuania writes
 * `OUTOFORDER` and `Unknown` for v3.7's `outOfOrder` and `unknown`. A value that
 * is no enumeration value is kept as published.
 */
function statusValue(raw: string): string {
  const lower = raw.toLowerCase();
  return REFILL_POINT_STATUSES.find((s) => s.toLowerCase() === lower) ?? raw;
}

/** The id a status names its subject by: an `id` attribute, or a v3.7 `reference`. */
function subjectId(node: XmlObject): string | undefined {
  return (
    present(localAttribute(node, "id")) ??
    present(localAttribute(localChild(node, "reference"), "id"))
  );
}

/** Every refill point status in the document's energy infrastructure status publications. */
export function parseDatexEnergyStatus(
  doc: XmlObject,
  options: DatexDecodeOptions = {},
): DatexEnergyStatus[] {
  const out: DatexEnergyStatus[] = [];
  const publications = datexPublications(doc).filter((p) =>
    isEnergyPublication(p, "EnergyInfrastructureStatusPublication"),
  );
  for (const site of publications.flatMap((p) =>
    localChildren(p.body, "energyInfrastructureSiteStatus"),
  )) {
    const siteId = subjectId(site);
    const siteAt = localChildText(site, "lastUpdated");
    for (const station of localChildren(site, "energyInfrastructureStationStatus")) {
      const stationId = subjectId(station);
      const stationAt = localChildText(station, "lastUpdated") ?? siteAt;
      for (const point of localChildren(station, "refillPointStatus")) {
        const refillPointId = subjectId(point);
        const status = localChildText(point, "status");
        if (refillPointId === undefined || status === undefined) {
          skipped(options, "malformed");
          continue;
        }
        const connectorIndex = present(localAttribute(point, "connectorIndex"));
        const at = localChildText(point, "lastUpdated") ?? stationAt;
        out.push({
          refillPointId,
          ...(siteId === undefined ? {} : { siteId }),
          ...(stationId === undefined ? {} : { stationId }),
          ...(connectorIndex === undefined ? {} : { connectorIndex }),
          ...(at === undefined ? {} : { at }),
          status: statusValue(status),
        });
      }
    }
  }
  return out;
}
