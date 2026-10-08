import type { RecordDraft } from "@openconditions/ingest-framework";
import {
  OCPI_DAYS,
  OCPI_TARIFF_DIMENSIONS,
  OCPI_TARIFF_TYPES,
} from "@openconditions/model-charging";
import type { OcpiPrice, OcpiRestrictions, OcpiTariff } from "@openconditions/ocpi";
import {
  type ChargingFeed,
  clean,
  freshness,
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

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const nonNegative = (n: number | undefined) =>
  n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
/** A maximum of zero is OCPI's way of not setting one. */
const positive = (n: number | undefined) =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;

function restrictionsOf(r: OcpiRestrictions | undefined): Record<string, unknown> | undefined {
  if (r === undefined) return undefined;
  const days = (r.day_of_week ?? [])
    .map((d) => OCPI_DAYS[d as keyof typeof OCPI_DAYS])
    .filter((d) => d !== undefined);
  const seconds = (n: number | undefined) =>
    n === undefined ? undefined : { value: n, unit: "s" };
  const fields: Record<string, unknown> = {
    startTime: r.start_time !== undefined && CLOCK.test(r.start_time) ? r.start_time : undefined,
    endTime: r.end_time !== undefined && CLOCK.test(r.end_time) ? r.end_time : undefined,
    startDate: r.start_date !== undefined && DATE.test(r.start_date) ? r.start_date : undefined,
    endDate: r.end_date !== undefined && DATE.test(r.end_date) ? r.end_date : undefined,
    days: days.length === 0 ? undefined : [...new Set(days)],
    minKwh: nonNegative(r.min_kwh),
    maxKwh: positive(r.max_kwh),
    minCurrentA: nonNegative(r.min_current),
    maxCurrentA: positive(r.max_current),
    minPowerKw: nonNegative(r.min_power),
    maxPowerKw: positive(r.max_power),
    // OCPI durations are seconds, whatever a publisher's own documentation says.
    minDuration: seconds(nonNegative(r.min_duration)),
    maxDuration: seconds(positive(r.max_duration)),
    reservation: r.reservation === undefined ? undefined : RESERVATIONS[r.reservation],
  };
  const written = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return Object.keys(written).length === 0 ? undefined : written;
}

/**
 * An `energy_tariff` offer for one tariff of a site: its subject is the site,
 * and the connectors it applies to name it in `tariffRefs`. OCPI prices are
 * before tax unless the tariff says they include it, so the price bounds take
 * the matching side of OCPI's pair. Undefined when no element holds a priced
 * component the model knows: text alone is the site's `tariffText`, never an
 * offer.
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
  const elements = tariff.elements.flatMap((element) => {
    const components = element.price_components.flatMap((c) => {
      const type = OCPI_TARIFF_DIMENSIONS[c.type];
      if (type === undefined || !Number.isFinite(c.price) || c.price < 0) return [];
      const vat = c.vat;
      const step = c.step_size;
      return [
        {
          type,
          price: { amount: money(c.price), currency },
          ...(vat !== undefined && Number.isFinite(vat) && vat >= 0 && vat <= 100
            ? { vatPct: vat }
            : {}),
          ...(step !== undefined && Number.isInteger(step) && step > 0 ? { stepSize: step } : {}),
          ...(UNITS[type] === undefined ? {} : { unit: UNITS[type] }),
        },
      ];
    });
    if (components.length === 0) return [];
    const restrictions = restrictionsOf(element.restrictions);
    return [{ components, ...(restrictions === undefined ? {} : { restrictions }) }];
  });
  if (elements.length === 0) return undefined;

  const includesVat = tariff.tax_included === "YES";
  const bound = (price: OcpiPrice | undefined) => {
    const amount = includesVat ? price?.incl_vat : price?.excl_vat;
    return amount === undefined || !Number.isFinite(amount) || amount < 0
      ? undefined
      : { amount: money(amount), currency };
  };
  const minPrice = bound(tariff.min_price);
  const maxPrice = bound(tariff.max_price);
  const tariffType = tariff.type === undefined ? undefined : OCPI_TARIFF_TYPES[tariff.type];
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
    ...(tariff.tax_included === "N/A" ? {} : { priceIncludesVat: includesVat }),
    ...(altText.length === 0 ? {} : { altText }),
    ...(url === undefined ? {} : { url }),
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
