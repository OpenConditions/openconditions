import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { zonedWallClockToInstant } from "@openconditions/model";
import type { FuelGrade } from "../grades.js";
import { type Interval, interval, osmOpeningHours } from "../hours.js";
import {
  availabilityDraft,
  type FuelFeed,
  priceDraft,
  stationDraft,
  stationPosition,
  utcInstant,
} from "../station.js";

/** Each grade the ministry prices: its field prefix, its name in the availability lists, the model grade. */
const GRADES: readonly { field: string; name: string; grade: FuelGrade }[] = [
  { field: "gazole", name: "Gazole", grade: "diesel" },
  { field: "sp95", name: "SP95", grade: "e5" },
  { field: "e10", name: "E10", grade: "e10" },
  { field: "sp98", name: "SP98", grade: "sp98" },
  { field: "e85", name: "E85", grade: "e85" },
  { field: "gplc", name: "GPLc", grade: "lpg" },
];

const GRADE_NAMES: ReadonlySet<string> = new Set(GRADES.map(({ name }) => name));

/** What one entry of a station's service list (`services_service`) says about it. */
interface Service {
  amenity?: string;
  /** A card terminal that takes payment round the clock without a cashier. */
  cardTerminal?: true;
  truckSuitable?: true;
  /** A grade the station sells beyond the six the flux prices. */
  grade?: FuelGrade;
}

/**
 * The ministry's service list, verbatim. `Carburant additivé` says the
 * station's grades carry additives, which the flux prices as the standard
 * grades, so it adds nothing to the station; a name not listed here is
 * counted as a value not read.
 */
const SERVICES: Readonly<Record<string, Service>> = {
  "Aire de camping-cars": { amenity: "dumping_station" },
  "Automate CB 24/24": { cardTerminal: true },
  Bar: { amenity: "bar" },
  "Bornes électriques": { amenity: "charging_station" },
  "Boutique alimentaire": { amenity: "food_shopping" },
  "Boutique non alimentaire": { amenity: "shop" },
  "Carburant additivé": {},
  "DAB (Distributeur automatique de billets)": { amenity: "cash_machine" },
  Douches: { amenity: "shower" },
  "Espace bébé": { amenity: "baby_changing" },
  GNV: { grade: "cng" },
  "Lavage automatique": { amenity: "car_wash" },
  "Lavage manuel": { amenity: "car_wash" },
  Laverie: { amenity: "laundry" },
  "Location de véhicule": { amenity: "car_rental" },
  "Piste poids lourds": { truckSuitable: true },
  "Relais colis": { amenity: "parcel_pickup" },
  "Restauration sur place": { amenity: "restaurant" },
  "Restauration à emporter": { amenity: "takeaway" },
  "Services réparation / entretien": { amenity: "vehicle_maintenance" },
  "Station de gonflage": { amenity: "compressed_air" },
  "Toilettes publiques": { amenity: "toilets" },
  "Vente d'additifs carburants": { amenity: "fuel_additives" },
  "Vente de fioul domestique": { amenity: "heating_oil" },
  "Vente de gaz domestique (Butane, Propane)": { amenity: "bottled_gas" },
  "Vente de pétrole lampant": { amenity: "lamp_oil" },
  Wifi: { amenity: "wifi" },
};

type Station = Record<string, unknown>;

/** A coordinate: undefined when absent, NaN when present but not a number. */
const coordinate = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined : typeof value === "number" ? value : NaN;

const ZONELESS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]00:?00)?$/;
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2}:?\d{2}$/;

/**
 * A price's update time as a UTC instant. The ministry's flux publishes Paris
 * wall-clock times without an offset; the economie.gouv.fr export labels
 * them `+00:00` (its 2026-10-03 21:54Z export already held prices updated
 * "23:00:00+00:00"), so a zoneless or UTC-labelled time is read in
 * Europe/Paris (fractional seconds dropped) and only another offset is taken
 * as written. Undefined when the time is missing or unreadable.
 */
function updateTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = value.trim();
  const m = time.match(ZONELESS);
  if (m) {
    const at = zonedWallClockToInstant("Europe/Paris", `${m[1]}T${m[2]}`);
    return at === null ? undefined : utcInstant(at);
  }
  if (!OFFSET.test(time)) return undefined;
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? utcInstant(new Date(ms)) : undefined;
}

