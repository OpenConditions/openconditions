import type { RecordDraft } from "@openconditions/ingest-framework";
import {
  OCPI_DAYS,
  OCPI_TARIFF_DIMENSIONS,
  OCPI_TARIFF_TYPES,
} from "@openconditions/model-charging";
import type { OcpiPrice, OcpiRestrictions, OcpiTariff } from "@openconditions/ocpi";
import { energyMixDraft, ocpiEnergyMix } from "./energy-mix.js";
import {
  type ChargingFeed,
  clean,
  freshness,
  own,
  pointLocation,
  provenance,
  siteId,
  type Upstream,
  utcInstant,
  webUrl,
} from "./records.js";

/**
 * The id of a site's offer for one of its tariffs. A tariff id is reduced to
 * `[A-Za-z0-9._-]`, every other character written as `_`.
 */
export function tariffOfferId(
  feed: Pick<ChargingFeed, "id">,
  stationId: string,
  tariffId: string,
): string {
  return `oc:offer:${feed.id}:${stationId}:${tariffId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * The key each of one site's tariff ids takes in its offer id: the id as
 * `tariffOfferId` reduces it, and an id that reduces to a key another id
 * already took gets `_2`, `_3`… so two tariffs never share an offer.
 */
export function tariffKeys(ids: Iterable<string>): Map<string, string> {
  const keys = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of ids) {
    if (keys.has(id)) continue;
    const reduced = id.replace(/[^A-Za-z0-9._-]/g, "_");
    let key = reduced;
    for (let n = 2; taken.has(key); n++) key = `${reduced}_${n}`;
    taken.add(key);
    keys.set(id, key);
  }
  return keys;
}

/** A decimal string of a price, without a float's tail. */
const money = (amount: number) => amount.toFixed(6).replace(/\.?0+$/, "");

/** What a priced unit of each component type is: a kilowatt-hour, an hour. */
const UNITS: Readonly<Record<string, string>> = {
  energy: "kW.h",
  time: "h",
  parking_time: "h",
};

const RESERVATIONS: Readonly<Record<string, string>> = {
  RESERVATION: "reservation",
  RESERVATION_EXPIRES: "reservation_expires",
};

/** OCPI 2.3.0 `BookingRestrictionType`: what of a booking an element prices. */
const BOOKINGS: Readonly<Record<string, string>> = {
  BOOKING: "booking",
  BOOKING_EXPIRES: "booking_expires",
  BOOKING_CANCELLATION_FEES: "booking_cancellation_fees",
  BOOKING_OVERTIME: "booking_overtime",
};

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Marks a restriction that is set but cannot be read. */
const UNREADABLE = Symbol("unreadable");

/**
 * An element's restrictions as the model holds them; null when one of them
 * cannot be read (an unknown day or reservation type, a time or date off
 * OCPI's syntax, a negative bound, one the decoder could not read). Left out,
 * it would apply the element beyond what was published.
 */
function restrictionsOf(r: OcpiRestrictions | undefined): Record<string, unknown> | null {
  if (r === undefined) return {};
  if ((r.unreadable ?? []).length > 0) return null;
  const pattern = (value: string | undefined, syntax: RegExp) =>
    value === undefined ? undefined : syntax.test(value) ? value : UNREADABLE;
  const min = (n: number | undefined) =>
    n === undefined ? undefined : Number.isFinite(n) && n >= 0 ? n : UNREADABLE;
  // OCPI bounds a maximum exclusively, so 0 would match nothing; NDW and
  // OCPDB write it for an unset one, and it is read as unset.
  const max = (n: number | undefined) => (n === 0 ? undefined : min(n));
  const seconds = (n: number | undefined | typeof UNREADABLE) =>
    typeof n === "number" ? { value: n, unit: "s" } : n;
  const days = r.day_of_week?.map(
    (d): string | typeof UNREADABLE => own<string>(OCPI_DAYS, d) ?? UNREADABLE,
  );
  const fields: Record<string, unknown> = {
    startTime: pattern(r.start_time, CLOCK),
    endTime: pattern(r.end_time, CLOCK),
    startDate: pattern(r.start_date, DATE),
    endDate: pattern(r.end_date, DATE),
    days:
      days === undefined || days.length === 0
        ? undefined
        : days.includes(UNREADABLE)
          ? UNREADABLE
          : [...new Set(days)],
    minKwh: min(r.min_kwh),
    maxKwh: max(r.max_kwh),
    minCurrentA: min(r.min_current),
    maxCurrentA: max(r.max_current),
    minPowerKw: min(r.min_power),
    maxPowerKw: max(r.max_power),
    // OCPI durations are seconds, whatever a publisher's own documentation says.
    minDuration: seconds(min(r.min_duration)),
    maxDuration: seconds(max(r.max_duration)),
    reservation:
      r.reservation === undefined ? undefined : (own(RESERVATIONS, r.reservation) ?? UNREADABLE),
    booking: r.booking === undefined ? undefined : (own(BOOKINGS, r.booking) ?? UNREADABLE),
  };
  if (Object.values(fields).includes(UNREADABLE)) return null;
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/**
 * The tariff's elements as the model holds them, each with the price
 * components of a type the model knows; an element with none is left out.
 * OCPI looks the price of each dimension up in the first element that has a
 * component of it and whose restrictions match, so leaving out an element
 * without a known dimension changes no known dimension's price. An element
 * restricted to a booking (2.3.0 `booking`) or a reservation prices that, as
 * its restriction says. Null when a kept element's restrictions cannot be
 * read: leaving that element out would let a later one of its dimensions, or
 * none, price what it prices.
 */
function elementsOf(tariff: OcpiTariff): Record<string, unknown>[] | null {
  const elements: Record<string, unknown>[] = [];
  for (const element of tariff.elements) {
    const components = element.price_components.flatMap((c) => {
      const type = own(OCPI_TARIFF_DIMENSIONS, c.type);
      if (type === undefined || !Number.isFinite(c.price) || c.price < 0) return [];
      const vat = c.vat;
      const step = c.step_size;
      return [
        {
          type,
          price: { amount: money(c.price), currency: tariff.currency },
          ...(vat !== undefined && Number.isFinite(vat) && vat >= 0 && vat <= 100
            ? { vatPct: vat }
            : {}),
          ...(step !== undefined && Number.isInteger(step) && step > 0 ? { stepSize: step } : {}),
          ...(UNITS[type] === undefined ? {} : { unit: UNITS[type] }),
        },
      ];
    });
    if (components.length === 0) continue;
    const restrictions = restrictionsOf(element.restrictions);
    if (restrictions === null) return null;
    elements.push({
      components,
      ...(Object.keys(restrictions).length === 0 ? {} : { restrictions }),
    });
  }
  return elements;
}

/**
 * Whether a tariff holds a priced element whose restrictions cannot be read:
 * no offer can state it without applying that element more widely or not at
 * all, so the tariff is a source record the parse could not use.
 */
export function unreadableTariff(tariff: OcpiTariff): boolean {
  return elementsOf(tariff) === null;
}

/** What `tax_included` says of the prices: they include tax, exclude it, or no tax applies. */
const TAX_INCLUDED: ReadonlyMap<string, boolean | null> = new Map([
  ["YES", true],
  ["NO", false],
  ["N/A", null],
]);

/**
 * The enumerated values of a tariff its offer is published without: a price
 * component of a dimension the model does not know, a tariff type or
 * `tax_included` OCPI does not define, and an energy source or environmental
 * impact of a category OCPI does not define.
 */
export function tariffUnreadValues(tariff: OcpiTariff): number {
  let unread = 0;
  for (const element of tariff.elements) {
    unread += element.price_components.filter(
      (c) => own(OCPI_TARIFF_DIMENSIONS, c.type) === undefined,
    ).length;
  }
  if (tariff.type !== undefined && own(OCPI_TARIFF_TYPES, tariff.type) === undefined) unread++;
  if (tariff.tax_included !== undefined && !TAX_INCLUDED.has(tariff.tax_included)) unread++;
  ocpiEnergyMix(tariff.energy_mix, () => {
    unread++;
  });
  return unread;
}

/**
 * An `energy_tariff` offer for one tariff of a site: its subject is the site,
 * and the connectors it applies to name it in `tariffRefs`. OCPI prices are
 * before tax unless the tariff says they include it (`tax_included` `YES`),
 * so the price bounds take the matching side of OCPI's pair. A tariff that
 * says no tax applies (`N/A`), or says something OCPI does not define,
 * writes no `priceIncludesVat`. Undefined when no element holds a priced
 * component the model knows (text alone is the site's `tariffText`, never an
 * offer), or when one that does has restrictions that cannot be read
 * (`unreadableTariff`).
 */
export function tariffDraft(
  feed: ChargingFeed,
  stationId: string,
  tariff: OcpiTariff,
  ctx: {
    fetchedAt: string;
    point: [number, number];
    upstream?: Upstream;
    /** The tariff's key among the site's tariffs (`tariffKeys`); its id by default. */
    key?: string;
  },
): RecordDraft | undefined {
  const currency = tariff.currency;
  const elements = elementsOf(tariff);
  if (elements === null || elements.length === 0) return undefined;

  const includesVat = tariff.tax_included === "YES";
  const vatStated =
    tariff.tax_included === undefined ? false : TAX_INCLUDED.get(tariff.tax_included);
  const bound = (price: OcpiPrice | undefined) => {
    const amount = includesVat ? price?.incl_vat : price?.excl_vat;
    return amount === undefined || !Number.isFinite(amount) || amount < 0
      ? undefined
      : { amount: money(amount), currency };
  };
  const minPrice = bound(tariff.min_price);
  const maxPrice = bound(tariff.max_price);
  const tariffType = own(OCPI_TARIFF_TYPES, tariff.type);
  const altText = (tariff.tariff_alt_text ?? []).flatMap((t) => {
    const text = clean(t.text);
    return text === undefined ? [] : [{ lang: clean(t.language)?.toLowerCase() ?? "und", text }];
  });
  const url = webUrl(tariff.tariff_alt_url);
  const instant = (value: string | undefined) => {
    const ms = value === undefined ? Number.NaN : Date.parse(value);
    return Number.isFinite(ms) ? utcInstant(new Date(ms)) : undefined;
  };
  const start = instant(tariff.start_date_time);
  const end = instant(tariff.end_date_time);
  const energyMix = energyMixDraft(ocpiEnergyMix(tariff.energy_mix, () => {}));
  const preauthorize = tariff.preauthorize_amount;
  return {
    id: tariffOfferId(feed, stationId, ctx.key ?? tariff.id),
    class: "offer",
    kind: "energy_tariff",
    temporality: "static",
    subject: { class: "feature", id: siteId(feed, stationId) },
    currency,
    ...(tariffType === undefined ? {} : { tariffType }),
    elements,
    ...(minPrice === undefined ? {} : { minPrice }),
    ...(maxPrice === undefined ? {} : { maxPrice }),
    // A tariff that states no VAT status writes none.
    ...(typeof vatStated === "boolean" ? { priceIncludesVat: vatStated } : {}),
    ...(preauthorize !== undefined && Number.isFinite(preauthorize) && preauthorize >= 0
      ? { preauthorizeAmount: { amount: money(preauthorize), currency } }
      : {}),
    ...(altText.length === 0 ? {} : { altText }),
    ...(url === undefined ? {} : { url }),
    ...(energyMix === undefined ? {} : { energyMix }),
    validity: {
      status: "active",
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
    },
    location: pointLocation(ctx.point),
    provenance: provenance(feed, tariff.id, ctx.upstream),
    freshness: freshness(feed, ctx.fetchedAt),
  };
}
