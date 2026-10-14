import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  type StatusIndex,
  type StatusOutput,
  type StatusSubject,
} from "@openconditions/ingest-framework";
import type { LIFECYCLES, LocalizedText } from "@openconditions/model";
import { WEATHER_PROPERTIES } from "@openconditions/model-weather";
import type { WeatherCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, listOf, lonLat, numberOf, textOf } from "../records.js";
import { type ChannelInput, reading, stationDraft } from "../station.js";
import {
  DIGITRAFFIC_SENSOR_BY_ID,
  DIGITRAFFIC_SENSORS,
  type DigitrafficSensor,
} from "./digitraffic-sensors.js";

/** Every Digitraffic road weather station stands in Finland; the API states no country. */
const COUNTRY = "FI";

/** The names a station's details give, in Finnish, Swedish and English. */
const NAME_LANGUAGES = ["fi", "sv", "en"] as const;

/**
 * A station's data collection status as a lifecycle. A station removed for
 * good is not read: absent from the complete list, its feature is withdrawn.
 */
const LIFECYCLE: Readonly<Record<string, (typeof LIFECYCLES)[number]>> = {
  GATHERING: "operational",
  REMOVED_TEMPORARILY: "temporarily_closed",
};
const RETIRED = "REMOVED_PERMANENTLY";

/** How long after its measurement each property's value is still current: the model's freshness window. */
const MAX_AGE_SEC: ReadonlyMap<string, number> = new Map(
  WEATHER_PROPERTIES.flatMap((p) =>
    p.freshnessWindowSec === undefined ? [] : [[p.code, p.freshnessWindowSec] as const],
  ),
);

/**
 * Where a station's readings belong, as the full parse found the station:
 * its place and the channels its feature carries, so a status-only parse
 * never writes a reading of a channel the feature lacks.
 */
interface StationSubject extends StatusSubject {
  point: readonly [number, number];
  channels: readonly string[];
}

const isStationSubject = (subject: StatusSubject): subject is StationSubject =>
  subject.point !== undefined && Array.isArray((subject as { channels?: unknown }).channels);

interface Station {
  id: string;
  point: [number, number];
  name?: string;
  collectionStatus?: string;
}

interface StationDetails {
  names: LocalizedText[];
  roadNumber?: string;
  municipality?: string;
  stationType?: string;
  /** The ids of the sensors the station has. */
  sensors: number[];
}

/** One value of the data document. */
interface Sample {
  sensorId: number;
  name?: string;
  value: number;
  unit?: string;
  measuredAt: string;
  windowStart?: string;
  reliability?: string;
}

/** The stations of the `sites` list; one without an id or a place is counted as rejected. */
function stationsOf(body: Buffer, out: Pick<ParseOutput, "rejected">): Station[] {
  const doc = jsonOf(body, "the weather station list");
  if (!isRecord(doc) || !Array.isArray(doc["features"])) {
    throw new Error("the weather station list carries no features");
  }
  return doc["features"].flatMap((feature): Station[] => {
    const props = isRecord(feature) ? feature["properties"] : undefined;
    const geometry = isRecord(feature) ? feature["geometry"] : undefined;
    const coordinates = isRecord(geometry) ? listOf(geometry["coordinates"]) : [];
    const id = isRecord(props) ? textOf(props["id"]) : undefined;
    // The published altitude is always zero, which says nothing.
    const point = lonLat(coordinates[0], coordinates[1]);
    if (!isRecord(props) || id === undefined || point === undefined) {
      out.rejected = (out.rejected ?? 0) + 1;
      return [];
    }
    const name = textOf(props["name"]);
    const collectionStatus = textOf(props["collectionStatus"]);
    return [
      {
        id,
        point,
        ...(name === undefined ? {} : { name }),
        ...(collectionStatus === undefined ? {} : { collectionStatus }),
      },
    ];
  });
}