const names = (value: unknown): Set<string> =>
  new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const DEPARTEMENT = /^(\d{2}|2[AB])$/;

/** The station's service list read into what it says; a name not mapped is counted. */
function servicesOf(station: Station, feedId: string) {
  const amenities: string[] = [];
  const grades: FuelGrade[] = [];
  let cardTerminal = false;
  let truckSuitable = false;
  for (const name of names(station["services_service"])) {
    const service = Object.hasOwn(SERVICES, name) ? SERVICES[name] : undefined;
    if (service === undefined) {
      recordSkipped(feedId, "unknown_value");
      continue;
    }
    if (service.amenity !== undefined) amenities.push(service.amenity);
    if (service.grade !== undefined) grades.push(service.grade);
    cardTerminal ||= service.cardTerminal === true;
    truckSuitable ||= service.truckSuitable === true;
  }
  return { amenities, grades, cardTerminal, truckSuitable };
}

interface Day {
  "@id"?: unknown;
  "@ferme"?: unknown;
  horaire?: unknown;
}

/**
 * When fuel can be bought, in the OSM grammar. A station with a card terminal
 * that takes payment without a cashier round the clock (`automate 24-24`) is
 * open 24/7. Otherwise the hours are its counter's (`horaires`, a JSON
 * string): per weekday, Monday (`@id` 1) to Sunday, `@ferme` 1 for a day the
 * counter is closed (whatever hours it then carries, 01.00-01.00 mostly), or
 * one or more `HH.MM` intervals. A week with a day neither closed nor given
 * hours has no hours; one whose times cannot be read is counted as a value
 * not read.
 */
function openingHoursOf(station: Station, feedId: string): string | undefined {
  if (station["horaires_automate_24_24"] === "Oui") return "24/7";
  const raw = station["horaires"];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  let horaires: { "@automate-24-24"?: unknown; jour?: unknown };
  try {
    horaires = JSON.parse(raw) as typeof horaires;
  } catch {
    recordSkipped(feedId, "unknown_value");
    return undefined;
  }
  if (horaires["@automate-24-24"] === "1") return "24/7";
  const days = Array.isArray(horaires.jour) ? (horaires.jour as Day[]) : [];
  const week: Interval[][] = [];
  for (let id = 1; id <= 7; id++) {
    const day = days.find((d) => d["@id"] === String(id));
    if (day === undefined) return undefined;
    if (day["@ferme"] === "1") {
      week.push([]);
      continue;
    }
    if (day.horaire === undefined || day.horaire === null) return undefined;
    const intervals: Interval[] = [];
    for (const h of [day.horaire].flat() as { "@ouverture"?: unknown; "@fermeture"?: unknown }[]) {
      const opens = h?.["@ouverture"];
      const closes = h?.["@fermeture"];
      const read =
        typeof opens === "string" && typeof closes === "string"
          ? interval(opens, closes)
          : undefined;
      if (read === undefined) {
        recordSkipped(feedId, "unknown_value");
        return undefined;
      }
      intervals.push(read);
    }
    week.push(intervals);
  }
  return osmOpeningHours(week);
}

/** `pop`: A for a station on a motorway, R on another road. */
function roadClassOf(station: Station, feedId: string): "motorway" | undefined {
  const pop = text(station["pop"]);
  if (pop === "A") return "motorway";
  if (pop !== undefined && pop !== "R") recordSkipped(feedId, "unknown_value");
  return undefined;
}

/**
 * France's instant fuel-price flux (`prix-des-carburants-en-france-flux-instantane-v2`
 * on data.economie.gouv.fr): every station with each grade's price and its own
 * update time, its ruptures, hours, services and whether it is on a
 * motorway. The flux covers the six grades the ministry tracks, so a
 * station's products are complete: a grade with neither a price nor a
 * temporary rupture is one it does not sell, and so is a grade under a
 * definitive rupture. Natural gas, which the flux does not price, is a
 * product when the service list names it.
 */
