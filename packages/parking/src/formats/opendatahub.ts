import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { ParkingLayout } from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { instantIn, occupancyDrafts, type SiteInput, siteDraft } from "../site.js";

/** One `ParkingStation` of the Open Data Hub mobility API's flat view. */
interface OdhStation {
  scode?: string;
  sname?: string;
  sorigin?: string;
  scoordinate?: { x?: number | null; y?: number | null; srid?: number } | null;
  smetadata?: Record<string, unknown> & {
    capacity?: unknown;
    municipality?: unknown;
    standard_name?: unknown;
    netex_parking?: { layout?: unknown; charging?: unknown } | null;
  };
}

/** One latest measurement of a station. */
interface OdhMeasurement {
  scode?: string;
  tname?: string;
  mvalue?: number | null;
  mvalidtime?: string;
}

/** Measurements older than this, at the poll, are not current. */
const MAX_AGE_MS = 60 * 60 * 1000;

const LAYOUTS: Readonly<Record<string, ParkingLayout>> = {
  underground: "underground",
  openspace: "surface",
  multistorey: "multi_storey",
};

/** Name fields in order of preference, with the language each is in. */
const NAMES: readonly [string, string][] = [
  ["name_en", "en"],
  ["name_EN", "en"],
  ["name_de", "de"],
  ["name_DE", "de"],
  ["name_it", "it"],
  ["name_IT", "it"],
  ["standard_name", "it"],
];

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The `data` array of a flat-view body. */
function dataOf<T>(body: Buffer, role: string): T[] {
  const data = (JSON.parse(body.toString("utf8")) as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error(`opendatahub: ${role} body has no data array`);
  return data as T[];
}

/**
 * South Tyrol's time, for a timestamp written without an offset; the API
 * writes `2026-05-23 11:40:00.000+0000`, which carries one.
 */
const TIME_ZONE = "Europe/Rome";

function nameOf(station: OdhStation): { name: string; lang: string } | undefined {
  for (const [field, lang] of NAMES) {
    const name = text(station.smetadata?.[field]);
    if (name !== undefined) return { name, lang };
  }
  const name = text(station.sname);
  return name === undefined ? undefined : { name, lang: "und" };
}

function siteInput(
  feed: ParkingCatalogFeed,
  station: OdhStation,
  stationId: string,
  point: [number, number],
): SiteInput {
  const meta = station.smetadata ?? {};
  const netex = meta.netex_parking ?? undefined;
  const layout = LAYOUTS[text(netex?.layout)?.toLowerCase() ?? ""];
  const capacity =
    finite(meta.capacity) && Number.isInteger(meta.capacity) && meta.capacity > 0
      ? meta.capacity
      : undefined;
  const named = nameOf(station);
  const city = text(meta.municipality);
  const origin = text(station.sorigin);
  return {
    stationId,
    point,
    // Stations of one origin system may share a place with another's.
    ...(origin === undefined ? {} : { providerAuthority: `${feed.id}/${origin}` }),
    ...(named === undefined ? {} : { name: named.name, lang: named.lang }),
    ...(layout === undefined ? {} : { layout }),
    ...(city === undefined ? {} : { address: { city } }),
    ...(capacity === undefined ? {} : { capacityTotal: capacity }),
    // The hub says only that the station has charging, not how many spaces.
    areas: netex?.charging === true ? [{ vehicleType: "car", userGroup: "ev_charging" }] : [],
  };
}

interface Count {
  value: number;
  at: string;
}

interface Counts {
  free?: Count;
  occupied?: Count;
}

/** Per station, the newest current `free` and `occupied` measurement. */
function countsOf(bodies: readonly Buffer[], fetchedAt: string): Map<string, Counts> {
  const oldest = Date.parse(fetchedAt) - MAX_AGE_MS;
  const out = new Map<string, Counts>();
  for (const body of bodies) {
    for (const m of dataOf<OdhMeasurement>(body, "status")) {
      const scode = text(m.scode);
      const kind = m.tname === "free" || m.tname === "occupied" ? m.tname : undefined;
      const at = instantIn(TIME_ZONE, m.mvalidtime);
      if (scode === undefined || kind === undefined || at === undefined || !finite(m.mvalue)) {
        continue;
      }
      if (Date.parse(at) < oldest) continue;
      const counts = out.get(scode) ?? {};
      const held = counts[kind];
      if (held === undefined || Date.parse(at) > Date.parse(held.at)) {
        counts[kind] = { value: m.mvalue, at };
      }
      out.set(scode, counts);
    }
  }
  return out;
}

/**
 * The readings of a station, each count at its own time. A free count is
 * taken as published; only without one are free spaces derived from the
 * occupied count.
 */
function readingsOf(
  feed: ParkingCatalogFeed,
  stationId: string,
  point: [number, number],
  capacity: number | undefined,
  counts: Counts,
  ctx: ParseContext,
): RecordDraft[] {
  const bound = capacity === undefined ? {} : { capacity };
  const out: RecordDraft[] = [];
  if (counts.free !== undefined) {
    const reading = { stationId, at: counts.free.at, point };
    out.push(...occupancyDrafts(feed, reading, { available: counts.free.value, ...bound }, ctx));
  }
  if (counts.occupied !== undefined) {
    const reading = { stationId, at: counts.occupied.at, point };
    const derive = counts.free === undefined ? bound : {};
    out.push(
      ...occupancyDrafts(feed, reading, { occupied: counts.occupied.value, ...derive }, ctx),
    );
  }
  return out;
}

/**
 * Open Data Hub parking stations (South Tyrol): the `sites` payload lists
 * the stations, the `status` payload their latest measurements. `free` and
 * `occupied` measurements of the last hour before the poll are readings at
 * their `mvalidtime`. A station's origin system qualifies its provider id.
 * A station without a WGS84 point is rejected.
 */
export function parseOpendatahub(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const counts = countsOf(payloads["status"] ?? [], ctx.fetchedAt);
  const seen = new Set<string>();
  let rejected = 0;
  for (const body of payloads["sites"] ?? []) {
    for (const station of dataOf<OdhStation>(body, "sites")) {
      const stationId = text(station.scode);
      const c = station.scoordinate;
      const wgs84 = c?.srid === undefined || c.srid === 4326;
      if (stationId === undefined || !finite(c?.x) || !finite(c?.y) || !wgs84) {
        rejected++;
        continue;
      }
      if (seen.has(stationId)) continue;
      seen.add(stationId);
      const point: [number, number] = [c.x, c.y];
      const input = siteInput(feed, station, stationId, point);
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));
      const live = counts.get(stationId);
      if (live !== undefined) {
        out.observations.push(
          ...readingsOf(feed, stationId, point, input.capacityTotal, live, ctx),
        );
      }
    }
  }
  out.rejected = rejected;
  return out;
}
