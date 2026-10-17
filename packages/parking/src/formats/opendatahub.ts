import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { ParkingLayout, ParkingUserGroup } from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { type AreaInput, instantIn, occupancyDrafts, type SiteInput, siteDraft } from "../site.js";

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
    mainaddress?: unknown;
    netex_parking?: {
      layout?: unknown;
      charging?: unknown;
      type?: unknown;
      vehicletypes?: unknown;
      reservation?: unknown;
      surveillance?: unknown;
    } | null;
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

/** NeTEx `ParkingLayoutEnum` values the stations write, lower-cased. */
const LAYOUTS: Readonly<Record<string, ParkingLayout>> = {
  underground: "underground",
  openspace: "surface",
  multistorey: "multi_storey",
  covered: "covered",
};

/** Name fields in each language the hub writes; the first of a language wins. */
const NAMES: readonly [string, string][] = [
  ["name_en", "en"],
  ["name_EN", "en"],
  ["name_de", "de"],
  ["name_DE", "de"],
  ["name_it", "it"],
  ["name_IT", "it"],
];

/** Every NeTEx `ParkingLayoutEnum` value, lower-cased; those without a layout are read as none. */
const NETEX_LAYOUTS: ReadonlySet<string> = new Set([
  ...Object.keys(LAYOUTS),
  "roadside",
  "cyclehire",
  "undefined",
  "other",
]);

/**
 * The spaces a station counts apart, by the suffix of their capacity and
 * measurements: short stays (`_short_stay`, Swarco's `_short_term`) and
 * subscribers, who rent a space for a long term.
 */
const GROUPS: Readonly<Record<string, ParkingUserGroup>> = {
  _short_stay: "short_term",
  _short_term: "short_term",
  _subscribers: "long_term",
};

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

/**
 * A station's name in each language it is given in; else its standard name
 * or its own name, in a language the hub does not say.
 */
function namesOf(station: OdhStation): { lang: string; text: string }[] {
  const out: { lang: string; text: string }[] = [];
  for (const [field, lang] of NAMES) {
    const name = text(station.smetadata?.[field]);
    if (name !== undefined && !out.some((n) => n.lang === lang)) out.push({ lang, text: name });
  }
  if (out.length > 0) return out;
  const name = text(station.smetadata?.standard_name) ?? text(station.sname);
  return name === undefined ? [] : [{ lang: "und", text: name }];
}

/** A whole count above zero. */
const count = (v: unknown): number | undefined =>
  finite(v) && Number.isInteger(v) && v > 0 ? v : undefined;

function siteInput(
  feed: ParkingCatalogFeed,
  station: OdhStation,
  stationId: string,
  point: [number, number],
): SiteInput {
  const meta = station.smetadata ?? {};
  const netex = meta.netex_parking ?? undefined;
  const layoutKey = text(netex?.layout)?.toLowerCase() ?? "";
  const layout = Object.hasOwn(LAYOUTS, layoutKey) ? LAYOUTS[layoutKey] : undefined;
  // A22's motorway stations write their capacity in Italian.
  const capacity = count(meta.capacity) ?? count(meta["capacità"]);
  const names = namesOf(station);
  const city = text(meta.municipality);
  const street = text(meta.mainaddress);
  const origin = text(station.sorigin);
  const type = text(netex?.type);
  const lorries = text(netex?.vehicletypes) === "heavyGoodsVehicle";
  const surveillance = netex?.surveillance;
  const reservation = text(netex?.reservation);
  const groups: AreaInput[] = Object.entries(GROUPS).flatMap(([suffix, userGroup]) => {
    const spaces = count(meta[`capacity${suffix}`]);
    return spaces === undefined ? [] : [{ vehicleType: "car", userGroup, capacity: spaces }];
  });
  return {
    stationId,
    point,
    // Stations of one origin system may share a place with another's.
    ...(origin === undefined ? {} : { providerAuthority: `${feed.id}/${origin}` }),
    ...(names.length === 0 ? {} : { name: names }),
    ...(layout === undefined ? {} : { layout }),
    ...(city === undefined && street === undefined
      ? {}
      : {
          address: {
            ...(city === undefined ? {} : { city }),
            ...(street === undefined ? {} : { text: street }),
          },
        }),
    ...(capacity === undefined ? {} : { capacityTotal: capacity }),
    // A22's motorway stations are lorry parks.
    ...(lorries
      ? { type: "truck_parking", usage: ["truck"] }
      : type === "parkAndRide"
        ? { type: "park_and_ride", usage: ["park_and_ride"] }
        : {}),
    ...(surveillance === true ? { supervision: "supervised" } : {}),
    ...(surveillance === false ? { supervision: "none" } : {}),
    ...(reservation === "noReservations" ? { reservation: false } : {}),
    ...(reservation === "reservationRequired" || reservation === "reservationsPossible"
      ? { reservation: true }
      : {}),
    areas: [
      ...(lorries
        ? [
            {
              vehicleType: "truck" as const,
              userGroup: "any" as const,
              ...(capacity === undefined ? {} : { capacity }),
            },
          ]
        : []),
      ...groups,
      // The hub says only that the station has charging, not how many spaces.
      ...(netex?.charging === true
        ? [{ vehicleType: "car" as const, userGroup: "ev_charging" as const }]
        : []),
    ],
  };
}

