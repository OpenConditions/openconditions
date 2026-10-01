import { type DirectionRef, observationId } from "@openconditions/model";
import type { LineString, Point } from "geojson";
import type { RoadFlow } from "../model.js";
import { directionFromText } from "../situation/location.js";
import type { SourceDescriptor } from "../types.js";

/** A feature or observation draft: plain data the write seam (`sealRecord`) validates. */
export type SiteDraft = Record<string, unknown>;

export interface MeasurementDrafts {
  /** One `measurement_site` per source site. */
  features: SiteDraft[];
  /** The readings of this snapshot: speed, flow and stated level of service. */
  observations: SiteDraft[];
}

interface FlowFormat {
  /** Where site geometry comes from: the payload itself, or a site table or station registry. */
  geometryOrigin: "source" | "site_table";
  /** The properties the format's sites report. */
  properties: readonly string[];
  /** Direction strings are TMC directions (the site is located by Alert-C codes). */
  alertC?: true;
  /** The direction a numbered channel measures. */
  channelDirection?: (channel: string) => DirectionRef | undefined;
}

const SPEED = "traffic.speed";
const VOLUME = "traffic.volume";
const LOS = "traffic.los";

/** Digitraffic direction 1 runs with increasing road address, direction 2 against it. */
const roadAddressDirection = (channel: string): DirectionRef | undefined =>
  channel === "1"
    ? { value: "positive", basis: "road_reference" }
    : channel === "2"
      ? { value: "negative", basis: "road_reference" }
      : undefined;

/** Every flow format and what its sites can report. */
export const FLOW_FORMATS: Readonly<Record<string, FlowFormat>> = {
  datex2: { geometryOrigin: "site_table", properties: [SPEED, LOS] },
  "datex-elaborated": { geometryOrigin: "site_table", properties: [SPEED, VOLUME, LOS] },
  digitraffic: { geometryOrigin: "source", properties: [SPEED, LOS] },
  "fintraffic-tms": {
    geometryOrigin: "site_table",
    properties: [SPEED],
    channelDirection: roadAddressDirection,
  },
  webtris: { geometryOrigin: "site_table", properties: [SPEED] },
  "nyc-dot": { geometryOrigin: "source", properties: [SPEED] },
  ohgo: { geometryOrigin: "source", properties: [SPEED] },
  "trafikverket-flow": { geometryOrigin: "source", properties: [SPEED] },
  "lta-speedbands": { geometryOrigin: "source", properties: [SPEED] },
  "geojson-flow": { geometryOrigin: "source", properties: [SPEED, LOS] },
  "bcn-trams": { geometryOrigin: "site_table", properties: [LOS] },
  bonn: { geometryOrigin: "source", properties: [SPEED, LOS] },
  informo: { geometryOrigin: "source", properties: [LOS] },
  fdt: { geometryOrigin: "source", properties: [SPEED], alertC: true },
  "hk-td": { geometryOrigin: "site_table", properties: [SPEED] },
  miv: { geometryOrigin: "site_table", properties: [SPEED] },
};

