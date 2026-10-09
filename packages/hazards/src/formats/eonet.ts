import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { Geometry } from "geojson";
import { accountSituations } from "../accounting.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { pointGeometry, polygonalGeometry } from "../geometry.js";
import { freshness, isRecord, provenance, situationId, utcInstant } from "../records.js";

const ACRE_HA = 0.40468564224;
const NM2_HA = 342.99;
const DAY_MS = 86_400_000;

/** EONET's categories as the hazard type they become; the rest have no place in the model. */
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

/** The hazard type an event is, or null when another source reports it first-hand or the model has none. */
function typeOf(event: Record<string, unknown>): string | null {
  const categories = categoriesOf(event);
  if (categories.some((c) => FIRST_HAND.has(c))) return null;
  // GDACS events are taken from GDACS itself, which keeps them current.
  if (sourcesOf(event).some((s) => text(s["id"])?.toUpperCase() === "GDACS")) return null;
  const category = categories.find((c) => TYPES[c] !== undefined);
  return category === undefined ? null : TYPES[category]!;
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
  const hectares =
    last.magnitude === undefined || AREA_HA[last.magnitude.unit] === undefined
      ? undefined
      : last.magnitude.value * AREA_HA[last.magnitude.unit]!;
  return {
    id: situationId(feed, id),
    class: "situation",
    kind: "natural_hazard",
    type,
    ...(type === "sea_ice" && /^iceberg\b/i.test(title ?? "") ? { subtype: "iceberg" } : {}),
    temporality: "live",
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
      ...(hectares === undefined || hectares < 0 ? {} : { areaHa: round2(hectares) }),
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
 * are terminal: their publishers are read first-hand. The record is placed
 * at the event's latest dated geometry, a point or a polygon; an event
 * whose latest geometry is unreadable or has a position out of range is
 * rejected and counted, never the payload. EONET leaves events open for
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
  let rejected = 0;
  for (const role of ["open", "closed"]) {
    for (const body of payloads[role] ?? []) {
      for (const event of eventsOf(body)) {
        inputCount++;
        const id = isRecord(event) ? text(event["id"]) : undefined;
        if (!isRecord(event) || id === undefined) {
          rejected++;
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
    const type = typeOf(event);
    if (type === null) {
      terminal++;
      continue;
    }
    const dated = datedGeometries(event);
    const last = dated.length === 0 ? undefined : dated.reduce((a, b) => (b.at > a.at ? b : a));
    const geometry =
      last === undefined
        ? null
        : (pointGeometry(last.geometry) ?? polygonalGeometry(last.geometry));
    if (last === undefined || geometry === null) {
      rejected++;
      continue;
    }
    out.situations.push(toDraft(event, id, type, dated, geometry, feed, ctx.fetchedAt));
  }

  accountSituations(out, { inputCount, duplicates, rejected, terminal });
  return out;
}