interface Count {
  value: number;
  at: string;
}

/** A station's or one of its groups' newest free and occupied counts. */
interface GroupCounts {
  free?: Count;
  occupied?: Count;
}

interface Counts {
  /** By group suffix: `""` for the station's own, else a `GROUPS` key. */
  groups: Map<string, GroupCounts>;
  /** The current measurements read, for counting those of a station with no site. */
  measured: number;
}

const MEASUREMENT = /^(free|occupied)(_short_stay|_short_term|_subscribers)?$/;

/**
 * Per station, the newest current `free` and `occupied` measurement, of the
 * station and of each of its groups. Other measurement types (forecasts,
 * entries and exits) are not read; a measurement without a station, a time
 * or a number is counted as skipped.
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
      const [, kind, group = ""] = (m.tname ?? "").match(MEASUREMENT) ?? [];
      if (kind !== "free" && kind !== "occupied") continue;
      const scode = text(m.scode);
      const at = instantIn(TIME_ZONE, m.mvalidtime);
      if (scode === undefined || at === undefined || !finite(m.mvalue)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (Date.parse(at) < oldest) continue;
      const counts = out.get(scode) ?? { groups: new Map(), measured: 0 };
      counts.measured++;
      const own = counts.groups.get(group) ?? {};
      const held = own[kind];
      if (held === undefined || Date.parse(at) > Date.parse(held.at)) {
        own[kind] = { value: m.mvalue, at };
      }
      counts.groups.set(group, own);
      out.set(scode, counts);
    }
  }
  return out;
}

/**
 * The readings of a station and its groups, each count at its own time. A
 * free count is taken as published; only without one are free spaces
 * derived from the occupied count. A group's counts are its area's, bounded
 * by the group's own capacity; a group without an area has none.
 */
function readingsOf(
  feed: ParkingCatalogFeed,
  stationId: string,
  point: [number, number],
  input: SiteInput,
  counts: Counts,
  ctx: ParseContext,
): RecordDraft[] {
  const out: RecordDraft[] = [];
  for (const [group, own] of counts.groups) {
    const userGroup = group === "" ? undefined : GROUPS[group];
    const area =
      userGroup === undefined
        ? undefined
        : input.areas?.find((a) => a.vehicleType === "car" && a.userGroup === userGroup);
    if (group !== "" && area === undefined) continue;
    const capacity = area === undefined ? input.capacityTotal : area.capacity;
    const bound = capacity === undefined ? {} : { capacity };
    const of =
      area === undefined
        ? {}
        : { area: { vehicleType: area.vehicleType, userGroup: area.userGroup } };
    if (own.free !== undefined) {
      const reading = { stationId, at: own.free.at, point, ...of };
      out.push(...occupancyDrafts(feed, reading, { available: own.free.value, ...bound }, ctx));
    }
    if (own.occupied !== undefined) {
      const reading = { stationId, at: own.occupied.at, point, ...of };
      const derive = own.free === undefined ? bound : {};
      out.push(...occupancyDrafts(feed, reading, { occupied: own.occupied.value, ...derive }, ctx));
    }
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
 * their `mvalidtime`, those of a short-stay or subscribers' group its area's.
 * A station's names in every language, its NeTEx type, vehicles, layout,
 * surveillance and reservation are read. A station's origin system
 * qualifies its provider id; a layout NeTEx does not define is counted.
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
      const layout = text(station.smetadata?.netex_parking?.layout)?.toLowerCase();
      if (layout !== undefined && !NETEX_LAYOUTS.has(layout)) {
        recordSkipped(feed.id, "unknown_value");
      }
      const input = siteInput(feed, station, stationId, point);
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));
      const live = counts.get(stationId);
      if (live !== undefined) {
        out.observations.push(...readingsOf(feed, stationId, point, input, live, ctx));
      }
    }
  }
  for (const [scode, c] of counts) {
    if (!named.has(scode)) recordSkipped(feed.id, "no_geometry", c.measured);
  }
  return out;
}
