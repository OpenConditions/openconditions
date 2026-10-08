import { type DatexPublication, datexPublications } from "./publication.js";
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
  type: string;
  value: number;
  /** The refill point's delivery unit, on a per-unit line. */
  unit?: string;
  description?: string;
}

export interface DatexEnergyRate {
  /** The rate table's own id, where it has one. */
  id?: string;
  /** ISO 4217, upper case. */
  currency: string;
  pricingPolicy?: string;
  lines: DatexEnergyRateLine[];
}

export interface DatexRefillPoint {
  id: string;
  externalId?: string;
  /** The eMI3 EVSE id, as published, when the name or external identifier is one. */
  emi3?: string;
  connectors: DatexEnergyConnector[];
  rates: DatexEnergyRate[];
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
    const day = SPANISH_WEEKDAYS[withoutAccents(m[1] ?? "").toLowerCase()];
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

function connectorOf(connector: XmlObject): DatexEnergyConnector | undefined {
  const type = localChildText(connector, "connectorType");
  if (type === undefined) return undefined;
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

function ratesOf(point: XmlObject): DatexEnergyRate[] {
  const deliveryUnit = localChildText(point, "deliveryUnit");
  const out: DatexEnergyRate[] = [];
  for (const table of localChildren(point, "rates")) {
    if (elementType(table) !== "RateTable") continue;
    const collections = localChildren(table, "rateLineCollection");
    const currency = (
      localChildText(table, "applicableCurrency") ??
      collections.map((c) => localChildText(c, "applicableCurrency")).find((c) => c !== undefined)
    )?.toUpperCase();
    if (currency === undefined) continue;
    const pricingPolicy = localChildText(localChild(table, "energyPricingPolicy"), "pricingPolicy");
    const lines: DatexEnergyRateLine[] = [];
    for (const line of collections.flatMap((c) => localChildren(c, "rateLine"))) {
      const type = localChildText(line, "rateLineType");
      const raw = localChildText(line, "value");
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (type === undefined || !Number.isFinite(value)) continue;
      const description = firstText(localChild(line, "description"));
      lines.push({
        type,
        value,
        ...(type === "perUnit" && deliveryUnit !== undefined ? { unit: deliveryUnit } : {}),
        ...(description === undefined ? {} : { description }),
      });
    }
    const id = present(localAttribute(table, "id"));
    out.push({
      ...(id === undefined ? {} : { id }),
      currency,
      ...(pricingPolicy === undefined ? {} : { pricingPolicy }),
      lines,
    });
  }
  return out;
}

function refillPointOf(point: XmlObject): DatexRefillPoint | undefined {
  const id = present(localAttribute(point, "id"));
  if (id === undefined) return undefined;
  const externalId = present(localChildText(point, "externalIdentifier"));
  const names = multilingual(localChild(point, "name")).map((n) => n.value);
  // Spain names the point by its EVSE id; Slovenia gives the EVSE id as the point's own id.
  // A generated id (Spain's) can look like one by chance, so only a delimited id counts.
  const emi3 = [
    ...names,
    ...(externalId === undefined ? [] : [externalId]),
    ...(id.includes("*") ? [id] : []),
  ].find((candidate) => EMI3_EVSE_ID.test(candidate));
  return {
    id,
    ...(externalId === undefined ? {} : { externalId }),
    ...(emi3 === undefined ? {} : { emi3 }),
    connectors: localChildren(point, "connector")
      .map(connectorOf)
      .filter((c): c is DatexEnergyConnector => c !== undefined),
    rates: ratesOf(point),
  };
}

function stationOf(station: XmlObject): DatexEnergyStation | undefined {
  const id = present(localAttribute(station, "id"));
  if (id === undefined) return undefined;
  return {
    id,
    authMethods: [...new Set(localChildTexts(station, "authenticationAndIdentificationMethods"))],
    points: localChildren(station, "refillPoint")
      // Hydrogen and gas refill points share the table; only charging is read.
      .filter((p) => ["", "ElectricChargingPoint"].includes(elementType(p)))
      .map(refillPointOf)
      .filter((p): p is DatexRefillPoint => p !== undefined),
  };
}

function siteOf(site: XmlObject): DatexEnergySite | undefined {
  const id = present(localAttribute(site, "id"));
  if (id === undefined) return undefined;
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
  return {
    id,
    ...(version === undefined ? {} : { version }),
    names: multilingual(localChild(site, "name")),
    ...(point === undefined ? {} : { point }),
    ...(address === undefined ? {} : { address }),
    ...(operator === undefined ? {} : { operator }),
    ...(typeOfSite === undefined ? {} : { siteType: `siteType:${typeOfSite}` }),
    ...(vehicleTypes.length === 0 ? {} : { vehicleTypes }),
    ...(openingHours === undefined ? {} : { openingHours }),
    ...(lastUpdated === undefined ? {} : { lastUpdated }),
    stations: localChildren(site, "energyInfrastructureStation")
      .map(stationOf)
      .filter((s): s is DatexEnergyStation => s !== undefined),
  };
}

const isEnergyPublication = (p: DatexPublication, type: string): boolean =>
  p.type === type || p.type === "";

/** Every site in the document's energy infrastructure table publications. */
export function parseDatexEnergyTable(doc: XmlObject): DatexEnergySite[] {
  return datexPublications(doc)
    .filter((p) => isEnergyPublication(p, "EnergyInfrastructureTablePublication"))
    .flatMap((p) => localChildren(p.body, "energyInfrastructureTable"))
    .flatMap((table) => localChildren(table, "energyInfrastructureSite"))
    .map(siteOf)
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
export function parseDatexEnergyStatus(doc: XmlObject): DatexEnergyStatus[] {
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
        if (refillPointId === undefined || status === undefined) continue;
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