export function parsePrixCarburants(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  for (const payload of payloads["main"] ?? []) {
    const stations = JSON.parse(payload.toString("utf8").replace(/^﻿/, "")) as unknown;
    if (!Array.isArray(stations)) throw new Error("prix-carburants: the export is not a list");
    for (const station of stations as Station[]) {
      const stationId =
        typeof station["id"] === "number" || typeof station["id"] === "string"
          ? String(station["id"])
          : undefined;
      if (stationId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const geom = station["geom"] as { lon?: unknown; lat?: unknown } | null | undefined;
      const position = stationPosition(coordinate(geom?.lon), coordinate(geom?.lat));
      if ("skip" in position) {
        recordSkipped(feed.id, position.skip);
        continue;
      }
      const available = names(station["carburants_disponibles"]);
      const unavailable = names(station["carburants_indisponibles"]);
      // A grade the lists name that the ministry did not track before is lost to the station.
      for (const name of new Set([...available, ...unavailable])) {
        if (!GRADE_NAMES.has(name)) recordSkipped(feed.id, "unknown_value");
      }
      const products: {
        grade: FuelGrade;
        inStock: boolean;
        price?: { amount: string; at: string };
      }[] = [];
      for (const { field, name, grade } of GRADES) {
        const rupture = text(station[`${field}_rupture_type`]);
        // A definitive rupture is a grade the station no longer sells.
        if (rupture === "definitive") continue;
        // A rupture of a type the parser does not know is still a stock-out.
        if (rupture !== undefined && rupture !== "temporaire") {
          recordSkipped(feed.id, "unknown_value");
        }
        const outOfStock = rupture !== undefined;
        const amount = station[`${field}_prix`];
        const listed = typeof amount === "number" && amount > 0;
        // The lists name all six grades: one unavailable without a rupture is not sold.
        if (!outOfStock && !listed && !available.has(name)) continue;
        // A price is a reading only with the time it was set: undated, it says
        // the grade is sold but not when it cost that.
        const at = updateTime(station[`${field}_maj`]);
        products.push({
          grade,
          inStock: !outOfStock,
          ...(!outOfStock && listed && at !== undefined
            ? { price: { amount: (amount as number).toFixed(3), at } }
            : {}),
        });
      }
      const services = servicesOf(station, feed.id);
      // A grade the service list names beyond the six is sold, but neither priced nor stocked.
      const listedGrades = services.grades.filter((g) => !products.some((p) => p.grade === g));
      const openingHours = openingHoursOf(station, feed.id);
      const roadClass = roadClassOf(station, feed.id);
      const departement = text(station["code_departement"]);
      const feature = stationDraft(feed, {
        stationId,
        ...position,
        fetchedAt: ctx.fetchedAt,
        ...(openingHours === undefined ? {} : { openingHours }),
        ...(roadClass === undefined ? {} : { roadClass }),
        address: {
          ...(text(station["adresse"]) ? { street: text(station["adresse"]) } : {}),
          ...(text(station["cp"]) ? { postalCode: text(station["cp"]) } : {}),
          ...(text(station["ville"]) ? { city: text(station["ville"]) } : {}),
          country: "FR",
        },
        admin: {
          country: "FR",
          ...(departement && DEPARTEMENT.test(departement)
            ? { geocodes: [{ scheme: "iso3166-2", code: `FR-${departement}` }] }
            : {}),
        },
        audience: "public",
        // The card terminal takes the CB network's cards, debit and credit alike.
        ...(services.cardTerminal ? { payment: ["credit_card", "debit_card"] as const } : {}),
        amenities: services.amenities,
        ...(services.truckSuitable ? { truckSuitable: true } : {}),
        productsComplete: true,
        products: [...products.map(({ grade }) => grade), ...listedGrades].map((grade) => ({
          key: grade,
          grade,
        })),
      });
      out.features.push(feature);
      const readings: RecordDraft[] = [];
      for (const { grade, inStock, price } of products) {
        if (price) {
          readings.push(
            priceDraft(feature, {
              componentKey: grade,
              amount: price.amount,
              currency: "EUR",
              at: price.at,
            }),
          );
        }
        // Stock is as the poll found it: a stock-out's start can predate a
        // reading taken before the flux reported it.
        readings.push(
          availabilityDraft(feature, {
            componentKey: grade,
            available: inStock,
            at: ctx.fetchedAt,
          }),
        );
      }
      out.observations.push(...readings);
    }
  }
  return out;
}
