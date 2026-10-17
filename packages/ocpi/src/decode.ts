import type {
  OcpiBusinessDetails,
  OcpiConnector,
  OcpiDisplayText,
  OcpiEnergyMix,
  OcpiEvse,
  OcpiExceptionalPeriod,
  OcpiLocation,
  OcpiOpeningTimes,
  OcpiPrice,
  OcpiPriceComponent,
  OcpiRegularHours,
  OcpiRestrictions,
  OcpiTariff,
  OcpiTariffElement,
} from "./types.js";

export type RawRecord = Record<string, unknown>;

/**
 * A record the decoders cannot turn into a wire type without inventing data:
 * one without usable coordinates (`no_geometry`), or one that breaks OCPI's
 * own rules (`malformed`). A body that is no list at all is `malformed` too.
 */
export class OcpiDecodeError extends Error {
  readonly reason: "malformed" | "no_geometry";

  constructor(message: string, reason: "malformed" | "no_geometry" = "malformed") {
    super(message);
    this.name = "OcpiDecodeError";
    this.reason = reason;
  }
}

export function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty trimmed string; numbers are read as their decimal text. */
export function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A finite number; numeric strings (`"0.3800"`) are read as numbers. */
export function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map(text).filter((v): v is string => v !== undefined);
  return list.length > 0 ? list : undefined;
}

function drop<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/** Decodes a list body: a bare array, an OCPI `{data: [...]}` envelope or an OCPDB `{items: [...]}` page. */
export function decodeOcpiList<T>(payload: Buffer): T[] {
  let body: unknown;
  try {
    body = JSON.parse(payload.toString("utf8"));
  } catch (error) {
    throw new OcpiDecodeError(`not JSON: ${(error as Error).message}`);
  }
  if (Array.isArray(body)) return body as T[];
  if (!isRecord(body)) throw new OcpiDecodeError("the body is neither a list nor an envelope");
  const status = body.status_code;
  if (typeof status === "number" && (status < 1000 || status >= 2000)) {
    throw new OcpiDecodeError(`OCPI status ${status}: ${text(body.status_message) ?? "failure"}`);
  }
  for (const key of ["data", "items"]) {
    const list = body[key];
    if (Array.isArray(list)) return list as T[];
  }
  throw new OcpiDecodeError("the envelope carries no list in data or items");
}

/** The eMI3 id in its separator-free upper-case form. */
export function normaliseEmi3(id: string): string {
  return id.replace(/[*\s]/g, "").toUpperCase();
}

const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

function parseWatts(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(kw|w)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]?.replace(",", "."));
  const watts = match[2]?.toLowerCase() === "kw" ? amount * 1000 : amount;
  return watts > 0 ? watts : undefined;
}

/**
 * The connector's maximum power in kW: the published figure, else
 * voltage x amperage x phases when all three are known (3 phases for
 * `AC_3_PHASE`, otherwise 1), else undefined.
 */
export function connectorPowerKw(connector: OcpiConnector): number | undefined {
  const kw = (watts: number): number => Math.round(watts) / 1000;
  if (connector.max_electric_power !== undefined) return kw(connector.max_electric_power);
  const { max_voltage: volts, max_amperage: amps } = connector;
  if (volts === undefined || amps === undefined || volts <= 0 || amps <= 0) return undefined;
  const phases = connector.power_type === "AC_3_PHASE" ? 3 : 1;
  return kw(volts * amps * phases);
}

function displayTexts(value: unknown): OcpiDisplayText[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: OcpiDisplayText[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const body = text(entry.text);
    if (body !== undefined) list.push({ language: text(entry.language) ?? "", text: body });
  }
  return list.length > 0 ? list : undefined;
}

function businessDetails(value: unknown): OcpiBusinessDetails | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name);
  if (name === undefined) return undefined;
  return drop({ name, website: text(value.website) });
}

function coordinates(value: unknown): { latitude: number; longitude: number } | undefined {
  if (!isRecord(value)) return undefined;
  const latitude = num(value.latitude);
  const longitude = num(value.longitude);
  if (latitude === undefined || longitude === undefined) return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

function clock(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw);
  return match ? `${match[1]?.padStart(2, "0")}:${match[2]}` : raw;
}

