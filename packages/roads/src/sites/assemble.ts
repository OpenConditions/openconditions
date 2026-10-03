import { type DirectionRef, observationId } from "@openconditions/model";
import type { LineString, MultiLineString, Point } from "geojson";
import type { FlowContext, FlowOutput } from "../flow-output.js";
import {
  type ChannelSpec,
  CLASS_SPEED,
  type FlowGeometry,
  type FlowReading,
  LOS,
  type Los,
  OCCUPANCY,
  QUEUING_LOS,
  SPEED,
  saysSomething,
  VOLUME,
} from "../flow-reading.js";
import type { BaselineMethod, RoadEvent } from "../model.js";
import { situationDrafts } from "../situation/assemble.js";
import { directionFromText } from "../situation/location.js";
import type { SourceDescriptor } from "../types.js";

type Draft = Record<string, unknown>;

interface FlowFormat {
  /** Where site geometry comes from: the payload itself, or a site table or station registry. */
  geometryOrigin: "source" | "site_table";
  /** The properties the format's sites report. */
  properties: readonly string[];
  /** Direction strings are TMC directions (the site is located by Alert-C codes). */
  alertC?: true;
}

/** Every flow format and what its sites can report. */
export const FLOW_FORMATS: Readonly<Record<string, FlowFormat>> = {
  datex2: { geometryOrigin: "site_table", properties: [SPEED, VOLUME, OCCUPANCY, LOS] },
  "datex-elaborated": { geometryOrigin: "site_table", properties: [SPEED, VOLUME, LOS] },
  digitraffic: { geometryOrigin: "source", properties: [SPEED, LOS] },
  "fintraffic-tms": { geometryOrigin: "site_table", properties: [SPEED, VOLUME] },
  webtris: { geometryOrigin: "site_table", properties: [SPEED, VOLUME] },
  "nyc-dot": { geometryOrigin: "source", properties: [SPEED] },
  ohgo: { geometryOrigin: "source", properties: [SPEED] },
  "trafikverket-flow": { geometryOrigin: "source", properties: [SPEED, VOLUME] },
  "lta-speedbands": { geometryOrigin: "source", properties: [SPEED] },
  "geojson-flow": { geometryOrigin: "source", properties: [SPEED, LOS] },
  "bcn-trams": { geometryOrigin: "site_table", properties: [LOS] },
  bonn: { geometryOrigin: "source", properties: [SPEED, LOS] },
  informo: { geometryOrigin: "source", properties: [VOLUME, OCCUPANCY, LOS] },
  fdt: { geometryOrigin: "source", properties: [SPEED, VOLUME], alertC: true },
  "hk-td": { geometryOrigin: "site_table", properties: [SPEED, VOLUME, OCCUPANCY] },
  miv: { geometryOrigin: "site_table", properties: [SPEED, VOLUME, OCCUPANCY, CLASS_SPEED] },
};

const UNITS: Record<string, string> = { [SPEED]: "km/h", [VOLUME]: "1/h", [OCCUPANCY]: "%" };

const EQUIPMENT = new Set(["loop", "radar", "camera", "bluetooth", "anpr", "probe", "unknown"]);