/**
 * Each station's details by station id. A detail answer that cannot be read
 * is counted as rejected and its station keeps the list's data: the details
 * are fetched one by one, and one bad answer must not cost the others.
 */
function detailsOf(
  bodies: readonly Buffer[],
  out: Pick<ParseOutput, "rejected">,
): Map<string, StationDetails> {
  const details = new Map<string, StationDetails>();
  for (const body of bodies) {
    let doc: unknown;
    try {
      doc = JSON.parse(body.toString("utf8"));
    } catch {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    const props = isRecord(doc) ? doc["properties"] : undefined;
    const id = isRecord(props) ? textOf(props["id"]) : undefined;
    if (!isRecord(props) || id === undefined) {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    const names = isRecord(props["names"]) ? props["names"] : {};
    const roadNumber = isRecord(props["roadAddress"])
      ? textOf(props["roadAddress"]["roadNumber"])
      : undefined;
    const municipality = textOf(props["municipality"]);
    const stationType = textOf(props["stationType"]);
    details.set(id, {
      names: NAME_LANGUAGES.flatMap((lang) => {
        const text = textOf(names[lang]);
        return text === undefined ? [] : [{ lang, text }];
      }),
      ...(roadNumber === undefined ? {} : { roadNumber }),
      ...(municipality === undefined ? {} : { municipality }),
      ...(stationType === undefined ? {} : { stationType }),
      sensors: listOf(props["sensors"]).flatMap((s) => {
        const n = numberOf(s);
        return n === undefined ? [] : [n];
      }),
    });
  }
  return details;
}

const isInstant = (value: string | undefined): value is string =>
  value !== undefined && Number.isFinite(Date.parse(value));

/**
 * Each station's values from the `status` data document, by station id. A
 * value without a sensor id or a numeric value is not one. A malformed
 * document fails the read, unless `rejected` is given: the daily full parse
 * still has its stations to write, so there it is counted as rejected and
 * the stations are read without values.
 */
function samplesOf(
  bodies: readonly Buffer[],
  rejected?: Pick<ParseOutput, "rejected">,
): Map<string, Sample[]> {
  const samples = new Map<string, Sample[]>();
  for (const body of bodies) {
    let doc: unknown;
    try {
      doc = jsonOf(body, "the weather station data document");
      if (!isRecord(doc) || !Array.isArray(doc["stations"])) {
        throw new Error("the weather station data document carries no stations");
      }
    } catch (error) {
      if (rejected === undefined) throw error;
      rejected.rejected = (rejected.rejected ?? 0) + 1;
      continue;
    }
    for (const station of doc["stations"]) {
      if (!isRecord(station)) continue;
      const id = textOf(station["id"]);
      if (id === undefined) continue;
      const updated = textOf(station["dataUpdatedTime"]);
      const values = listOf(station["sensorValues"]).flatMap((v): Sample[] => {
        if (!isRecord(v)) return [];
        const sensorId = numberOf(v["id"]);
        const value = numberOf(v["value"]);
        const measuredAt = textOf(v["timeWindowEnd"]) ?? textOf(v["measuredTime"]) ?? updated;
        if (sensorId === undefined || value === undefined || !isInstant(measuredAt)) return [];
        const name = textOf(v["name"]);
        const unit = textOf(v["unit"]);
        const windowStart = textOf(v["timeWindowStart"]);
        const reliability = textOf(v["reliability"]);
        return [
          {
            sensorId,
            value,
            measuredAt,
            ...(name === undefined ? {} : { name }),
            ...(unit === undefined ? {} : { unit }),
            ...(isInstant(windowStart) ? { windowStart } : {}),
            ...(reliability === undefined ? {} : { reliability }),
          },
        ];
      });
      samples.set(id, [...(samples.get(id) ?? []), ...values]);
    }
  }
  return samples;
}

/** The sensor a value is of, when it is one read here and carries the sensor's own name. */
function sensorOf(sample: Sample): DigitrafficSensor | undefined {
  const sensor = DIGITRAFFIC_SENSOR_BY_ID.get(sample.sensorId);
  if (sensor === undefined) return undefined;
  return sample.name === undefined || sample.name === sensor.name ? sensor : undefined;
}

/** A value's result: a quantity in the property's unit, or the category its code names. */
function resultOf(sensor: DigitrafficSensor, value: number): Record<string, unknown> | undefined {
  if (sensor.modelUnit !== undefined) {
    return { type: "quantity", value, unit: sensor.modelUnit };
  }
  if (sensor.codes === undefined || sensor.vocabulary === undefined) return undefined;
  if (!Object.hasOwn(sensor.codes, value)) return undefined;
  const code = sensor.codes[value];
  return code === null || code === undefined
    ? { type: "unknown" }
    : { type: "category", value: code, vocabulary: sensor.vocabulary };
}

/**
 * The reading of one value, or undefined for a value not read: of a sensor
 * read here only, stated in its sensor's unit, not marked faulty, measured
 * within its property's freshness window of the fetch, and of a channel the
 * station's feature carries. A value whose code or name the publisher's
 * tables do not hold is counted as rejected.
 */
function readingOf(
  feed: WeatherCatalogFeed,
  fetchedAt: string,
  subject: StationSubject,
  sample: Sample,
  out: Pick<ParseOutput, "rejected">,
): RecordDraft | undefined {
  const known = DIGITRAFFIC_SENSOR_BY_ID.get(sample.sensorId);
  if (known === undefined) return undefined;
  const sensor = sensorOf(sample);
  const result = sensor === undefined ? undefined : resultOf(sensor, sample.value);
  if (sensor === undefined || result === undefined) {
    out.rejected = (out.rejected ?? 0) + 1;
    return undefined;
  }
  if (sample.reliability === "FAULTY") return undefined;
  if (sample.unit !== undefined && sample.unit !== sensor.unit) {
    out.rejected = (out.rejected ?? 0) + 1;
    return undefined;
  }
  const maxAgeSec = MAX_AGE_SEC.get(sensor.property);
  const ageSec = (Date.parse(fetchedAt) - Date.parse(sample.measuredAt)) / 1000;
  if (maxAgeSec !== undefined && ageSec > maxAgeSec) return undefined;
  const componentKey = sensor.channel === undefined ? undefined : String(sensor.id);
  if (componentKey !== undefined && !subject.channels.includes(componentKey)) return undefined;
  const windowSec =
    sample.windowStart === undefined
      ? sensor.windowSec
      : (Date.parse(sample.measuredAt) - Date.parse(sample.windowStart)) / 1000;
  return reading(feed, fetchedAt, {
    stationId: subject.stationId,
    point: subject.point,
    ...(componentKey === undefined ? {} : { componentKey }),
    property: sensor.property,
    result,
    measuredAt: sample.measuredAt,
    ...(windowSec === undefined || windowSec <= 0 ? {} : { windowSec }),
    aggregation: sensor.aggregation,
    ...(sample.reliability === undefined || sample.reliability === "OK"
      ? {}
      : { supplierCode: sample.reliability }),
  });
}

/**
 * The readings of every station the data document names, placed through the
 * index; a station with values that the index does not hold is counted as
 * rejected.
 */
function readingsOf(
  feed: WeatherCatalogFeed,
  fetchedAt: string,
  index: StatusIndex,
  samples: ReadonlyMap<string, readonly Sample[]>,
  out: Pick<ParseOutput, "rejected">,
): RecordDraft[] {
  const readings: RecordDraft[] = [];
  for (const [stationId, values] of samples) {
    if (values.length === 0) continue;
    const subject = index.get(stationId)?.find(isStationSubject);
    if (subject === undefined) {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    for (const sample of values) {
      const draft = readingOf(feed, fetchedAt, subject, sample, out);
      if (draft !== undefined) readings.push(draft);
    }
  }
  return readings;
}

/**
 * The sensors a station reports: those the data document gives it a value
 * of, at any age. The details list every sensor the station was ever set up
 * with, third and fourth surface sensors it does not have included, so they
 * stand in only for a station without values (one not collecting now).
 */
function sensorsOf(
  details: StationDetails | undefined,
  samples: readonly Sample[],
): DigitrafficSensor[] {
  const reported = new Set(samples.flatMap((s) => (sensorOf(s) === undefined ? [] : [s.sensorId])));
  const ids = reported.size > 0 ? reported : new Set(details?.sensors ?? []);
  return DIGITRAFFIC_SENSORS.filter((sensor) => ids.has(sensor.id));
}

/**
 * Fintraffic's road weather stations: the station list (`sites`), each
 * station's details (`details`, one answer per station) and every station's
 * latest values (`status`). A station is a `weather_station` whose air values
 * are its own readings and whose road-surface values are each a
 * `sensor_channel` of it, keyed by the publisher's sensor id, so numbered
 * surface sensors stay separate series. The details name the station in
 * Finnish, Swedish and English and give its road and municipality; a station
 * without details keeps the list's technical name. A station's channels are
 * the sensors its values name, or, without values, those its details list;
 * a station whose sensors are unknown has nothing to report and is counted
 * as rejected.
 */
export function parseDigitrafficWeather(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const sites = payloads["sites"] ?? [];
  if (sites.length === 0) return out;
  const details = detailsOf(payloads["details"] ?? [], out);
  const samples = samplesOf(payloads["status"] ?? [], out);
  const index = new Map<string, StationSubject[]>();
  for (const station of sites.flatMap((body) => stationsOf(body, out))) {
    if (station.collectionStatus === RETIRED || index.has(station.id)) continue;
    const detail = details.get(station.id);
    const sensors = sensorsOf(detail, samples.get(station.id) ?? []);
    if (sensors.length === 0) {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    const channels: ChannelInput[] = sensors.flatMap((sensor) =>
      sensor.channel === undefined
        ? []
        : [
            {
              key: String(sensor.id),
              property: sensor.property,
              ...(sensor.channel.index === undefined ? {} : { index: sensor.channel.index }),
            },
          ],
    );
    const surfaceSensors = new Set(sensors.flatMap((s) => (s.channel ? [s.channel.sensor] : [])));
    const names =
      detail !== undefined && detail.names.length > 0
        ? detail.names
        : station.name === undefined
          ? []
          : [{ lang: "und", text: station.name }];
    out.features.push(
      stationDraft(feed, ctx.fetchedAt, {
        stationId: station.id,
        point: station.point,
        names,
        lifecycle: LIFECYCLE[station.collectionStatus ?? ""] ?? "unknown",
        country: COUNTRY,
        ...(detail?.roadNumber === undefined ? {} : { roadRef: detail.roadNumber }),
        ...(detail?.municipality === undefined ? {} : { municipality: detail.municipality }),
        ...(detail?.stationType === undefined ? {} : { equipment: detail.stationType }),
        measuredProperties: [...new Set(sensors.map((s) => s.property))],
        ...(surfaceSensors.size === 0 ? {} : { surfaceSensorCount: surfaceSensors.size }),
        channels,
      }),
    );
    index.set(station.id, [
      { stationId: station.id, point: station.point, channels: channels.map((c) => c.key) },
    ]);
  }
  out.observations.push(...readingsOf(feed, ctx.fetchedAt, index, samples, out));
  out.statusIndex = index;
  return out;
}

/** The status-only reading of the `status` data document, placed through the last full parse's index. */
export function parseDigitrafficWeatherStatus(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  const out = { rejected: 0 };
  const observations = readingsOf(
    feed,
    ctx.fetchedAt,
    index,
    samplesOf(payloads["status"] ?? []),
    out,
  );
  return { observations, rejected: out.rejected };
}