/** An instant with a zone designator, normalised to UTC; undefined when unreadable. */
function instant(value: string): string | undefined {
  if (!/T\d{2}:\d{2}/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

interface Site {
  id: string;
  format: string;
  flow: RoadFlow;
  lines: (Point | LineString)[];
  channels: Map<string, DirectionRef | undefined>;
}

function geometryOf(lines: readonly (Point | LineString)[]) {
  if (lines.length === 1) return lines[0]!;
  return {
    type: "MultiLineString",
    coordinates: lines.map((l) => (l as LineString).coordinates),
  };
}

/**
 * Turns one parsed flow snapshot into `measurement_site` features and their
 * observations. A site is the feature; each flow record is one reading of it
 * (or of one of its channels, when the source reports directions separately).
 * A site whose geometry the source splits into several lines is one feature
 * with a multi-line geometry, and its identical readings collapse into one
 * observation. Level of service is an observation only when the source states
 * it; a level computed from speed and free-flow speed stays on the speed's
 * baseline. Throws on a flow without site hints or of an unregistered format:
 * both are parser bugs the golden files must surface.
 */
export function measurementDrafts(
  flows: readonly RoadFlow[],
  opts: { source: SourceDescriptor },
): MeasurementDrafts {
  const { source } = opts;
  const sites = new Map<string, Site>();
  for (const flow of flows) {
    if (flow.site === undefined) throw new TypeError(`flow ${flow.id} carries no site hints`);
    if (FLOW_FORMATS[flow.sourceFormat] === undefined) {
      throw new TypeError(`flow format ${flow.sourceFormat} is not registered`);
    }
    const site: Site = sites.get(flow.site.id) ?? {
      id: flow.site.id,
      format: flow.sourceFormat,
      flow,
      lines: [],
      channels: new Map(),
    };
    sites.set(flow.site.id, site);
    if (!site.lines.some((l) => JSON.stringify(l) === JSON.stringify(flow.geometry))) {
      site.lines.push(flow.geometry as Point | LineString);
    }
    if (flow.site.channel !== undefined) {
      site.channels.set(
        flow.site.channel,
        FLOW_FORMATS[site.format]!.channelDirection?.(flow.site.channel),
      );
    }
  }

  const features: SiteDraft[] = [];
  const locations = new Map<string, Record<string, unknown>>();
  for (const site of sites.values()) {
    const format = FLOW_FORMATS[site.format]!;
    const geometry = geometryOf(site.lines);
    const direction =
      site.channels.size === 0
        ? directionFromText(site.flow.direction, !!format.alertC)
        : undefined;
    const location = {
      geometry,
      extent: geometry.type === "Point" ? "point" : "linear",
      geometryOrigin: format.geometryOrigin,
      fuzziness: "exact",
      ...(direction !== undefined ? { direction } : {}),
    };
    locations.set(site.id, location);
    features.push({
      id: `oc:feature:${source.id}:${site.id}`,
      class: "feature",
      kind: "measurement_site",
      type: "traffic",
      temporality: "static",
      // A site that delivers readings is in operation.
      lifecycle: "operational",
      location,
      provenance: provenanceOf(source, site.format, site.id),
      freshness: { fetchedAt: instant(site.flow.fetchedAt) ?? site.flow.fetchedAt },
      ...(site.channels.size > 0
        ? {
            components: [...site.channels].map(([key, dir]) => ({
              key,
              kind: "sensor_channel",
              details: {
                kind: "sensor_channel",
                v: 1,
                ...(/^\d+$/.test(key) ? { index: Number(key) } : {}),
                ...(dir !== undefined ? { direction: dir } : {}),
                property: SPEED,
              },
            })),
          }
        : {}),
      details: { kind: "measurement_site", v: 1, measuredProperties: format.properties },
    });
  }

  const observations = new Map<string, SiteDraft>();
  for (const flow of flows) {
    const siteId = flow.site!.id;
    const at = instant(flow.dataUpdatedAt);
    if (at === undefined) continue;
    const base = {
      class: "observation",
      kind: "observation",
      temporality: "live",
      location: locations.get(siteId)!,
      provenance: provenanceOf(
        source,
        flow.sourceFormat,
        flow.site!.channel === undefined ? siteId : `${siteId}/${flow.site!.channel}`,
      ),
      freshness: { fetchedAt: instant(flow.fetchedAt) ?? flow.fetchedAt },
      subject: {
        kind: "feature",
        featureId: `oc:feature:${source.id}:${siteId}`,
        ...(flow.site!.channel !== undefined ? { componentKey: flow.site!.channel } : {}),
      },
      phenomenonTime: { instant: at },
    };
    const add = (draft: Record<string, unknown>) => {
      const id = observationId(source.id, draft as never);
      observations.set(id, { id, ...draft });
    };
    if (flow.speedKph !== undefined) {
      add({
        ...base,
        property: SPEED,
        result: { type: "quantity", value: flow.speedKph, unit: "km/h" },
        aggregation: "mean",
        ...(flow.freeFlowKph !== undefined
          ? {
              baseline: {
                freeFlow: { value: flow.freeFlowKph, unit: "km/h" },
                source: flow.freeFlowSource ?? "native",
                ...(flow.speedRatio !== undefined ? { ratio: flow.speedRatio } : {}),
                ...(flow.site!.losDerived ? { los: flow.los } : {}),
              },
            }
          : {}),
      });
    }
    if (flow.volume !== undefined) {
      add({
        ...base,
        property: VOLUME,
        result: { type: "quantity", value: flow.volume, unit: "1/h" },
        aggregation: "mean",
      });
    }
    if (flow.los !== "unknown" && !flow.site!.losDerived) {
      add({
        ...base,
        property: LOS,
        result: { type: "category", value: flow.los, vocabulary: "los" },
        aggregation: "instantaneous",
      });
    }
  }
  return { features, observations: [...observations.values()] };
}

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
