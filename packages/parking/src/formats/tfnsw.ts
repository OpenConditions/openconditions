import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { instantIn, occupancyDrafts, type SiteInput, siteDraft } from "../site.js";

/** One car park of `/v1/carpark/full-list`, in the per-facility shape of the API documentation §2.1.5. */
interface NswFacility {
  facility_id?: string | null;
  facility_name?: string | null;
  spots?: string | null;
  location?: {
    suburb?: string | null;
    address?: string | null;
    latitude?: string | null;
    longitude?: string | null;
  } | null;
  /** The counters of the car park; every value is a string. */
  occupancy?: { total?: string | null } | null;
  MessageDate?: string | null;
}

const TIME_ZONE = "Australia/Sydney";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** A count written as a string of digits. */
function count(value: unknown): number | undefined {
  const t = text(value);
  return t !== undefined && /^\d+$/.test(t) ? Number(t) : undefined;
}

function coordinate(value: unknown): number | undefined {
  const n = Number.parseFloat(text(value) ?? "");
  return Number.isFinite(n) ? n : undefined;
}

/** The car parks of a body: a bare array. */
function facilitiesOf(body: Buffer): NswFacility[] {
  const doc = JSON.parse(body.toString("utf8")) as unknown;
  if (!Array.isArray(doc)) throw new Error("tfnsw: full-list body is not an array");
  return doc as NswFacility[];
}

function siteInput(
  f: NswFacility,
  stationId: string,
  point: [number, number],
  spots: number | undefined,
): SiteInput {
  const name = text(f.facility_name);
  const street = text(f.location?.address);
  const city = text(f.location?.suburb);
  return {
    stationId,
    point,
    lang: "en",
    ...(name === undefined ? {} : { name }),
    type: "park_and_ride",
    usage: ["park_and_ride"],
    address: {
      ...(street === undefined ? {} : { street }),
      ...(city === undefined ? {} : { city }),
    },
    ...(spots === undefined || spots === 0 ? {} : { capacityTotal: spots }),
  };
}

/**
 * Transport for NSW Park&Ride car parks: the `main` payload is the
 * `/carpark/full-list` call. Its swagger gives no example of the body, so
 * each entry is read in the documented per-facility shape (API documentation
 * v2.4 §2.1.5), the shape OpenMapX read one `?facility=` call at a time. Each
 * entry is a park-and-ride site at its `location`; free spaces are the spots
 * less the vehicles counted (`occupancy.total`), at least 0. `MessageDate` is
 * Sydney time. An entry without a location is rejected: no table of points
 * stands in for it.
 *
 * The `zones` are not read. Areas are keyed by vehicle type and user group,
 * and the documented zones are parts of the car park (the sample's one zone
 * is the whole of it); until a live `full-list` shows zones that are for
 * particular vehicles or users, reading a zone as an area would invent one.
 */
export function parseTfnsw(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  let rejected = 0;
  for (const body of payloads["main"] ?? []) {
    for (const f of facilitiesOf(body)) {
      const stationId = text(f.facility_id);
      const lat = coordinate(f.location?.latitude);
      const lon = coordinate(f.location?.longitude);
      if (stationId === undefined || lat === undefined || lon === undefined) {
        rejected++;
        continue;
      }
      if (seen.has(stationId)) continue;
      seen.add(stationId);
      const point: [number, number] = [lon, lat];
      const spots = count(f.spots);
      out.features.push(siteDraft(feed, siteInput(f, stationId, point, spots), ctx.fetchedAt));
      const occupied = count(f.occupancy?.total);
      const reading = {
        stationId,
        at: instantIn(TIME_ZONE, f.MessageDate) ?? ctx.fetchedAt,
        point,
      };
      out.observations.push(
        ...occupancyDrafts(
          feed,
          reading,
          {
            ...(occupied === undefined ? {} : { occupied }),
            // A facility of 0 spots states no capacity to derive free spaces from.
            ...(spots === undefined || spots === 0 ? {} : { capacity: spots }),
          },
          ctx,
        ),
      );
    }
  }
  out.rejected = rejected;
  return out;
}
