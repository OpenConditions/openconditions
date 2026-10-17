import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { FuelGrade } from "../grades.js";
import {
  availabilityDraft,
  type FuelFeed,
  openStatusDraft,
  priceDraft,
  stationDraft,
  stationPosition,
} from "../station.js";

/** The three grades the MTS-K reports, by their field in the answer. */
const GRADES: readonly FuelGrade[] = ["e5", "e10", "diesel"];

type Station = Record<string, unknown>;

/** A coordinate: undefined when absent, NaN when present but not a number. */
const coordinate = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined : typeof value === "number" ? value : NaN;

const text = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/**
 * A German postcode: five digits. The API sends it as a number, which loses
 * the leading zero of the 0xxxx codes (Dresden's 1067 is 01067).
 */
const postalCodeOf = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? String(value).padStart(5, "0")
    : text(value);

/**
 * Tankerkönig's radius search (`list.php`, `type=all`): the stations around a
 * point with their E5, E10 and diesel prices as the Markttransparenzstelle
 * holds them now. A price `false` is a grade the station does not sell (a
 * product known to be unavailable), `null` a price not known (no product).
 * The answer carries no update time, so a price is as of the fetch. The
 * MTS-K tracks three grades only, so a station's products are not complete.
 * `isOpen`, whether the station is open at the moment of the query by the
 * hours and the closures it reported to the MTS-K, is the station's
 * `facility.open_status` as of the fetch; a value that is no boolean is
 * counted as not read.
 */
export function parseTankerkoenig(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  for (const payload of payloads["main"] ?? []) {
    const answer = JSON.parse(payload.toString("utf8").replace(/^﻿/, "")) as {
      ok?: unknown;
      message?: unknown;
      stations?: unknown;
    };
    if (answer.ok !== true) {
      throw new Error(`tankerkoenig: ${text(answer.message) ?? "the answer is not ok"}`);
    }
    if (!Array.isArray(answer.stations)) {
      throw new Error("tankerkoenig: the answer has no stations");
    }
    for (const station of answer.stations as Station[]) {
      const stationId = text(station["id"]);
      if (stationId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const position = stationPosition(coordinate(station["lng"]), coordinate(station["lat"]));
      if ("skip" in position) {
        recordSkipped(feed.id, position.skip);
        continue;
      }
      // A grade with `price` undefined is one the station does not sell.
      const grades = GRADES.flatMap((grade): { grade: FuelGrade; price: string | undefined }[] => {
        const value = station[grade];
        if (value === false) return [{ grade, price: undefined }];
        if (typeof value === "number" && value > 0) return [{ grade, price: value.toFixed(3) }];
        return [];
      });
      const name = text(station["name"]);
      const brand = text(station["brand"]);
      const postalCode = postalCodeOf(station["postCode"]);
      const feature = stationDraft(feed, {
        stationId,
        ...position,
        fetchedAt: ctx.fetchedAt,
        ...(name ? { name: { lang: "de", text: name } } : {}),
        ...(brand ? { brand } : {}),
        address: {
          ...(text(station["street"]) ? { street: text(station["street"]) } : {}),
          ...(text(station["houseNumber"]) ? { houseNumber: text(station["houseNumber"]) } : {}),
          ...(postalCode ? { postalCode } : {}),
          ...(text(station["place"]) ? { city: text(station["place"]) } : {}),
          country: "DE",
        },
        admin: { country: "DE" },
        productsComplete: false,
        products: grades.map(({ grade }) => ({ key: grade, grade })),
      });
      out.features.push(feature);
      const isOpen = station["isOpen"];
      if (typeof isOpen === "boolean") {
        out.observations.push(openStatusDraft(feature, { open: isOpen, at: ctx.fetchedAt }));
      } else if (isOpen !== undefined && isOpen !== null) {
        recordSkipped(feed.id, "unknown_value");
      }
      for (const { grade, price } of grades) {
        out.observations.push(
          price === undefined
            ? availabilityDraft(feature, {
                componentKey: grade,
                available: false,
                at: ctx.fetchedAt,
              })
            : priceDraft(feature, {
                componentKey: grade,
                amount: price,
                currency: "EUR",
                at: ctx.fetchedAt,
              }),
        );
      }
    }
  }
  return out;
}
