import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
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

/**
 * The site of a static record, or why it gives none: `malformed` without
 * an id or with a coordinate that is no number, `no_geometry` without a
 * definition or a point.
 */
function staticSite(record: UtmcStatic): StaticSite | "malformed" | "no_geometry" {
  const stationId =
    typeof record === "object" && record !== null ? text(record.systemCodeNumber) : undefined;
  if (stationId === undefined) return "malformed";
  const definition = record.definitions?.[0];
  const lat = definition?.point?.latitude;
  const lon = definition?.point?.longitude;
  if (lat === undefined || lat === null || lon === undefined || lon === null) return "no_geometry";
  if (!finite(lat) || !finite(lon)) return "malformed";
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
  // The feed writes its offset without a colon (`+0000`).
  const at = instantIn(TIME_ZONE, dynamic.lastUpdated);
  if (at === undefined && text(dynamic.lastUpdated) !== undefined) {
    recordSkipped(feed.id, "unknown_value");
  }
  const reading = {
    stationId: site.input.stationId,
    at: at ?? ctx.fetchedAt,
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
  const state = text(dynamic.stateDescription)?.toUpperCase();
  const status = STATES[state ?? ""];
  if (status !== undefined) out.push(statusDraft(feed, { ...reading, status }, ctx));
  else if (state !== undefined) recordSkipped(feed.id, "unknown_value");
  return out.filter((d): d is RecordDraft => d !== undefined);
}

/**
 * UTMC car parks (NE Travel Data, Tyne and Wear): the `sites` feed gives
 * each car park, its WGS84 point and its capacity; the `status` feed its
 * occupancy and state. Free spaces are the capacity less the occupancy, at
 * least 0. A static record without an id, a definition or a point is
 * counted as skipped, and so is a dynamic record of a car park the `sites`
 * feed lacks: it has no site to place it. A state or time it cannot read is
 * an unknown value, the readings published without it.
 */
export function parseUtmc(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const sites = new Map<string, StaticSite>();
  // Every car park the static feed names, placed or not: a skipped car
  // park's dynamic record is not counted a second time.
  const named = new Set<string>();
  for (const body of payloads["sites"] ?? []) {
    for (const record of records<UtmcStatic>(body, "sites")) {
      const site = staticSite(record);
      if (typeof site === "string") {
        const id =
          typeof record === "object" && record !== null ? text(record.systemCodeNumber) : undefined;
        if (id !== undefined) named.add(id);
        recordSkipped(feed.id, site);
        continue;
      }
      named.add(site.input.stationId);
      if (sites.has(site.input.stationId)) continue;
      sites.set(site.input.stationId, site);
      out.features.push(siteDraft(feed, site.input, ctx.fetchedAt));
    }
  }
  for (const body of payloads["status"] ?? []) {
    for (const record of records<UtmcDynamic>(body, "status")) {
      if (typeof record !== "object" || record === null) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      // A record without dynamics holds nothing to lose.
      if ((record.dynamics?.length ?? 0) === 0) continue;
      const id = text(record.systemCodeNumber);
      if (id === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const site = sites.get(id);
      if (site !== undefined) out.observations.push(...readingsOf(feed, site, record, ctx));
      else if (!named.has(id)) recordSkipped(feed.id, "no_geometry");
    }
  }
  return out;
}
