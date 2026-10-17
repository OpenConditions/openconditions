import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { Geometry } from "geojson";
import { accountSituations } from "../accounting.js";
import { arcgisFeatures } from "../arcgis.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { pointGeometry, polygonalGeometry } from "../geometry.js";
import { freshness, isRecord, provenance, situationId, utcInstant } from "../records.js";

const ACRE_HA = 0.40468564224;
const IRWIN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const CAUSES: Readonly<Record<string, string>> = {
  Natural: "natural",
  Human: "human",
  Undetermined: "undetermined",
};

/**
 * The incident team's general fire behaviour, as the register writes it. The
 * values are those the layer carries; one it does not is counted rather
 * than guessed at.
 */
const BEHAVIOURS: Readonly<Record<string, string>> = {
  Minimal: "minimal",
  Moderate: "moderate",
  Active: "active",
};

type Properties = Record<string, unknown>;

/** The fields one incident carries, read from a perimeter's `attr_` copy or the incident layer's own. */
const attr = (p: Properties | undefined, name: string): unknown =>
  p === undefined ? undefined : (p[`attr_${name}`] ?? p[name] ?? undefined);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** ArcGIS writes a date as milliseconds since the epoch. */
function instant(value: unknown): string | undefined {
  const ms = finite(value);
  if (ms === undefined) return undefined;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? undefined : utcInstant(at);
}

/** The IRWIN id as the registers write it elsewhere: upper-case, without braces. */
function irwinOf(value: unknown): string | undefined {
  const id = text(value)
    ?.replace(/^\{|\}$/g, "")
    .toUpperCase();
  return id !== undefined && IRWIN.test(id) ? id : undefined;
}

interface Feature {
  properties: Properties;
  geometry: unknown;
}

/** The features of a layer's answer that carry properties, and how many do not. */
function featuresOf(body: Buffer): { features: Feature[]; unreadable: number } {
  const list = arcgisFeatures(body, "WFIGS");
  const features: Feature[] = [];
  let unreadable = 0;
  for (const f of list) {
    const properties = isRecord(f) ? f["properties"] : undefined;
    if (isRecord(f) && isRecord(properties)) features.push({ properties, geometry: f["geometry"] });
    else unreadable++;
  }
  return { features, unreadable };
}

