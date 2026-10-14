import type { RecordDraft } from "@openconditions/ingest-framework";
import { type LIFECYCLES, type LocalizedText, observationId } from "@openconditions/model";
import {
  pointLocation,
  provenance,
  stationFeatureId,
  utcInstant,
  type WeatherFeed,
} from "./records.js";

/** One measured value stream of a station: a numbered road-surface sensor's value, one per property. */
export interface ChannelInput {
  /** The publisher's id of the stream, unique within the station. */
  key: string;
  /** The registered property the stream reports. */
  property: string;
  /** The publisher's number of the sensor the stream belongs to. */
  index?: number;
}

export interface StationInput {
  /** The publisher's own id of the station. */
  stationId: string;
  /** `[lon, lat]`. */
  point: readonly [number, number];
  names: LocalizedText[];
  lifecycle: (typeof LIFECYCLES)[number];
  /** The number of the road the station stands by. */
  roadRef?: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  municipality?: string;
  /** The publisher's station type or model. */
  equipment?: string;
  /** The properties the station reports: at least one. */
  measuredProperties: readonly string[];
  surfaceSensorCount?: number;
  channels: readonly ChannelInput[];
}

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/**
 * A `weather_station` feature with its value streams as `sensor_channel`
 * components. It carries its provider id, so two stations of one source never
 * link.
 */
export function stationDraft(
  feed: WeatherFeed,
  fetchedAt: string,
  input: StationInput,
): RecordDraft {
  const components = input.channels.map((channel) => ({
    key: channel.key,
    kind: "sensor_channel",
    details: {
      kind: "sensor_channel",
      v: 1,
      ...optional("index", channel.index),
      property: channel.property,
    },
  }));
  return {
    id: stationFeatureId(feed, input.stationId),
    class: "feature",
    kind: "weather_station",
    temporality: "static",
    lifecycle: input.lifecycle,
    location: {
      ...pointLocation(input.point),
      ...(input.roadRef === undefined ? {} : { roads: [{ ref: input.roadRef }] }),
      admin: { country: input.country, ...optional("municipality", input.municipality) },
    },
    provenance: provenance(feed, input.stationId),
    freshness: { fetchedAt },
    externalIds: [{ scheme: "provider", id: input.stationId, authority: feed.id }],
    ...(input.names.length === 0 ? {} : { name: input.names }),
    ...(components.length === 0 ? {} : { components }),
    details: {
      kind: "weather_station",
      v: 1,
      ...(input.equipment === undefined ? {} : { equipment: [input.equipment] }),
      measuredProperties: [...input.measuredProperties],
      ...optional("surfaceSensorCount", input.surfaceSensorCount),
    },
  };
}

export interface ReadingInput {
  stationId: string;
  point: readonly [number, number];
  /** The channel of the station the value belongs to; the station itself without one. */
  componentKey?: string;
  property: string;
  result: Record<string, unknown>;
  /** When the publisher measured the value, a UTC instant: the end of its window when it has one. */
  measuredAt: string;
  /** The span the value summarises, ending at `measuredAt`; an instant reading without one. */
  windowSec?: number;
  aggregation: "instantaneous" | "mean" | "max";
  /** The publisher's quality code of a value it does not call reliable. */
  supplierCode?: string;
}

/**
 * A live reading of one station or channel, as of the publisher's
 * measurement time held to the fetch: a value cannot be newer than the fetch
 * that read it. A value over a window states the window.
 */
export function reading(feed: WeatherFeed, fetchedAt: string, input: ReadingInput): RecordDraft {
  const end = Math.min(Date.parse(input.measuredAt), Date.parse(fetchedAt));
  const phenomenonTime =
    input.windowSec === undefined
      ? { instant: utcInstant(new Date(end)) }
      : {
          start: utcInstant(new Date(end - input.windowSec * 1000)),
          end: utcInstant(new Date(end)),
        };
  const draft = {
    class: "observation",
    kind: "observation",
    property: input.property,
    temporality: "live",
    location: pointLocation(input.point),
    provenance: provenance(feed, input.stationId),
    freshness: { fetchedAt },
    subject: {
      kind: "feature",
      featureId: stationFeatureId(feed, input.stationId),
      ...optional("componentKey", input.componentKey),
    },
    result: input.result,
    phenomenonTime,
    aggregation: input.aggregation,
    ...(input.supplierCode === undefined ? {} : { quality: { supplierCode: input.supplierCode } }),
  };
  return { id: observationId(feed.id, draft as never), ...draft };
}
