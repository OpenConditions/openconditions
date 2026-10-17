import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { PAYMENT_METHODS } from "@openconditions/model";
import type { FuelGrade } from "../grades.js";
import { type Interval, interval, osmOpeningHours } from "../hours.js";
import {
  type FuelFeed,
  openStatusDraft,
  type ProductInput,
  priceDraft,
  stationDraft,
  stationPosition,
} from "../station.js";

/**
 * The E-Control fuel types: diesel, Super 95 and CNG (sold by the kilogram).
 * A price of another type is left out and counted as a value not read.
 */
const GRADES: Readonly<Record<string, FuelGrade>> = { DIE: "diesel", SUP: "e5", GAS: "cng" };

interface Station {
  id?: unknown;
  name?: unknown;
  location?: {
    address?: unknown;
    postalCode?: unknown;
    city?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  };
  offerInformation?: { service?: unknown; selfService?: unknown; unattended?: unknown };
  openingHours?: { day?: unknown; from?: unknown; to?: unknown }[];
  paymentMethods?: { cash?: unknown; debitCard?: unknown; creditCard?: unknown; others?: unknown };
  otherServiceOffers?: unknown;
  open?: unknown;
  prices?: { fuelType?: unknown; amount?: unknown }[];
}

type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** The calculator's weekday codes, Monday (`MO`) to Sunday (`SO`); `FE` is public holidays. */
const WEEKDAYS = ["MO", "DI", "MI", "DO", "FR", "SA", "SO"] as const;

/**
 * The station's `openingHours` in the OSM grammar: one `from`-`to` interval
 * per weekday and for public holidays (`FE`), `00:00`-`00:00` for a day it is
 * closed (a Shell station open Monday to Saturday gives it for Sunday and
 * holidays). A weekday missing leaves the week without hours; one whose times
 * cannot be read is counted as a value not read.
 */
function openingHoursOf(station: Station, feedId: string): string | undefined {
  const days = station.openingHours;
  if (!Array.isArray(days) || days.length === 0) return undefined;
  // The day's intervals; undefined when unreadable, null when the day is not listed.
  const dayHours = (code: string): Interval[] | undefined | null => {
    const day = days.find((d) => d.day === code);
    if (day === undefined) return null;
    if (day.from === "00:00" && day.to === "00:00") return [];
    const read =
      typeof day.from === "string" && typeof day.to === "string"
        ? interval(day.from, day.to)
        : undefined;
    return read === undefined ? undefined : [read];
  };
  const week: Interval[][] = [];
  for (const code of [...WEEKDAYS, "FE"]) {
    const hours = dayHours(code);
    if (hours === undefined) {
      recordSkipped(feedId, "unknown_value");
      return undefined;
    }
    if (hours === null && code !== "FE") return undefined;
    if (hours !== null) week.push(hours);
  }
  return osmOpeningHours(week.slice(0, 7), week[7]);
}

/** `paymentMethods`: cash, debit and credit cards, and anything else as `other`. */
function paymentOf(methods: Station["paymentMethods"]): PaymentMethod[] {
  return [
    ...(methods?.cash === true ? (["cash"] as const) : []),
    ...(methods?.debitCard === true ? (["debit_card"] as const) : []),
    ...(methods?.creditCard === true ? (["credit_card"] as const) : []),
    ...(text(methods?.others) ? (["other"] as const) : []),
  ];
}

/** A coordinate: undefined when absent, NaN when present but not a number. */
const coordinate = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined : typeof value === "number" ? value : NaN;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * Who pumps the fuel a station prices: its staff when it offers attended
 * service only, the driver at a self-service-only or unattended station.
 * Undefined when it offers both or says neither, since the one price is then
 * not known to be either's.
 */
function serviceOf(offer: Station["offerInformation"]): ProductInput["service"] {
  const served = offer?.service === true;
  const self = offer?.selfService === true || offer?.unattended === true;
  if (served === self) return undefined;
  return served ? "served" : "self";
}