function weekday(value: unknown): number | undefined {
  const number = num(value);
  if (number !== undefined && Number.isInteger(number) && number >= 1 && number <= 7) return number;
  const name = text(value)?.toUpperCase();
  const index = name === undefined ? -1 : WEEKDAYS.indexOf(name);
  return index < 0 ? undefined : index + 1;
}

function periods(value: unknown): OcpiExceptionalPeriod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: OcpiExceptionalPeriod[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const begin = text(entry.period_begin);
    const end = text(entry.period_end);
    if (begin !== undefined && end !== undefined)
      list.push({ period_begin: begin, period_end: end });
  }
  return list.length > 0 ? list : undefined;
}

function openingTimes(value: unknown): OcpiOpeningTimes | undefined {
  if (!isRecord(value)) return undefined;
  const regular: OcpiRegularHours[] = [];
  if (Array.isArray(value.regular_hours)) {
    for (const entry of value.regular_hours) {
      if (!isRecord(entry)) continue;
      const day = weekday(entry.weekday);
      const begin = clock(entry.period_begin);
      const end = clock(entry.period_end);
      if (day !== undefined && begin !== undefined && end !== undefined) {
        regular.push({ weekday: day, period_begin: begin, period_end: end });
      }
    }
  }
  const always = value.twentyfourseven ?? value.twenty_four_seven;
  if (typeof always !== "boolean" && regular.length === 0) return undefined;
  return drop({
    twentyfourseven: typeof always === "boolean" ? always : false,
    regular_hours: regular.length > 0 ? regular : undefined,
    exceptional_openings: periods(value.exceptional_openings),
    exceptional_closings: periods(value.exceptional_closings),
  });
}

function normaliseConnector(raw: unknown): OcpiConnector {
  if (!isRecord(raw)) throw new OcpiDecodeError("a connector is not an object");
  const id = text(raw.id);
  if (id === undefined) throw new OcpiDecodeError("a connector has no id");
  return drop({
    id,
    standard: text(raw.standard),
    format: text(raw.format),
    power_type: text(raw.power_type),
    max_voltage: num(raw.max_voltage ?? raw.voltage),
    max_amperage: num(raw.max_amperage ?? raw.amperage),
    max_electric_power: parseWatts(raw.max_electric_power),
    capabilities: textList(raw.capabilities)?.map((c) => c.toUpperCase()),
    tariff_ids: textList(raw.tariff_ids),
    terms_and_conditions: text(raw.terms_and_conditions),
    last_updated: text(raw.last_updated),
    original_id: text(raw.original_id),
  });
}

function normaliseEvse(raw: unknown): OcpiEvse {
  if (!isRecord(raw)) throw new OcpiDecodeError("an EVSE is not an object");
  const uid = text(raw.uid) ?? text(raw.evse_id);
  if (uid === undefined) throw new OcpiDecodeError("an EVSE has neither uid nor evse_id");
  const connectors = Array.isArray(raw.connectors) ? raw.connectors.map(normaliseConnector) : [];
  const status = text(raw.status)?.toUpperCase();
  return drop({
    uid,
    evse_id: text(raw.evse_id),
    status,
    capabilities: textList(raw.capabilities),
    connectors,
    floor_level: text(raw.floor_level),
    coordinates: coordinates(raw.coordinates),
    physical_reference: text(raw.physical_reference),
    directions: displayTexts(raw.directions),
    parking_restrictions: textList(raw.parking_restrictions),
    last_updated: text(raw.last_updated),
    status_last_updated: text(raw.status_last_updated),
    original_uid: text(raw.original_uid),
  });
}

