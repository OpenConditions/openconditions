import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  type RecordSkipReason,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { Geometry } from "geojson";
import { accountSituations } from "../accounting.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { pointGeometry, polygonalGeometry } from "../geometry.js";
import { freshness, isRecord, provenance, situationId, utcInstant } from "../records.js";

const ACRE_HA = 0.40468564224;
const NM2_HA = 342.99;
const DAY_MS = 86_400_000;

/** EONET's categories as the hazard type they become. */
const TYPES: Readonly<Record<string, string>> = {
  volcanoes: "volcano",
  floods: "flood",
  seaLakeIce: "sea_ice",
  drought: "drought",
  landslides: "landslide",
  dustHaze: "dust_storm",
};

/** Categories another source reports first-hand: wildfires, earthquakes and cyclones. */
const FIRST_HAND = new Set(["wildfires", "earthquakes", "severeStorms"]);

/** Categories with no place in the model: man-made events, snow, temperature extremes and water colour. */
const UNMODELLED = new Set(["manmade", "snow", "tempExtremes", "waterColor"]);

/**
 * How long after its last dated position an event still counts as going on.
 * EONET leaves events open for years; a volcano's position is the start of
 * its eruption, a sea-ice track is updated monthly.
 */
const ACTIVE_DAYS: Readonly<Record<string, number>> = { volcano: 90, sea_ice: 30 };
const DEFAULT_ACTIVE_DAYS = 14;

