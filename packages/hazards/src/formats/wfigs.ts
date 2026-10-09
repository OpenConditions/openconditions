import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
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
  const cause = CAUSES[text(field("FireCause")) ?? ""];
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
    externalIds: [{ scheme: "irwin", id: entry.irwin }],
    location: {
      geometry,
      extent: entry.shape === undefined ? "point" : "area",
      geometryOrigin: "source",
      fuzziness: "exact",
      admin: {
        country: "US",
        ...(state !== undefined && /^US-[A-Z]{2}$/.test(state) ? { subdivision: state } : {}),
      },
    },
    provenance: provenance(feed, entry.irwin, sourceUpdatedAt),
    freshness: freshness(fetchedAt),
    planned: prescribed,
    certainty: "observed",
    severity: { label: "unknown" },
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
 * Complexes are skipped: their member fires are records of their own. A
 * feature with no IRWIN id, an unreadable shape or an unknown category is
 * rejected and counted, never the payload; a publisher `{error}` document
 * fails the parse. A snapshot with no incident is an accounted zero.
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
  let rejected = 0;

  const note = (role: "perimeters" | "incidents", features: Feature[]) => {
    for (const { properties, geometry } of features) {
      inputCount++;
      const irwin =
        role === "perimeters"
          ? (irwinOf(properties["poly_IRWINID"]) ?? irwinOf(properties["attr_IrwinID"]))
          : irwinOf(properties["IrwinID"]);
      if (irwin === undefined) {
        rejected++;
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
        const shape = polygonalGeometry(geometry);
        if (shape === null) rejected++;
        else entry.shape = shape;
      } else {
        if (entry.incident !== undefined) {
          duplicates++;
          continue;
        }
        entry.incident = properties;
        const point = pointGeometry(geometry);
        if (point === null) rejected++;
        else entry.point = point;
      }
    }
  };

  for (const role of ["perimeters", "incidents"] as const) {
    for (const body of payloads[role] ?? []) {
      const decoded = featuresOf(body);
      inputCount += decoded.unreadable;
      rejected += decoded.unreadable;
      note(role, decoded.features);
    }
  }

  let terminal = 0;
  const folded: Record<string, number> = {};
  for (const entry of entries.values()) {
    // A record whose shape was rejected is already counted in `rejected`.
    const usable = (entry.shape === undefined ? 0 : 1) + (entry.point === undefined ? 0 : 1);
    const category = categoryOf(entry);
    if (category === "CX") {
      terminal += usable;
      continue;
    }
    const place = entry.shape ?? entry.point;
    if (place === undefined) continue;
    if (category !== "WF" && category !== "RX") {
      rejected += usable;
      continue;
    }
    const draft = toDraft(entry, place, category, feed, ctx.fetchedAt);
    out.situations.push(draft);
    folded[String(draft["id"])] = usable;
  }

  accountSituations(out, { inputCount, duplicates, rejected, terminal, folded });
  return out;
}