/** Reads one OCPI location, with the OCPDB extras and 2.3.0 fields, as the wire type. */
export function normaliseLocation(raw: unknown): OcpiLocation {
  if (!isRecord(raw)) throw new OcpiDecodeError("a location is not an object");
  const id = text(raw.id);
  if (id === undefined) throw new OcpiDecodeError("a location has no id");
  const position = coordinates(raw.coordinates);
  if (position === undefined) {
    throw new OcpiDecodeError(`location ${id} has no usable coordinates`, "no_geometry");
  }
  return drop({
    country_code: text(raw.country_code)?.toUpperCase(),
    party_id: text(raw.party_id)?.toUpperCase(),
    id,
    publish: typeof raw.publish === "boolean" ? raw.publish : undefined,
    name: text(raw.name),
    address: text(raw.address),
    city: text(raw.city),
    postal_code: text(raw.postal_code),
    state: text(raw.state),
    country: text(raw.country)?.toUpperCase(),
    coordinates: position,
    parking_type: text(raw.parking_type),
    evses: Array.isArray(raw.evses) ? raw.evses.map(normaliseEvse) : [],
    directions: displayTexts(raw.directions),
    operator: businessDetails(raw.operator),
    suboperator: businessDetails(raw.suboperator),
    owner: businessDetails(raw.owner),
    facilities: textList(raw.facilities),
    time_zone: text(raw.time_zone),
    opening_times: openingTimes(raw.opening_times),
    charging_when_closed:
      typeof raw.charging_when_closed === "boolean" ? raw.charging_when_closed : undefined,
    last_updated: text(raw.last_updated),
    source: text(raw.source),
    original_id: text(raw.original_id),
  });
}

/**
 * A 2.2.1 `Price` (`excl_vat`, `incl_vat`) or a 2.3.0 `PriceLimit`
 * (`before_taxes`, `after_taxes`), which 2.3.0's `min_price` and
 * `max_price` are; a bare number is the amount before tax.
 */
function price(value: unknown): OcpiPrice | undefined {
  if (isRecord(value)) {
    const exclVat = num(value.excl_vat ?? value.before_taxes);
    if (exclVat === undefined) return undefined;
    return drop({ excl_vat: exclVat, incl_vat: num(value.incl_vat ?? value.after_taxes) });
  }
  const amount = num(value);
  return amount === undefined ? undefined : { excl_vat: amount };
}

function vat(component: RawRecord): number | undefined {
  const inline = num(component.vat);
  if (inline !== undefined) return inline;
  if (!Array.isArray(component.taxes)) return undefined;
  // Another tax (a city levy) is no VAT, and a tax that names nothing may be either.
  const named = component.taxes
    .filter(isRecord)
    .find((tax) => text(tax.name)?.toUpperCase() === "VAT");
  return num(named?.percentage);
}

function priceComponent(raw: unknown): OcpiPriceComponent {
  if (!isRecord(raw)) throw new OcpiDecodeError("a price component is not an object");
  const type = text(raw.type)?.toUpperCase();
  const amount = num(raw.price);
  if (type === undefined || amount === undefined) {
    throw new OcpiDecodeError("a price component has no type or price");
  }
  return drop({ type, price: amount, vat: vat(raw), step_size: num(raw.step_size) });
}

const RESTRICTIONS: ReadonlySet<string> = new Set([
  "start_time",
  "end_time",
  "start_date",
  "end_date",
  "min_kwh",
  "max_kwh",
  "min_current",
  "max_current",
  "min_power",
  "max_power",
  "min_duration",
  "max_duration",
  "day_of_week",
  "reservation",
  "booking",
]);

/**
 * An element's restrictions. One set to a value the decoder cannot read, or
 * one OCPI does not define, is named in `unreadable` rather than left out:
 * left out, it would apply the element beyond what was published. Nulls are
 * unset. Values are kept as written for the mapping to judge, except that a
 * kWh or duration bound of 0 is unset (NDW and OCPDB write 0 for an unset
 * `max_duration`).
 */
