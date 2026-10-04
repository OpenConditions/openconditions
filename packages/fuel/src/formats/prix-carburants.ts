import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { zonedWallClockToInstant } from "@openconditions/model";
import type { FuelGrade } from "../grades.js";
import {
  availabilityDraft,
  type FuelFeed,
  placeable,
  priceDraft,
  stationDraft,
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

type Station = Record<string, unknown>;

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

/**
 * France's instant fuel-price flux (`prix-des-carburants-en-france-flux-instantane-v2`
 * on data.economie.gouv.fr): every station with each grade's price and its own
 * update time, and the grades out of stock. The flux covers the six grades
 * the ministry tracks, so a station's products are complete: a grade with
 * neither a price nor a stock-out is one it does not sell.
 */
export function parsePrixCarburants(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  for (const payload of payloads["main"] ?? []) {
    const stations = JSON.parse(payload.toString("utf8").replace(/^﻿/, "")) as unknown;
    if (!Array.isArray(stations)) throw new Error("prix-carburants: the export is not a list");
    for (const station of stations as Station[]) {
      const geom = station["geom"] as { lon?: unknown; lat?: unknown } | null | undefined;
      const lon = typeof geom?.lon === "number" ? geom.lon : Number.NaN;
      const lat = typeof geom?.lat === "number" ? geom.lat : Number.NaN;
      const stationId =
        typeof station["id"] === "number" || typeof station["id"] === "string"
          ? String(station["id"])
          : undefined;
      if (stationId === undefined || !placeable(lon, lat)) {
        rejected++;
        continue;
      }
      const available = names(station["carburants_disponibles"]);
      const unavailable = names(station["carburants_indisponibles"]);
      const products: {
        grade: FuelGrade;
        inStock: boolean;
        price?: { amount: string; at: string };
      }[] = [];
      for (const { field, name, grade } of GRADES) {
        const outOfStock =
          unavailable.has(name) || text(station[`${field}_rupture_type`]) !== undefined;
        const amount = station[`${field}_prix`];
        const listed = typeof amount === "number" && amount > 0;
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
      const departement = text(station["code_departement"]);
      const feature = stationDraft(feed, {
        stationId,
        lon,
        lat,
        fetchedAt: ctx.fetchedAt,
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
        productsComplete: true,
        products: products.map(({ grade }) => ({ key: grade, grade })),
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
  out.rejected = rejected;
  return out;
}
