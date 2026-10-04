import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { FuelGrade } from "../grades.js";
import {
  type FuelFeed,
  type ProductInput,
  placeable,
  priceDraft,
  stationDraft,
} from "../station.js";

/** The E-Control fuel types: diesel, Super 95 and CNG (sold by the kilogram). */
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
  prices?: { fuelType?: unknown; amount?: unknown }[];
}

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
 * Super 95, CNG); a later answer adds only its price. `open` says whether the
 * station is open by its opening hours at the moment of the search, not a
 * closure, so it leaves the station operational. A station listed without a price is one whose
 * price the calculator does not show; it gets no product for that type. The
 * search covers three fuel types, so a station's products are not complete.
 * The answer carries no update time, so a price is as of the fetch. Each
 * station's `contact` block is never read: it holds what look like private
 * mail addresses.
 */
export function parseEcontrol(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
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
        rejected++;
        continue;
      }
      const entry = stations.get(id) ?? { station, prices: new Map<FuelGrade, string>() };
      stations.set(id, entry);
      for (const price of station.prices ?? []) {
        const grade = typeof price.fuelType === "string" ? GRADES[price.fuelType] : undefined;
        if (grade === undefined || typeof price.amount !== "number" || !(price.amount > 0)) {
          continue;
        }
        if (!entry.prices.has(grade)) entry.prices.set(grade, price.amount.toFixed(3));
      }
    }
  }

  for (const [stationId, { station, prices }] of stations) {
    const lon = typeof station.location?.longitude === "number" ? station.location.longitude : NaN;
    const lat = typeof station.location?.latitude === "number" ? station.location.latitude : NaN;
    if (!placeable(lon, lat)) {
      rejected++;
      continue;
    }
    const service = serviceOf(station.offerInformation);
    const name = text(station.name);
    const location = station.location ?? {};
    const feature = stationDraft(feed, {
      stationId,
      lon,
      lat,
      fetchedAt: ctx.fetchedAt,
      ...(name ? { name: { lang: "de", text: name } } : {}),
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
    for (const [grade, amount] of prices) {
      out.observations.push(
        priceDraft(feature, { componentKey: grade, amount, currency: "EUR", at: ctx.fetchedAt }),
      );
    }
  }
  out.rejected = rejected;
  return out;
}