/** An instant that names its zone, normalised to UTC; undefined otherwise. */
export function zonedInstant(value: string | undefined): string | undefined {
  if (value === undefined || !/T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The poll's fetch time floored to the feed cadence: the time of a reading the source does not date. */
function pollInstant(ctx: FlowContext): string {
  const step = Math.max(1, ctx.cadenceSec) * 1000;
  return new Date(Math.floor(Date.parse(ctx.now) / step) * step).toISOString();
}

function phenomenonTime(end: string, periodSec: number | undefined) {
  if (periodSec === undefined || periodSec <= 0) return { instant: end };
  return { start: new Date(Date.parse(end) - periodSec * 1000).toISOString(), end };
}

interface Site {
  id: string;
  first: FlowReading;
  lines: (Point | LineString)[];
  channels: Map<string, ChannelSpec>;
}

function linesOf(g: FlowGeometry): (Point | LineString)[] {
  return g.type === "MultiLineString"
    ? g.coordinates.map((coordinates) => ({ type: "LineString", coordinates }) as LineString)
    : [g];
}

function geometryOf(lines: readonly (Point | LineString)[]): Point | LineString | MultiLineString {
  if (lines.length === 1) return lines[0]!;
  return {
    type: "MultiLineString",
    coordinates: lines.map((l) => (l as LineString).coordinates),
  };
}

const featureIdOf = (source: SourceDescriptor, site: string) => `oc:feature:${source.id}:${site}`;

function provenanceOf(source: SourceDescriptor, format: string, recordId: string) {
  return {
    origin: "feed",
    sourceId: source.id,
    sourceFormat: format,
    accessMode: source.accessMode ?? "bulk",
    recordId,
    attribution: {
      provider: source.attribution,
      license: source.license,
      ...(source.licenseUrl ? { licenseUrl: source.licenseUrl } : {}),
    },
    privacy: { class: "authoritative" },
  };
}

function componentOf(spec: ChannelSpec): Draft {
  return {
    key: spec.key,
    kind: "sensor_channel",
    details: {
      kind: "sensor_channel",
      v: 1,
      ...(/^\d+$/.test(spec.key) ? { index: Number(spec.key) } : {}),
      ...(spec.lane !== undefined ? { lane: { index: spec.lane } } : {}),
      ...(spec.direction !== undefined ? { direction: spec.direction } : {}),
      ...(spec.vehicleClass !== undefined ? { vehicleClass: spec.vehicleClass } : {}),
      property: spec.property,
    },
  };
}

/** What a derived congestion situation is drafted from. */
export interface CongestionBasis {
  site: string;
  line?: string;
  geometry: FlowGeometry;
  at: string;
  los: Los;
  /** When the poll fetched the reading. */
  fetchedAt: string;
  freeFlowSource?: BaselineMethod;
  direction?: string;
  directionRef?: DirectionRef;
}

/**
 * Congestion situations derived from sites whose level of service reached
 * queuing or worse: one per site line, located where the site is and naming
 * the site it was derived from.
 */
export function congestionDrafts(
  bases: readonly CongestionBasis[],
  opts: { source: SourceDescriptor; format: string },
): Draft[] {
  const { source, format } = opts;
  const directions = new Map<string, DirectionRef>();
  const events: RoadEvent[] = bases.map((b) => {
    const local = b.line ?? b.site;
    if (b.directionRef !== undefined)
      directions.set(`oc:situation:${source.id}:${local}:congestion`, b.directionRef);
    return {
      id: `${source.id}:${local}:congestion`,
      source: source.id,
      sourceFormat: format,
      domain: "roads",
      kind: "event",
      type: "congestion",
      category: "conditions",
      isPlanned: false,
      severity:
        b.los === "blocked" || b.los === "stationary"
          ? "critical"
          : b.los === "queuing"
            ? "high"
            : "medium",
      severitySource: "derived",
      headline: `Traffic congestion (${local})`,
      situation: { headlineFromSource: false, derivedFromSite: b.site },
      status: "active",
      geometry: b.geometry,
      roads: [],
      origin: {
        kind: "feed",
        attribution: {
          provider: source.attribution,
          license: source.license,
          url: source.licenseUrl,
        },
      },
      dataUpdatedAt: b.at,
      fetchedAt: b.fetchedAt,
      isStale: false,
      validFrom: b.at,
      ...(b.direction ? { direction: b.direction } : {}),
      ...(b.freeFlowSource ? { freeFlowSource: b.freeFlowSource } : {}),
    } as RoadEvent;
  });
  const drafts = situationDrafts(events, { source }) as Draft[];
  for (const draft of drafts) {
    // The situation assembler reads a direction from text only; a site whose
    // direction the parser knows as a reference passes it on unchanged.
    const direction = directions.get(String(draft["id"]));
    if (direction !== undefined) {
      draft["location"] = { ...(draft["location"] as Draft), direction };
    }
    // Congestion holds only while polls keep deriving it: a poll that cannot
    // (its baselines failed to load) leaves it in place, and its expiry ends
    // it after the readings' freshness window rather than never.
    const freshness = draft["freshness"] as { fetchedAt: string };
    draft["freshness"] = {
      ...freshness,
      expiresAt: new Date(Date.parse(freshness.fetchedAt) + CONGESTION_LIFETIME_MS).toISOString(),
    };
  }
  return drafts;
}

/** How long derived congestion holds without a poll deriving it again: a flow reading's freshness window. */
const CONGESTION_LIFETIME_MS = 15 * 60 * 1000;

/**
 * Turns one poll's flow readings into `measurement_site` features, their
 * `traffic.*` readings and the congestion situations derived from them. A
 * site is the feature; its lanes and vehicle classes are `sensor_channel`
 * components with readings of their own. A site whose geometry the source
 * splits into several lines is one feature with a multi-line geometry, and
 * its identical readings collapse into one observation. Level of service is
 * a reading only when the source states it; a level computed from speed and
 * free-flow speed stays on the speed's baseline. A reading the source does
 * not date in a zone is dated by the poll.
 */
export function flowOutput(
  readings: readonly FlowReading[],
  opts: { source: SourceDescriptor; format: string; ctx: FlowContext },
): FlowOutput {
  const { source, format: formatCode, ctx } = opts;
  const format = FLOW_FORMATS[formatCode];
  if (format === undefined) throw new TypeError(`flow format ${formatCode} is not registered`);
  const polled = pollInstant(ctx);
  const fetchedAt = new Date(Date.parse(ctx.now)).toISOString();

  const kept = readings.filter(saysSomething);
  const sites = new Map<string, Site>();
  for (const r of kept) {
    const site: Site = sites.get(r.site) ?? {
      id: r.site,
      first: r,
      lines: [],
      channels: new Map(),
    };
    sites.set(r.site, site);
    for (const line of linesOf(r.geometry)) {
      if (!site.lines.some((l) => JSON.stringify(l) === JSON.stringify(line)))
        site.lines.push(line);
    }
    for (const spec of [...(r.declaredChannels ?? []), ...(r.channels ?? [])]) {
      if (!site.channels.has(spec.key)) {
        site.channels.set(spec.key, {
          key: spec.key,
          property: spec.property,
          ...(spec.lane !== undefined ? { lane: spec.lane } : {}),
          ...(spec.vehicleClass !== undefined ? { vehicleClass: spec.vehicleClass } : {}),
          ...(spec.direction !== undefined ? { direction: spec.direction } : {}),
        });
      }
    }
  }

  const features: Draft[] = [];
  const locations = new Map<string, Draft>();
  for (const site of sites.values()) {
    const { first } = site;
    const geometry = geometryOf(site.lines);
    const direction = first.directionRef ?? directionFromText(first.direction, !!format.alertC);
    const location = {
      geometry,
      extent: geometry.type === "Point" ? "point" : "linear",
      geometryOrigin: format.geometryOrigin,
      fuzziness: "exact",
      ...(direction !== undefined ? { direction } : {}),
    };
    locations.set(site.id, location);
    features.push({
      id: featureIdOf(source, site.id),
      class: "feature",
      kind: "measurement_site",
      type: "traffic",
      temporality: "static",
      ...(first.name ? { name: [{ lang: first.nameLang ?? "und", text: first.name }] } : {}),
      // A site that delivers readings is in operation.
      lifecycle: "operational",
      location,
      provenance: provenanceOf(source, formatCode, site.id),
      freshness: { fetchedAt },
      ...(site.channels.size > 0
        ? { components: [...site.channels.values()].map(componentOf) }
        : {}),
      details: {
        kind: "measurement_site",
        v: 1,
        ...(first.equipment !== undefined && EQUIPMENT.has(first.equipment)
          ? { equipment: first.equipment }
          : {}),
        ...(first.laneCount !== undefined ? { laneCount: first.laneCount } : {}),
        measuredProperties: format.properties,
      },
    });
  }

  const observations = new Map<string, Draft>();
  const congestion: CongestionBasis[] = [];
  for (const r of kept) {
    const at = zonedInstant(r.at) ?? polled;
    const location = locations.get(r.site)!;
    const featureId = featureIdOf(source, r.site);
    const add = (
      property: string,
      result: Draft,
      extra: { componentKey?: string; periodSec?: number; quality?: Draft; baseline?: Draft } = {},
    ) => {
      const { componentKey, quality, baseline } = extra;
      const periodSec = extra.periodSec ?? r.periodSec;
      const draft: Draft = {
        class: "observation",
        kind: "observation",
        temporality: "live",
        location,
        provenance: provenanceOf(
          source,
          formatCode,
          componentKey === undefined ? r.site : `${r.site}/${componentKey}`,
        ),
        freshness: { fetchedAt },
        subject: {
          kind: "feature",
          featureId,
          ...(componentKey !== undefined ? { componentKey } : {}),
        },
        phenomenonTime: phenomenonTime(at, periodSec),
        property,
        result,
        aggregation: property === LOS ? "instantaneous" : "mean",
        ...(quality !== undefined && Object.keys(quality).length > 0 ? { quality } : {}),
        ...(baseline !== undefined ? { baseline } : {}),
      };
      const id = observationId(source.id, draft as never);
      observations.set(id, { id, ...draft });
    };
    const quantity = (property: string, value: number) => ({
      type: "quantity",
      value,
      unit: UNITS[property]!,
    });

    if (r.speedKph !== undefined) {
      add(SPEED, quantity(SPEED, r.speedKph), {
        quality: {
          ...(r.sampleCount !== undefined ? { sampleCount: r.sampleCount } : {}),
          ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
        },
        ...(r.freeFlowKph !== undefined
          ? {
              baseline: {
                freeFlow: { value: r.freeFlowKph, unit: "km/h" },
                source: r.freeFlowSource ?? "native",
                ...(r.speedRatio !== undefined ? { ratio: r.speedRatio } : {}),
                ...(r.losDerived ? { los: r.los } : {}),
              },
            }
          : {}),
      });
    }
    if (r.volume !== undefined) add(VOLUME, quantity(VOLUME, r.volume));
    if (r.occupancy !== undefined) add(OCCUPANCY, quantity(OCCUPANCY, r.occupancy));
    if (r.los !== "unknown" && !r.losDerived) {
      add(LOS, { type: "category", value: r.los, vocabulary: "los" });
    }
    if (r.classSpeeds !== undefined && Object.keys(r.classSpeeds).length > 0) {
      add(CLASS_SPEED, { type: "vector", values: r.classSpeeds, unit: "km/h" });
    }
    for (const c of r.channels ?? []) {
      add(c.property, quantity(c.property, c.value), {
        componentKey: c.key,
        ...(c.periodSec !== undefined ? { periodSec: c.periodSec } : {}),
        quality: c.sampleCount !== undefined ? { sampleCount: c.sampleCount } : {},
      });
    }
    if (QUEUING_LOS.has(r.los)) {
      congestion.push({
        site: r.site,
        ...(r.line !== undefined ? { line: r.line } : {}),
        geometry: r.geometry,
        at,
        los: r.los,
        fetchedAt,
        ...(r.freeFlowSource !== undefined ? { freeFlowSource: r.freeFlowSource } : {}),
        ...(r.direction !== undefined ? { direction: r.direction } : {}),
        ...(r.directionRef !== undefined ? { directionRef: r.directionRef } : {}),
      });
    }
  }

  return {
    features,
    observations: [...observations.values()],
    situations: congestionDrafts(congestion, { source, format: formatCode }),
  };
}
