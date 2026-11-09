import {
  emptyParseOutput,
  type FeedPayloads,
  type ObservationRevision,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import type { WeatherCatalogFeed } from "../feed-schema.js";
import { instantOf, isRecord, jsonOf, lonLat, stationFeatureId, utcInstant } from "../records.js";
import { reading, stationDraft } from "../station.js";

const DATASET = "msc-observation-atmospheric-surface_weather-ca-1.1-ascii";
export const ECCC_MEASUREMENTS = [
  {
    field: "air_temp",
    property: "weather.air_temperature",
    unit: "°C",
    modelUnit: "Cel",
    min: -100,
    max: 70,
  },
  { field: "rel_hum", property: "weather.humidity", unit: "%", modelUnit: "%", min: 0, max: 100 },
  {
    field: "avg_wnd_spd_10m_pst10mts",
    property: "weather.wind_speed",
    unit: "km/h",
    modelUnit: "m/s",
    min: 0,
    max: 500,
    windowSec: 600,
  },
  {
    field: "avg_wnd_dir_10m_pst10mts",
    property: "weather.wind_direction",
    unit: "°",
    modelUnit: "deg",
    min: 0,
    max: 360,
    windowSec: 600,
  },
  {
    field: "pcpn_amt_pst1hr",
    property: "weather.precipitation_amount",
    unit: "mm",
    modelUnit: "mm",
    min: 0,
    max: 2000,
    windowSec: 3600,
  },
] as const;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const identity = (v: unknown): string | undefined => {
  const s = text(v);
  return s !== undefined && /^[A-Za-z0-9]+$/.test(s) ? s : undefined;
};

/** A single, bounded, fully accounted GeoMet response. Never infer completeness from a short page. */
function collection(bodies: readonly Buffer[] | undefined): Record<string, unknown>[] {
  if (bodies?.length !== 1 || bodies[0]!.length > 8 * 1024 * 1024)
    throw new Error("SWOB requires one bounded response");
  const doc = jsonOf(bodies[0]!, "SWOB");
  if (
    !isRecord(doc) ||
    doc["type"] !== "FeatureCollection" ||
    doc["crs"] !== undefined ||
    !Array.isArray(doc["features"]) ||
    !Number.isSafeInteger(doc["numberMatched"]) ||
    doc["numberMatched"] !== doc["features"].length ||
    doc["numberReturned"] !== doc["features"].length ||
    doc["features"].length >= 10000 ||
    !Array.isArray(doc["links"]) ||
    doc["links"].some(
      (l) =>
        !isRecord(l) ||
        typeof l["rel"] !== "string" ||
        typeof l["href"] !== "string" ||
        l["rel"] === "next",
    )
  ) {
    throw new Error("SWOB incomplete collection");
  }
  const ids = new Set<string>();
  return doc["features"].map((f: unknown) => {
    if (
      !isRecord(f) ||
      f["type"] !== "Feature" ||
      !isRecord(f["properties"]) ||
      text(f["id"]) === undefined ||
      ids.has(String(f["id"]))
    )
      throw new Error("SWOB malformed or duplicate identity");
    ids.add(String(f["id"]));
    return f;
  });
}

function notices(p: Record<string, unknown>): string | undefined {
  const value = p["data_attrib_not-value"];
  if (value === undefined || value === null || value === "") return "";
  // Additional originators need scope review. The product grant covers this named publisher.
  return value === "Data Source: Environment and Climate Change Canada" ? value : undefined;
}

export function parseEcccStatus(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  const candidates = new Map<
    string,
    { rank: string; signature: string; props: Record<string, unknown>; filename: string }
  >();
  let rejected = 0;
  for (const f of collection(payloads["status"])) {
    const p = f["properties"] as Record<string, unknown>;
    const id = identity(p["msc_id-value"]);
    const measured = instantOf(text(p["date_tm-value"]));
    const observed = instantOf(text(p["obs_date_tm"]));
    const processed = instantOf(text(p["processed_date_tm"]));
    const filename = text(p["id"]);
    const age = measured === undefined ? NaN : Date.parse(ctx.fetchedAt) - Date.parse(measured);
    if (
      p["dataset"] !== DATASET ||
      p["data_pvdr-value"] !== "MSC" ||
      id === undefined ||
      !index.has(id) ||
      measured === undefined ||
      observed !== measured ||
      processed === undefined ||
      filename !== f["id"] ||
      !Number.isFinite(age) ||
      age < 0 ||
      age >= 3600000 ||
      Date.parse(processed) > Date.parse(ctx.fetchedAt) ||
      notices(p) === undefined
    ) {
      rejected++;
      continue;
    }
    // Observation time is not a change cursor. Compare each revisited source record before QA filtering:
    // a correction that suppresses a value must not resurrect the earlier acceptable value.
    const key = `${id}/${measured}`;
    const cor = p["cor-value"];
    if (cor !== undefined && cor !== "orig" && !(typeof cor === "string" && /^CC[A-Z]$/.test(cor)))
      throw new Error("SWOB invalid correction level");
    const level = typeof cor === "string" && cor !== "orig" ? cor.charCodeAt(2) - 64 : 0;
    const rank = `${String(level).padStart(2, "0")}/${new Date(processed).toISOString()}`;
    const signature = JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));
    const prior = candidates.get(key);
    if (prior?.rank === rank && prior.signature !== signature)
      throw new Error("SWOB ambiguous equal-time correction");
    if (prior === undefined || rank > prior.rank)
      candidates.set(key, { rank, signature, props: p, filename: filename! });
  }
  const latest = new Map<string, Record<string, unknown>>();
  const revisions = new Map<string, ObservationRevision>();
  // Stable order also makes equal-time results independent of HTTP response order.
  for (const [key, candidate] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const p = candidate.props;
    const stationId = identity(p["msc_id-value"])!;
    const subject = index.get(stationId)![0]!;
    if (subject.point === undefined) continue;
    const measuredAt = instantOf(text(p["date_tm-value"]))!;
    for (const spec of ECCC_MEASUREMENTS) {
      const value = p[spec.field];
      if (!Object.hasOwn(p, spec.field) && !Object.hasOwn(p, `${spec.field}-qa`)) continue;
      const channel = `${stationId}/${spec.property}`;
      latest.delete(channel);
      const authority: ObservationRevision = {
        featureId: stationFeatureId(feed, stationId),
        property: spec.property,
        measuredAt,
        rank: candidate.rank,
        signature: candidate.signature,
        suppressed: true,
      };
      revisions.set(channel, authority);
      // Guide sections 4.5–4.7: QA100 alone, no derived/estimate/incomplete/trace flags.
      // Trace is not silently turned into a precise zero. Unknown flag forms also fail closed.
      if (
        p[`${spec.field}-qa`] !== 100 ||
        p[`${spec.field}-uom`] !== spec.unit ||
        Object.keys(p).some((k) => k.startsWith(`${spec.field}-data_flag`)) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < spec.min ||
        value > spec.max
      )
        continue;
      authority.suppressed = false;
      const windowSec = "windowSec" in spec ? spec.windowSec : undefined;
      const draft = reading(feed, ctx.fetchedAt, {
        stationId,
        point: subject.point,
        property: spec.property,
        result: {
          type: "quantity",
          value: spec.modelUnit === "m/s" ? value / 3.6 : value,
          unit: spec.modelUnit,
        },
        measuredAt,
        ...(windowSec === undefined ? {} : { windowSec }),
        aggregation:
          spec.property === "weather.precipitation_amount"
            ? "sum"
            : windowSec === undefined
              ? "instantaneous"
              : "mean",
      });
      draft["freshness"] = {
        fetchedAt: ctx.fetchedAt,
        expiresAt: utcInstant(new Date(Date.parse(measuredAt) + 3600000)),
      };
      const provenance = draft["provenance"] as Record<string, unknown>;
      provenance["recordId"] = candidate.filename;
      provenance["sourceUpdatedAt"] = instantOf(text(p["processed_date_tm"]));
      if (text(p["cor-value"])) provenance["recordVersion"] = p["cor-value"];
      const uri = text(p["url"]);
      if (uri?.startsWith("https://dd.weather.gc.ca/")) provenance["sourceUri"] = uri;
      const notice = notices(p);
      if (notice)
        (provenance["attribution"] as Record<string, unknown>)["provider"] =
          `${feed.attribution}; ${notice}`;
      latest.set(`${stationId}/${spec.property}`, draft);
    }
    void key;
  }
  return {
    observations: [...latest.values()],
    observationRevisions: [...revisions.values()],
    rejected,
  };
}

