import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { ParkingStatus } from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { instantIn, occupancyDrafts, type SiteInput, siteDraft, statusDraft } from "../site.js";

/** One car park of the UTMC static feed (Tyne and Wear Open Data Services §5.4). */
interface UtmcStatic {
  systemCodeNumber?: string;
  definitions?: {
    shortDescription?: string | null;
    longDescription?: string | null;
    point?: { latitude?: number | null; longitude?: number | null } | null;
  }[];
  configurations?: { capacity?: number | null }[];
}

/** One car park of the UTMC dynamic feed (§6.4). */
interface UtmcDynamic {
  systemCodeNumber?: string;
  dynamics?: {
    occupancy?: number | null;
    stateDescription?: string | null;
    lastUpdated?: string | null;
  }[];
}

const STATES: Readonly<Record<string, ParkingStatus>> = {
  CLOSED: "closed",
  FAULTY: "closed",
  SPACES: "spaces_available",
  "ALMOST FULL": "almost_full",
  FULL: "full",
  OPEN: "open",
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A bare JSON array of records. */
function records<T>(body: Buffer, role: string): T[] {
  const doc = JSON.parse(body.toString("utf8")) as unknown;
  if (!Array.isArray(doc)) throw new Error(`utmc: ${role} body is not an array`);
  return doc as T[];
}

/** Tyne and Wear's time, for a timestamp written without an offset. */
const TIME_ZONE = "Europe/London";

interface StaticSite {
  input: SiteInput;
  capacity?: number;
}

function staticSite(record: UtmcStatic): StaticSite | undefined {
  const stationId = text(record.systemCodeNumber);
  const definition = record.definitions?.[0];
  const lat = definition?.point?.latitude;
  const lon = definition?.point?.longitude;
  if (stationId === undefined || !finite(lat) || !finite(lon)) return undefined;
  const capacity = record.configurations?.[0]?.capacity;
  const counted = finite(capacity) && capacity > 0 ? capacity : undefined;
  const address = text(definition?.longDescription);
  return {
    input: {
      stationId,
      point: [lon, lat],
      lang: "en",
      name: text(definition?.shortDescription) ?? `Car Park ${stationId}`,
      ...(address === undefined ? {} : { address: { text: address } }),
      ...(counted === undefined ? {} : { capacityTotal: counted }),
    },
    ...(counted === undefined ? {} : { capacity: counted }),
  };
}

function readingsOf(
  feed: ParkingCatalogFeed,
  site: StaticSite,
  record: UtmcDynamic,
  ctx: ParseContext,
): RecordDraft[] {
  const dynamic = record.dynamics?.[0];
  if (dynamic === undefined) return [];
  const reading = {
    stationId: site.input.stationId,
    // The feed writes its offset without a colon (`+0000`).
    at: instantIn(TIME_ZONE, dynamic.lastUpdated) ?? ctx.fetchedAt,
    point: site.input.point,
  };
  const out: (RecordDraft | undefined)[] = occupancyDrafts(
    feed,
    reading,
    {
      ...(finite(dynamic.occupancy) ? { occupied: dynamic.occupancy } : {}),
      ...(site.capacity === undefined ? {} : { capacity: site.capacity }),
    },
    ctx,
  );
  const status = STATES[text(dynamic.stateDescription)?.toUpperCase() ?? ""];
  if (status !== undefined) out.push(statusDraft(feed, { ...reading, status }, ctx));
  return out.filter((d): d is RecordDraft => d !== undefined);
}

/**
 * UTMC car parks (NE Travel Data, Tyne and Wear): the `sites` feed gives
 * each car park, its WGS84 point and its capacity; the `status` feed its
 * occupancy and state. Free spaces are the capacity less the occupancy, at
 * least 0. A car park without a definition or a point is rejected; a
 * dynamic record of an unknown car park is dropped.
 */
export function parseUtmc(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const sites = new Map<string, StaticSite>();
  let rejected = 0;
  for (const body of payloads["sites"] ?? []) {
    for (const record of records<UtmcStatic>(body, "sites")) {
      const site = staticSite(record);
      if (site === undefined) {
        rejected++;
        continue;
      }
      if (sites.has(site.input.stationId)) continue;
      sites.set(site.input.stationId, site);
      out.features.push(siteDraft(feed, site.input, ctx.fetchedAt));
    }
  }
  for (const body of payloads["status"] ?? []) {
    for (const record of records<UtmcDynamic>(body, "status")) {
      const site = sites.get(text(record.systemCodeNumber) ?? "");
      if (site !== undefined) out.observations.push(...readingsOf(feed, site, record, ctx));
    }
  }
  out.rejected = rejected;
  return out;
}