/**
 * The E-Control Spritpreisrechner's search around a point
 * (`search/gas-stations/by-address`), one answer per fuel type: about ten of
 * the cheapest stations each, with that fuel type's price. The answers are
 * merged by station id, so a station listed for diesel and Super 95 is one
 * station with two products. Its name, position, address and service are the
 * first answer's that lists it (the order of the endpoint's `urls`: diesel,
 * Super 95, CNG); a later answer adds only its price. The station's opening
 * hours, payment methods and free-text other offers are read; `open`, whether
 * the station is open at the moment of the search, is its
 * `facility.open_status` as of the fetch, and leaves the station operational:
 * it is no closure. An `open` that is no boolean is counted as not read. A station listed without a
 * price is one whose price the calculator does not show; it gets no product
 * for that type. The search covers three fuel types, so a station's products
 * are not complete. The answer carries no update time, so a price is as of
 * the fetch. Each station's `contact` block is never read: it holds what look
 * like private mail addresses.
 */
export function parseEcontrol(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const stations = new Map<string, { station: Station; prices: Map<FuelGrade, string> }>();
  for (const payload of payloads["main"] ?? []) {
    const answer = JSON.parse(payload.toString("utf8").replace(/^﻿/, "")) as unknown;
    if (!Array.isArray(answer)) throw new Error("econtrol: the answer is not a list of stations");
    for (const station of answer as Station[]) {
      const id =
        typeof station.id === "number" || typeof station.id === "string"
          ? String(station.id)
          : undefined;
      if (id === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const entry = stations.get(id) ?? { station, prices: new Map<FuelGrade, string>() };
      stations.set(id, entry);
      for (const price of station.prices ?? []) {
        const grade =
          typeof price.fuelType === "string" && Object.hasOwn(GRADES, price.fuelType)
            ? GRADES[price.fuelType]
            : undefined;
        if (grade === undefined) {
          recordSkipped(feed.id, "unknown_value");
          continue;
        }
        if (typeof price.amount !== "number" || !(price.amount > 0)) continue;
        if (!entry.prices.has(grade)) entry.prices.set(grade, price.amount.toFixed(3));
      }
    }
  }

  for (const [stationId, { station, prices }] of stations) {
    const position = stationPosition(
      coordinate(station.location?.longitude),
      coordinate(station.location?.latitude),
    );
    if ("skip" in position) {
      recordSkipped(feed.id, position.skip);
      continue;
    }
    const service = serviceOf(station.offerInformation);
    const name = text(station.name);
    const location = station.location ?? {};
    const openingHours = openingHoursOf(station, feed.id);
    const otherPayment = text(station.paymentMethods?.others);
    const offers = text(station.otherServiceOffers);
    const feature = stationDraft(feed, {
      stationId,
      ...position,
      fetchedAt: ctx.fetchedAt,
      ...(name ? { name: { lang: "de", text: name } } : {}),
      ...(openingHours === undefined ? {} : { openingHours }),
      payment: paymentOf(station.paymentMethods),
      // The cards taken besides debit and credit cards, as the operator lists them.
      ...(otherPayment ? { paymentNotes: { lang: "de", text: otherPayment } } : {}),
      ...(offers ? { description: { lang: "de", text: offers } } : {}),
      address: {
        ...(text(location.address) ? { street: text(location.address) } : {}),
        ...(text(location.postalCode) ? { postalCode: text(location.postalCode) } : {}),
        ...(text(location.city) ? { city: text(location.city) } : {}),
        country: "AT",
      },
      admin: { country: "AT" },
      productsComplete: false,
      products: [...prices.keys()].map((grade) => ({
        key: grade,
        grade,
        ...(service ? { service } : {}),
      })),
    });
    out.features.push(feature);
    if (typeof station.open === "boolean") {
      out.observations.push(openStatusDraft(feature, { open: station.open, at: ctx.fetchedAt }));
    } else if (station.open !== undefined && station.open !== null) {
      recordSkipped(feed.id, "unknown_value");
    }
    for (const [grade, amount] of prices) {
      out.observations.push(
        priceDraft(feature, { componentKey: grade, amount, currency: "EUR", at: ctx.fetchedAt }),
      );
    }
  }
  return out;
}