export function parseEccc(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  out.featuresComplete = false;
  const index = new Map<string, { stationId: string; point: readonly [number, number] }[]>();
  for (const f of collection(payloads["sites"])) {
    const p = f["properties"] as Record<string, unknown>;
    if (p["data_provider"] !== "MSC" || p["dataset_network"] !== "CA") {
      recordSkipped(feed.id, "unknown_type");
      continue;
    }
    const id = identity(p["msc_id"]);
    const g = f["geometry"];
    const coords =
      isRecord(g) && g["type"] === "Point" && Array.isArray(g["coordinates"])
        ? g["coordinates"]
        : [];
    const point = lonLat(coords[0], coords[1]);
    if (id === undefined || id !== f["id"] || point === undefined || index.has(id))
      throw new Error("SWOB invalid station inventory");
    index.set(id, [{ stationId: id, point }]);
    const name = text(p["name"]);
    out.features.push(
      stationDraft(feed, ctx.fetchedAt, {
        stationId: id,
        point,
        names: name === undefined ? [] : [{ lang: "und", text: name }],
        lifecycle: "operational",
        country: "CA",
        measuredProperties: ECCC_MEASUREMENTS.map((s) => s.property),
        channels: [],
        external: [{ system: "ca:msc", code: id }],
      }),
    );
  }
  out.statusIndex = index;
  const status = parseEcccStatus(feed, payloads, ctx, index);
  out.observations = status.observations;
  out.observationRevisions = status.observationRevisions;
  out.rejected = status.rejected;
  return out;
}