interface Incident {
  irwin: string;
  perimeter?: Properties;
  /** The perimeter's shape, when it reads. */
  shape?: Geometry;
  incident?: Properties;
  point?: Geometry;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The category an incident belongs to: the incident layer's, else the perimeter's own. */
function categoryOf(entry: Incident): string | undefined {
  const own = text(attr(entry.incident, "IncidentTypeCategory"));
  if (own !== undefined) return own;
  const fromPerimeter = text(attr(entry.perimeter, "IncidentTypeCategory"));
  if (fromPerimeter !== undefined) return fromPerimeter;
  const feature = text(entry.perimeter?.["poly_FeatureCategory"]);
  return feature === "Prescribed Fire" ? "RX" : feature?.startsWith("Wildfire") ? "WF" : undefined;
}

function toDraft(
  entry: Incident,
  geometry: Geometry,
  category: "WF" | "RX",
  feed: HazardsCatalogFeed,
  fetchedAt: string,
): RecordDraft {
  const { perimeter, incident } = entry;
  // The incident layer refreshes every five minutes, the perimeter's copy of the attributes only with its polygon.
  const field = (name: string) => attr(incident, name) ?? attr(perimeter, name);
  const prescribed = category === "RX";
  const name = text(perimeter?.["poly_IncidentName"]) ?? text(field("IncidentName"));
  const acres = finite(perimeter?.["poly_GISAcres"]) ?? finite(field("IncidentSize"));
  const containment = finite(field("PercentContained"));
  const discoveredAt = instant(field("FireDiscoveryDateTime"));
  const out = instant(field("FireOutDateTime"));
  const stated = text(field("FireCause"));
  const cause = stated === undefined ? undefined : CAUSES[stated];
  if (stated !== undefined && cause === undefined) recordSkipped(feed.id, "unknown_value");
  const behaviour = text(field("FireBehaviorGeneral"));
  const fireBehavior = behaviour === undefined ? undefined : BEHAVIOURS[behaviour];
  if (behaviour !== undefined && fireBehavior === undefined) {
    recordSkipped(feed.id, "unknown_value");
  }
  const containedAt = instant(field("ContainmentDateTime"));
  const controlledAt = instant(field("ControlDateTime"));
  const uniqueId = text(field("UniqueFireIdentifier"));
  const fips = text(field("POOFips"));
  // The register writes a placeholder ("null Miles null from null, ") where it has no place.
  const where = text(field("IncidentShortDescription"));
  const placeText = where !== undefined && !/\bnull\b/.test(where) ? where : undefined;
  const complex = irwinOf(field("CpxID"));
  const state = text(field("POOState"));
  const perimeterAt =
    entry.shape === undefined ? undefined : instant(perimeter?.["poly_PolygonDateTime"]);
  const sourceUpdatedAt =
    instant(perimeter?.["poly_DateCurrent"]) ?? instant(field("ModifiedOnDateTime_dt"));
  return {
    id: situationId(feed, entry.irwin),
    class: "situation",
    kind: "natural_hazard",
    type: "wildfire",
    ...(prescribed
      ? { subtype: "prescribed_burn" }
      : entry.shape === undefined
        ? {}
        : { subtype: "wildfire_perimeter" }),
    temporality: "live",
    externalIds: [
      { scheme: "irwin", id: entry.irwin },
      ...(uniqueId === undefined ? [] : [{ scheme: "nwcg:unique_fire_id", id: uniqueId }]),
    ],
    location: {
      geometry,
      extent: entry.shape === undefined ? "point" : "area",
      geometryOrigin: "source",
      fuzziness: "exact",
      admin: {
        country: "US",
        ...(state !== undefined && /^US-[A-Z]{2}$/.test(state) ? { subdivision: state } : {}),
        ...(fips !== undefined && /^\d{5}$/.test(fips)
          ? { geocodes: [{ scheme: "fips", code: fips }] }
          : {}),
      },
      ...(placeText === undefined ? {} : { areaDescription: [{ lang: "en", text: placeText }] }),
    },
    provenance: provenance(feed, entry.irwin, sourceUpdatedAt),
    freshness: freshness(fetchedAt),
    planned: prescribed,
    certainty: "observed",
    severity: { label: "unknown" },
    // The fires of a complex are one group, named by the complex's IRWIN id.
    ...(complex === undefined || complex === entry.irwin ? {} : { groupId: complex }),
    validity: {
      status: out === undefined ? "active" : "ended",
      ...(discoveredAt === undefined ? {} : { start: discoveredAt }),
      ...(out === undefined ? {} : { end: out }),
    },
    effects: [],
    details: {
      kind: "natural_hazard",
      v: 1,
      ...(name === undefined ? {} : { name: [{ lang: "en", text: name }] }),
      ...(acres === undefined || acres < 0 ? {} : { areaHa: round2(acres * ACRE_HA) }),
      ...(containment === undefined || containment < 0 || containment > 100
        ? {}
        : { containmentPct: containment }),
      ...(discoveredAt === undefined ? {} : { discoveredAt }),
      ...(perimeterAt === undefined ? {} : { perimeterAt }),
      ...(cause === undefined ? {} : { ignitionCause: cause }),
      ...(containedAt === undefined ? {} : { containedAt }),
      ...(controlledAt === undefined ? {} : { controlledAt }),
      ...(fireBehavior === undefined ? {} : { fireBehavior }),
    },
  };
}

/**
 * The `wfigs` format: the interagency wildfire registers (WFIGS) as one
 * `natural_hazard` per IRWIN incident id. The `perimeters` role holds the
 * mapped polygons, the `incidents` role every reported incident with its
 * point; the two layers describe the same incident, so they are merged
 * here, not linked. The record is placed at the perimeter when the incident
 * has one, else at its point; the incident layer's attributes, which are the
 * fresher, win over the perimeter's copies.
 *
 * Wildfires with a perimeter are `wildfire_perimeter`, those with a point
 * only carry no subtype, prescribed burns are `prescribed_burn` and planned.
 * Complexes are terminal: their member fires are records of their own,
 * grouped by the complex's IRWIN id. Besides the IRWIN id an incident keeps
 * its NWCG unique fire id, its county's FIPS code, the register's short
 * description of where it is, when it was contained and controlled, and the
 * team's general fire behaviour; a cause or behaviour the register does not
 * define is left out (`unknown_value`). A
 * feature with no geometry is skipped as `no_geometry`; one with no
 * properties, no IRWIN id or an unreadable shape as `malformed`. An
 * incident of a category this format does not know has every usable record
 * skipped as `unknown_type`, as `malformed` when it names none. Neither
 * fails the payload; a publisher `{error}` document fails the parse. A snapshot with no incident is an accounted zero.
 */
export function parseWfigs(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const entries = new Map<string, Incident>();
  let inputCount = 0;
  let duplicates = 0;

  /** A feature's position, or the reason none was taken from it. */
  const placed = <T>(geometry: unknown, read: (value: unknown) => T | null): T | undefined => {
    const value = read(geometry);
    if (value !== null) return value;
    recordSkipped(feed.id, geometry == null ? "no_geometry" : "malformed");
    return undefined;
  };

  const note = (role: "perimeters" | "incidents", features: Feature[]) => {
    for (const { properties, geometry } of features) {
      inputCount++;
      const irwin =
        role === "perimeters"
          ? (irwinOf(properties["poly_IRWINID"]) ?? irwinOf(properties["attr_IrwinID"]))
          : irwinOf(properties["IrwinID"]);
      if (irwin === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const entry = entries.get(irwin) ?? { irwin };
      entries.set(irwin, entry);
      if (role === "perimeters") {
        if (entry.perimeter !== undefined) {
          duplicates++;
          continue;
        }
        entry.perimeter = properties;
        const shape = placed(geometry, polygonalGeometry);
        if (shape !== undefined) entry.shape = shape;
      } else {
        if (entry.incident !== undefined) {
          duplicates++;
          continue;
        }
        entry.incident = properties;
        const point = placed(geometry, pointGeometry);
        if (point !== undefined) entry.point = point;
      }
    }
  };

  for (const role of ["perimeters", "incidents"] as const) {
    for (const body of payloads[role] ?? []) {
      const decoded = featuresOf(body);
      inputCount += decoded.unreadable;
      recordSkipped(feed.id, "malformed", decoded.unreadable);
      note(role, decoded.features);
    }
  }

  let terminal = 0;
  const folded: Record<string, number> = {};
  for (const entry of entries.values()) {
    // A record whose shape could not be read is already counted as skipped.
    const usable = (entry.shape === undefined ? 0 : 1) + (entry.point === undefined ? 0 : 1);
    const category = categoryOf(entry);
    if (category === "CX") {
      terminal += usable;
      continue;
    }
    const place = entry.shape ?? entry.point;
    if (place === undefined) continue;
    if (category !== "WF" && category !== "RX") {
      recordSkipped(feed.id, category === undefined ? "malformed" : "unknown_type", usable);
      continue;
    }
    const draft = toDraft(entry, place, category, feed, ctx.fetchedAt);
    out.situations.push(draft);
    folded[String(draft["id"])] = usable;
  }

  accountSituations(out, { inputCount, duplicates, rejected: 0, terminal, folded });
  return out;
}
