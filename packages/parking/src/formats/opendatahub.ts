import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
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
  /** The current measurements read, for counting those of a station with no site. */
  measured: number;
}

/**
 * Per station, the newest current `free` and `occupied` measurement. Other
 * measurement types are not read; a measurement without a station, a time or
 * a number is counted as skipped.
 */
function countsOf(
  feed: ParkingCatalogFeed,
  bodies: readonly Buffer[],
  fetchedAt: string,
): Map<string, Counts> {
  const oldest = Date.parse(fetchedAt) - MAX_AGE_MS;
  const out = new Map<string, Counts>();
  for (const body of bodies) {
    for (const m of dataOf<OdhMeasurement>(body, "status")) {
      if (typeof m !== "object" || m === null) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const kind = m.tname === "free" || m.tname === "occupied" ? m.tname : undefined;
      if (kind === undefined) continue;
      const scode = text(m.scode);
      const at = instantIn(TIME_ZONE, m.mvalidtime);
      if (scode === undefined || at === undefined || !finite(m.mvalue)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (Date.parse(at) < oldest) continue;
      const counts = out.get(scode) ?? { measured: 0 };
      counts.measured++;
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
 * A station's WGS84 point, or why it has none: `no_geometry` without a
 * coordinate or in another reference system, `malformed` with a coordinate
 * that is no number.
 */
function pointOf(station: OdhStation): [number, number] | "no_geometry" | "malformed" {
  const c = station.scoordinate;
  const absent = (v: unknown) => v === undefined || v === null;
  if (absent(c?.x) || absent(c?.y)) return "no_geometry";
  if (!finite(c?.x) || !finite(c?.y)) return "malformed";
  return c.srid === undefined || c.srid === 4326 ? [c.x, c.y] : "no_geometry";
}

/**
 * Open Data Hub parking stations (South Tyrol): the `sites` payload lists
 * the stations, the `status` payload their latest measurements. `free` and
 * `occupied` measurements of the last hour before the poll are readings at
 * their `mvalidtime`. A station's origin system qualifies its provider id.
 * A station without an id or a WGS84 point is counted as skipped, and so
 * are the current measurements of a station the `sites` payload lacks: they
 * have no site to place them.
 */
export function parseOpendatahub(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const counts = countsOf(feed, payloads["status"] ?? [], ctx.fetchedAt);
  const seen = new Set<string>();
  // Every station the table names, placed or not: a skipped station's
  // measurements are not counted a second time.
  const named = new Set<string>();
  for (const body of payloads["sites"] ?? []) {
    for (const station of dataOf<OdhStation>(body, "sites")) {
      const stationId =
        typeof station === "object" && station !== null ? text(station.scode) : undefined;
      if (stationId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      named.add(stationId);
      const point = pointOf(station);
      if (!Array.isArray(point)) {
        recordSkipped(feed.id, point);
        continue;
      }
      if (seen.has(stationId)) continue;
      seen.add(stationId);
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
  for (const [scode, c] of counts) {
    if (!named.has(scode)) recordSkipped(feed.id, "no_geometry", c.measured);
  }
  return out;
}
