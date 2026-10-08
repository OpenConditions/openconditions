import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import {
  digitrafficLocation,
  digitrafficStatuses,
  digitrafficTariffs,
  isRecord,
  OcpiDecodeError,
  type OcpiLocation,
} from "@openconditions/ocpi";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { type EvseState, mapOcpi, ocpiStatusReadings } from "./ocpi.js";

/** The features of a `locations/all` feature collection. */
function featuresOf(body: Buffer): unknown[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new OcpiDecodeError(`not JSON: ${(error as Error).message}`);
  }
  const features = isRecord(doc) ? doc["features"] : undefined;
  if (!Array.isArray(features)) throw new OcpiDecodeError("the payload carries no features list");
  return features;
}

/**
 * Fintraffic's AFIR charging network: OCPI locations as GeoJSON in `main`,
 * the EVSE statuses by eMI3 id in `status` (dated by the operator's own
 * time), and the tariff pages in `tariffs`; then the OCPI mapping.
 */
export function parseDigitraffic(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const main = payloads["main"] ?? [];
  if (main.length === 0) return emptyParseOutput();
  const locations: OcpiLocation[] = [];
  let rejected = 0;
  for (const feature of main.flatMap(featuresOf)) {
    try {
      locations.push(digitrafficLocation(feature));
    } catch (error) {
      if (!(error instanceof OcpiDecodeError)) throw error;
      rejected++;
    }
  }
  const statuses = statusesOf(payloads["status"] ?? []);
  const tariffs = (payloads["tariffs"] ?? []).flatMap(digitrafficTariffs);
  return mapOcpi(feed, { locations, rejected, statuses, tariffs }, ctx);
}

/** The EVSE statuses by eMI3 id. */
function statusesOf(bodies: readonly Buffer[]): Map<string, EvseState> {
  const statuses = new Map<string, EvseState>();
  for (const body of bodies) {
    for (const { evseId, status, at } of digitrafficStatuses(body)) {
      statuses.set(evseId, at === undefined ? { status } : { status, at });
    }
  }
  return statuses;
}

/** The status-only reading of Fintraffic's `status` role. */
export function parseDigitrafficStatus(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  return ocpiStatusReadings(feed, statusesOf(payloads["status"] ?? []), index, ctx);
}