function restrictions(raw: unknown): OcpiRestrictions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) return { unreadable: ["restrictions"] };
  const unreadable: string[] = [];
  const read = <T>(key: string, value: T | undefined): T | undefined => {
    if (value === undefined && raw[key] !== undefined && raw[key] !== null) unreadable.push(key);
    return value;
  };
  const amount = (key: string) => read(key, num(raw[key]));
  const nonZero = (key: string) => {
    const value = amount(key);
    return value === 0 ? undefined : value;
  };
  const result = drop<OcpiRestrictions>({
    start_time: read("start_time", clock(raw.start_time)),
    end_time: read("end_time", clock(raw.end_time)),
    start_date: read("start_date", text(raw.start_date)),
    end_date: read("end_date", text(raw.end_date)),
    min_kwh: nonZero("min_kwh"),
    max_kwh: nonZero("max_kwh"),
    min_current: amount("min_current"),
    max_current: amount("max_current"),
    min_power: amount("min_power"),
    max_power: amount("max_power"),
    min_duration: nonZero("min_duration"),
    max_duration: nonZero("max_duration"),
    day_of_week: textList(raw.day_of_week)?.map((d) => d.toUpperCase()),
    reservation: read("reservation", text(raw.reservation)),
    booking: read("booking", text(raw.booking)?.toUpperCase()),
  });
  const days = raw.day_of_week;
  if (
    days !== undefined &&
    days !== null &&
    (!Array.isArray(days) || (result.day_of_week ?? []).length !== days.length)
  ) {
    unreadable.push("day_of_week");
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!RESTRICTIONS.has(key) && value !== undefined && value !== null) unreadable.push(key);
  }
  if (unreadable.length > 0) result.unreadable = unreadable;
  return Object.keys(result).length > 0 ? result : undefined;
}

function element(raw: unknown): OcpiTariffElement {
  if (!isRecord(raw)) throw new OcpiDecodeError("a tariff element is not an object");
  const components = Array.isArray(raw.price_components) ? raw.price_components : [];
  return drop({
    price_components: components.map(priceComponent),
    restrictions: restrictions(raw.restrictions),
  });
}

function energyMix(value: unknown): OcpiEnergyMix | undefined {
  if (!isRecord(value)) return undefined;
  const sources = (Array.isArray(value.energy_sources) ? value.energy_sources : [])
    .filter(isRecord)
    .flatMap((entry) => {
      const source = text(entry.source)?.toUpperCase();
      const percentage = num(entry.percentage);
      return source === undefined || percentage === undefined ? [] : [{ source, percentage }];
    });
  const impacts = (Array.isArray(value.environ_impact) ? value.environ_impact : [])
    .filter(isRecord)
    .flatMap((entry) => {
      const category = text(entry.category)?.toUpperCase();
      const amount = num(entry.amount);
      return category === undefined || amount === undefined ? [] : [{ category, amount }];
    });
  const mix = drop<OcpiEnergyMix>({
    is_green_energy: typeof value.is_green_energy === "boolean" ? value.is_green_energy : undefined,
    energy_sources: sources.length > 0 ? sources : undefined,
    environ_impact: impacts.length > 0 ? impacts : undefined,
    supplier_name: text(value.supplier_name),
    energy_product_name: text(value.energy_product_name),
  });
  return Object.keys(mix).length > 0 ? mix : undefined;
}

/**
 * Reads one OCPI tariff, with the OCPDB `taxes[]` and the 2.3.0
 * `tax_included`, as the wire type. `tax_included` is kept as written
 * (upper-cased), a value OCPI does not define included, for the mapping to judge.
 */
export function normaliseTariff(raw: unknown): OcpiTariff {
  if (!isRecord(raw)) throw new OcpiDecodeError("a tariff is not an object");
  const id = text(raw.id);
  if (id === undefined) throw new OcpiDecodeError("a tariff has no id");
  const currency = text(raw.currency)?.toUpperCase();
  if (currency === undefined) throw new OcpiDecodeError(`tariff ${id} has no currency`);
  return drop({
    country_code: text(raw.country_code)?.toUpperCase(),
    party_id: text(raw.party_id)?.toUpperCase(),
    id,
    currency,
    type: text(raw.type)?.toUpperCase(),
    name: text(raw.name),
    tariff_alt_text: displayTexts(raw.tariff_alt_text),
    tariff_alt_url: text(raw.tariff_alt_url),
    min_price: price(raw.min_price),
    max_price: price(raw.max_price),
    elements: Array.isArray(raw.elements) ? raw.elements.map(element) : [],
    start_date_time: text(raw.start_date_time),
    end_date_time: text(raw.end_date_time),
    energy_mix: energyMix(raw.energy_mix),
    tax_included: text(raw.tax_included)?.toUpperCase(),
    last_updated: text(raw.last_updated),
    source: text(raw.source),
    original_id: text(raw.original_id),
  });
}