/** The hectares in one unit of an area magnitude. */
const AREA_HA: Readonly<Record<string, number>> = {
  acres: ACRE_HA,
  hectare: 1,
  "NM^2": NM2_HA,
};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** An instant EONET wrote in UTC, as milliseconds; undefined when it is not one. */
function instantMs(value: unknown): number | undefined {
  const s = text(value);
  if (s === undefined || !INSTANT.test(s)) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

interface Dated {
  at: number;
  geometry: unknown;
  magnitude?: { value: number; unit: string };
}

function datedGeometries(event: Record<string, unknown>): Dated[] {
  const list = Array.isArray(event["geometry"]) ? event["geometry"] : [];
  return list.flatMap((g): Dated[] => {
    if (!isRecord(g)) return [];
    const at = instantMs(g["date"]);
    if (at === undefined) return [];
    const value = finite(g["magnitudeValue"]);
    const unit = text(g["magnitudeUnit"]);
    return [
      {
        at,
        geometry: { type: g["type"], coordinates: g["coordinates"] },
        ...(value === undefined || unit === undefined ? {} : { magnitude: { value, unit } }),
      },
    ];
  });
}

/** The events of a `/events` answer; anything without an event list fails the parse. */
function eventsOf(body: Buffer): unknown[] {
  const root: unknown = JSON.parse(body.toString("utf8"));
  const events = isRecord(root) ? root["events"] : undefined;
  if (!Array.isArray(events)) throw new Error("EONET answered no event list");
  return events;
}

const sourcesOf = (event: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(event["sources"]) ? event["sources"].filter(isRecord) : [];

const categoriesOf = (event: Record<string, unknown>): string[] =>
  (Array.isArray(event["categories"]) ? event["categories"] : []).flatMap((c) =>
    isRecord(c) && text(c["id"]) !== undefined ? [String(c["id"])] : [],
  );

/** A Global Volcanism Program volcano number: six digits (`357070`). */
const GVP_NUMBER = /^\d{6}$/;

/**
 * The volcano numbers of the Smithsonian Global Volcanism Program pages an
 * event cites as its `SIVolcano` sources (`volcano.cfm?vn=357070`), and how
 * many such sources name no number.
 */
function volcanoNumbersOf(event: Record<string, unknown>): { ids: string[]; unread: number } {
  const ids = new Set<string>();
  let unread = 0;
  for (const source of sourcesOf(event)) {
    if (text(source["id"]) !== "SIVolcano") continue;
    const url = text(source["url"]);
    let vn: string | null = null;
    try {
      vn = url === undefined ? null : new URL(url).searchParams.get("vn");
    } catch {
      vn = null;
    }
    if (vn !== null && GVP_NUMBER.test(vn)) ids.add(vn);
    else unread++;
  }
  return { ids: [...ids], unread };
}

/**
 * The hazard type an event is; `terminal` when another source reports it
 * first-hand or its categories have no place in the model; or why it is
 * skipped: `malformed` with no category, `unknown_type` with only
 * categories this format does not know.
 */
function typeOf(event: Record<string, unknown>): { type: string } | "terminal" | RecordSkipReason {
  const categories = categoriesOf(event);
  if (categories.some((c) => FIRST_HAND.has(c))) return "terminal";
  // GDACS events are taken from GDACS itself, which keeps them current.
  if (sourcesOf(event).some((s) => text(s["id"])?.toUpperCase() === "GDACS")) return "terminal";
  const category = categories.find((c) => Object.hasOwn(TYPES, c));
  if (category !== undefined) return { type: TYPES[category]! };
  if (categories.some((c) => UNMODELLED.has(c))) return "terminal";
  return categories.length === 0 ? "malformed" : "unknown_type";
}

function toDraft(
  event: Record<string, unknown>,
  id: string,
  type: string,
  dated: Dated[],
  geometry: Geometry,
  feed: HazardsCatalogFeed,
  fetchedAt: string,
): RecordDraft {
  const first = dated.reduce((a, b) => (b.at < a.at ? b : a));
  const last = dated.reduce((a, b) => (b.at > a.at ? b : a));
  const title = text(event["title"]);
  const description = text(event["description"]);
  const link = sourcesOf(event)
    .map((s) => text(s["url"]))
    .find((url) => url !== undefined && /^https?:\/\//.test(url));
  const closed = instantMs(event["closed"]);
  const activeUntil = last.at + (ACTIVE_DAYS[type] ?? DEFAULT_ACTIVE_DAYS) * DAY_MS;
  const end = closed ?? (activeUntil <= Date.parse(fetchedAt) ? activeUntil : undefined);
  const unit = last.magnitude?.unit;
  const area = unit !== undefined && Object.hasOwn(AREA_HA, unit) ? AREA_HA[unit] : undefined;
  // A kept event's magnitude in a unit that is no area (a wind speed, a seismic scale) is not read.
  if (unit !== undefined && area === undefined) recordSkipped(feed.id, "unknown_value");
  const product =
    last.magnitude === undefined || area === undefined
      ? undefined
      : round2(last.magnitude.value * area);
  // An area too large for a number (a magnitude near the largest double) is not read.
  const hectares = product !== undefined && Number.isFinite(product) ? product : undefined;
  if (product !== undefined && hectares === undefined) recordSkipped(feed.id, "unknown_value");
  const volcanoes = volcanoNumbersOf(event);
  recordSkipped(feed.id, "unknown_value", volcanoes.unread);
  return {
    id: situationId(feed, id),
    class: "situation",
    kind: "natural_hazard",
    type,
    ...(type === "sea_ice" && /^iceberg\b/i.test(title ?? "") ? { subtype: "iceberg" } : {}),
    temporality: "live",
    ...(volcanoes.ids.length === 0
      ? {}
      : { externalIds: volcanoes.ids.map((id) => ({ scheme: "gvp:volcano", id })) }),
    location: {
      geometry,
      extent: geometry.type === "Point" ? "point" : "area",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
    provenance: provenance(feed, id, utcInstant(new Date(last.at))),
    freshness: freshness(fetchedAt),
    planned: false,
    certainty: "observed",
    severity: { label: "unknown" },
    ...(title === undefined ? {} : { headline: [{ lang: "en", text: title }] }),
    ...(description === undefined ? {} : { description: [{ lang: "en", text: description }] }),
    validity: {
      status: end === undefined ? "active" : "ended",
      start: utcInstant(new Date(first.at)),
      ...(end === undefined ? {} : { end: utcInstant(new Date(Math.max(end, first.at))) }),
    },
    effects: [],
    details: {
      kind: "natural_hazard",
      v: 1,
      ...(title === undefined ? {} : { name: [{ lang: "en", text: title }] }),
      ...(link === undefined ? {} : { detailUrl: link }),
      ...(hectares === undefined || hectares < 0 ? {} : { areaHa: hectares }),
    },
  };
}

/**
 * The `eonet` format: NASA's Earth Observatory Natural Event Tracker as
 * `natural_hazard` situations, read from the `/events` JSON, one record per
 * event. The `open` role lists events still open; the `closed` role the
 * ones closed in the last days, which carry the `closed` date an event that
 * left `open` needs.
 *
 * Wildfires, earthquakes and cyclones, and every event with a GDACS source,
 * are terminal: their publishers are read first-hand; so are man-made
 * events, snow, temperature extremes and water colour, which the model has
 * no type for. An event of only categories this format does not know is
 * skipped as `unknown_type`. The record is placed at the event's latest
 * dated geometry, a point or a polygon. A volcano's Smithsonian Global
 * Volcanism Program page among its sources (`SIVolcano`) gives its
 * `gvp:volcano` number; such a source without one is `unknown_value`. An
 * event with no geometry is skipped
 * as `no_geometry`, and one with no id or category, no dated geometry, or
 * whose latest geometry is unreadable or out of range as `malformed`, never
 * the payload. EONET leaves events open for
 * years, so an open event whose last geometry is older than its type's
 * window ends there (a volcano after 90 days, sea ice after 30, the rest
 * after 14). A body without an event list fails the parse.
 */
export function parseEonet(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const byId = new Map<string, Record<string, unknown>>();
  let inputCount = 0;
  let duplicates = 0;
  for (const role of ["open", "closed"]) {
    for (const body of payloads[role] ?? []) {
      for (const event of eventsOf(body)) {
        inputCount++;
        const id = isRecord(event) ? text(event["id"]) : undefined;
        if (!isRecord(event) || id === undefined) {
          recordSkipped(feed.id, "malformed");
          continue;
        }
        const held = byId.get(id);
        if (held === undefined) {
          byId.set(id, event);
          continue;
        }
        duplicates++;
        // An event in both lists has just closed: the closed copy is the later state.
        if (instantMs(held["closed"]) === undefined && instantMs(event["closed"]) !== undefined) {
          byId.set(id, event);
        }
      }
    }
  }

  let terminal = 0;
  for (const [id, event] of byId) {
    const kind = typeOf(event);
    if (kind === "terminal") {
      terminal++;
      continue;
    }
    if (typeof kind === "string") {
      recordSkipped(feed.id, kind);
      continue;
    }
    const listed = Array.isArray(event["geometry"]) ? event["geometry"] : [];
    if (!listed.some(isRecord)) {
      recordSkipped(feed.id, "no_geometry");
      continue;
    }
    const dated = datedGeometries(event);
    const last = dated.length === 0 ? undefined : dated.reduce((a, b) => (b.at > a.at ? b : a));
    const geometry =
      last === undefined
        ? null
        : (pointGeometry(last.geometry) ?? polygonalGeometry(last.geometry));
    if (last === undefined || geometry === null) {
      recordSkipped(feed.id, "malformed");
      continue;
    }
    out.situations.push(toDraft(event, id, kind.type, dated, geometry, feed, ctx.fetchedAt));
  }

  accountSituations(out, { inputCount, duplicates, rejected: 0, terminal });
  return out;
}
