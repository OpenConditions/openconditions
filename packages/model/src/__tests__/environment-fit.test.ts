import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observationId, qualifierKey, subjectKey } from "../classes/observation.js";
import { kernelModule } from "../kernel/module.js";
import { buildRegistry } from "../registry/build.js";
import {
  defineDomain,
  defineKind,
  defineProperty,
  defineVocabulary,
  extendVocabulary,
  type RegistryModule,
} from "../registry/define.js";

/**
 * Environment fit check: three real records mapped onto
 * Feature, Component and Observation with a test-only `environment` module —
 * nothing here is registered in production. Records captured
 * 2026-09-18 from PEGELONLINE (water gauge), Sensor.Community (citizen sensor)
 * and ECCC (authoritative AQHI). Findings: docs/model.md "Environment fit check".
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/environment/${name}`, import.meta.url), "utf8"));

const environment: RegistryModule = {
  name: "environment-fit",
  entries: [
    defineDomain({
      code: "environment",
      description: "continuous environmental monitoring (not registered in production yet)",
    }),
    defineDomain({ code: "weather", description: "meteorological data" }),
    extendVocabulary({
      vocabulary: "external_id_scheme",
      values: [
        "pegelonline:uuid",
        "de:pegelnummer",
        "sensor_community:location",
        "sensor_community:sensor",
        "eccc:aqhi_location",
      ],
    }),
    extendVocabulary({
      vocabulary: "source_format",
      values: ["pegelonline", "sensor_community", "eccc_aqhi"],
    }),
    defineVocabulary({
      code: "water_level_class",
      values: ["low", "normal", "high", "unknown"],
      extensible: false,
      description: "gauge level class",
    }),
    defineKind({
      class: "feature",
      code: "water_gauge",
      domain: "environment",
      version: "1.0",
      description: "river gauge",
      details: (k) => ({
        water: k.Text,
        gaugeZero: z
          .strictObject({ height: k.Quantity, datum: z.string(), validFrom: z.string() })
          .optional(),
      }),
    }),
    defineKind({
      class: "component",
      code: "sensor",
      version: "1.0",
      description: "a physical sensor device on a station",
      details: () => ({ model: z.string(), manufacturer: z.string().optional() }),
    }),
    defineKind({
      class: "feature",
      code: "air_quality_station",
      domain: "environment",
      version: "1.0",
      description: "air quality monitoring site",
      details: () => ({ indoor: z.boolean().optional() }),
      components: ["sensor"],
    }),
    ...(
      [
        ["water.level", "environment", "m", ["water_gauge"]],
        ["water.discharge", "environment", "m3/s", ["water_gauge"]],
        ["air.pm10", "environment", "ug/m3", ["air_quality_station"]],
        ["air.pm2_5", "environment", "ug/m3", ["air_quality_station"]],
        ["weather.air_temperature", "weather", "Cel", ["air_quality_station"]],
        ["weather.humidity", "weather", "%", ["air_quality_station"]],
        ["weather.air_pressure", "weather", "Pa", ["air_quality_station"]],
        ["weather.air_pressure_msl", "weather", "Pa", ["air_quality_station"]],
      ] as const
    ).map(([code, domain, unit, featureKinds]) =>
      defineProperty({
        code,
        domain,
        version: "1.0",
        description: code,
        result: { type: "quantity", unit },
        subjects: [{ kind: "feature", featureKinds }],
      }),
    ),
    defineProperty({
      code: "water.level_class",
      domain: "environment",
      version: "1.0",
      description: "gauge level relative to a national reference scheme",
      result: { type: "category", vocabulary: "water_level_class" },
      subjects: [{ kind: "feature", featureKinds: ["water_gauge"] }],
      qualifiers: () => ({ scheme: z.enum(["mnw_mhw", "nsw_hsw"]) }),
    }),
    defineProperty({
      code: "air.index",
      domain: "environment",
      version: "1.0",
      description:
        "air-quality index; scales are not comparable, so the scale is part of the series key",
      result: { type: "quantity", unit: "1" },
      subjects: [{ kind: "feature", featureKinds: ["air_quality_station"] }],
      qualifiers: () => ({ scale: z.enum(["ca_aqhi", "eu_eaqi", "us_aqi", "caqi"]) }),
    }),
  ],
};

const registry = buildRegistry([kernelModule, environment]);
const FETCHED = "2026-09-18T10:10:00Z";

function provenance(
  sourceId: string,
  sourceFormat: string,
  recordId: string,
  provider: string,
  license: string,
) {
  return {
    origin: "feed",
    sourceId,
    sourceFormat,
    accessMode: "bulk",
    recordId,
    attribution: { provider, license },
    privacy: { class: "authoritative" },
  };
}

function observation(
  featureId: string,
  base: { location: unknown; provenance: ReturnType<typeof provenance> },
  o: {
    localId: string;
    property: string;
    result: unknown;
    at: unknown;
    componentKey?: string;
    qualifiers?: unknown;
    quality?: unknown;
    aggregation?: string;
    extras?: unknown;
  },
) {
  const draft = {
    class: "observation",
    kind: "observation",
    property: o.property,
    temporality: "live",
    location: base.location,
    provenance: { ...base.provenance, recordId: o.localId },
    freshness: { fetchedAt: FETCHED },
    subject: {
      kind: "feature",
      featureId,
      ...(o.componentKey ? { componentKey: o.componentKey } : {}),
    },
    result: o.result,
    phenomenonTime: o.at,
    aggregation: o.aggregation ?? "instantaneous",
    ...(o.qualifiers ? { qualifiers: o.qualifiers } : {}),
    ...(o.quality ? { quality: o.quality } : {}),
    ...(o.extras ? { extras: o.extras } : {}),
  };
  return { id: observationId(base.provenance.sourceId, draft as never), ...draft };
}

function pegelonline() {
  const raw = fixture("pegelonline-koeln.json");
  const featureId = `oc:feature:de-pegelonline:${raw.uuid}`;
  const location = {
    geometry: { type: "Point", coordinates: [raw.longitude, raw.latitude] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
    linear: { system: "kilometre_post", ref: raw.water.shortname, from: raw.km },
  };
  const prov = provenance(
    "de-pegelonline",
    "pegelonline",
    raw.uuid,
    "WSV / PEGELONLINE",
    "DL-DE-ZERO-2.0",
  );
  const w = raw.timeseries.find((t: { shortname: string }) => t.shortname === "W");
  const q = raw.timeseries.find((t: { shortname: string }) => t.shortname === "Q");
  const feature = {
    id: featureId,
    class: "feature",
    kind: "water_gauge",
    temporality: "static",
    lifecycle: "operational",
    name: [{ lang: "de", text: raw.longname }],
    externalIds: [
      { scheme: "pegelonline:uuid", id: raw.uuid },
      { scheme: "de:pegelnummer", id: raw.number, authority: "WSV" },
    ],
    operator: {
      role: "operator",
      name: [{ lang: "de", text: raw.agency }],
      phone: raw.voiceServiceNumber,
    },
    location,
    provenance: prov,
    freshness: { fetchedAt: FETCHED },
    details: {
      kind: "water_gauge",
      v: 1,
      water: [{ lang: "de", text: raw.water.longname }],
      gaugeZero: {
        height: { value: w.gaugeZero.value, unit: "m" },
        datum: w.gaugeZero.unit,
        validFrom: w.gaugeZero.validFrom,
      },
    },
  };
  const base = { location, provenance: prov };
  const at = (t: { currentMeasurement: { timestamp: string } }) => ({
    instant: t.currentMeasurement.timestamp,
  });
  const raws = { quality: { verified: false } };
  const observations = [
    observation(featureId, base, {
      localId: `${raw.uuid}/W/${w.currentMeasurement.timestamp}`,
      property: "water.level",
      result: { type: "quantity", value: w.currentMeasurement.value / 100, unit: "m" },
      at: at(w),
      ...raws,
      extras: { raw: { value: w.currentMeasurement.value, unit: w.unit } },
    }),
    observation(featureId, base, {
      localId: `${raw.uuid}/Q/${q.currentMeasurement.timestamp}`,
      property: "water.discharge",
      result: { type: "quantity", value: q.currentMeasurement.value, unit: "m3/s" },
      at: at(q),
      ...raws,
    }),
    ...(
      [
        ["mnw_mhw", w.currentMeasurement.stateMnwMhw],
        ["nsw_hsw", w.currentMeasurement.stateNswHsw],
      ] as const
    ).map(([scheme, value]) =>
      observation(featureId, base, {
        localId: `${raw.uuid}/W-${scheme}/${w.currentMeasurement.timestamp}`,
        property: "water.level_class",
        qualifiers: { scheme },
        result: { type: "category", value, vocabulary: "water_level_class" },
        at: at(w),
        ...raws,
      }),
    ),
  ];
  return { feature, observations };
}

const SENSOR_COMMUNITY_PROPERTIES: Record<string, [string, string]> = {
  P1: ["air.pm10", "ug/m3"],
  P2: ["air.pm2_5", "ug/m3"],
  temperature: ["weather.air_temperature", "Cel"],
  humidity: ["weather.humidity", "%"],
  pressure: ["weather.air_pressure", "Pa"],
  pressure_at_sealevel: ["weather.air_pressure_msl", "Pa"],
};

function sensorCommunity() {
  const readings = fixture("sensor-community-node.json") as Array<{
    location: {
      id: number;
      indoor: number;
      exact_location: number;
      altitude: string;
      latitude: string;
      longitude: string;
      country: string;
    };
    timestamp: string;
    sensor: { id: number; sensor_type: { name: string; manufacturer: string } };
    sensordatavalues: Array<{ value: string | number; value_type: string }>;
  }>;
  const loc = readings[0]!.location;
  const featureId = `oc:feature:eu-sensor-community:${loc.id}`;
  const location = {
    geometry: { type: "Point", coordinates: [Number(loc.longitude), Number(loc.latitude)] },
    extent: "point",
    geometryOrigin: "source",
    // The platform publishes home-sited nodes at a deliberately coarsened position.
    fuzziness: loc.exact_location === 1 ? "exact" : "low_res",
    elevationM: Number(loc.altitude),
    admin: { country: loc.country },
  };
  const prov = provenance(
    "eu-sensor-community",
    "sensor_community",
    String(loc.id),
    "Sensor.Community",
    "ODbL-1.0",
  );
  const sensors = [...new Map(readings.map((r) => [r.sensor.id, r.sensor])).values()];
  const feature = {
    id: featureId,
    class: "feature",
    kind: "air_quality_station",
    temporality: "static",
    lifecycle: "operational",
    externalIds: [{ scheme: "sensor_community:location", id: String(loc.id) }],
    location,
    provenance: prov,
    freshness: { fetchedAt: FETCHED },
    components: sensors.map((s) => ({
      key: String(s.id),
      kind: "sensor",
      externalIds: [{ scheme: "sensor_community:sensor", id: String(s.id) }],
      details: {
        kind: "sensor",
        v: 1,
        model: s.sensor_type.name,
        manufacturer: s.sensor_type.manufacturer,
      },
    })),
    details: { kind: "air_quality_station", v: 1, indoor: loc.indoor === 1 },
  };
  const observations = readings.flatMap((r) =>
    r.sensordatavalues.map((v) => {
      const [property, unit] = SENSOR_COMMUNITY_PROPERTIES[v.value_type]!;
      // Timestamps are UTC without a designator; the kernel requires one.
      const instant = `${r.timestamp.replace(" ", "T")}Z`;
      return observation(
        featureId,
        { location, provenance: prov },
        {
          localId: `${loc.id}/${r.sensor.id}/${v.value_type}/${instant}`,
          property,
          componentKey: String(r.sensor.id),
          result: { type: "quantity", value: Number(v.value), unit },
          at: { instant },
        },
      );
    }),
  );
  return { feature, observations };
}

function ecccAqhi() {
  const raw = fixture("eccc-aqhi-hapnv.json");
  const p = raw.properties;
  const featureId = `oc:feature:ca-eccc-aqhi:${p.location_id}`;
  const location = {
    geometry: raw.geometry,
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
    admin: { country: "CA" },
  };
  const prov = provenance(
    "ca-eccc-aqhi",
    "eccc_aqhi",
    p.location_id,
    "Environment and Climate Change Canada",
    "OGL-Canada-2.0",
  );
  const feature = {
    id: featureId,
    class: "feature",
    kind: "air_quality_station",
    temporality: "static",
    lifecycle: "operational",
    name: [
      { lang: "en", text: p.location_name_en },
      { lang: "fr", text: p.location_name_fr },
    ],
    externalIds: [{ scheme: "eccc:aqhi_location", id: p.location_id }],
    location,
    provenance: prov,
    freshness: { fetchedAt: FETCHED },
    details: { kind: "air_quality_station", v: 1 },
  };
  const end = p.observation_datetime;
  const start = new Date(Date.parse(end) - 3 * 3_600_000).toISOString().replace(".000Z", "Z");
  const observations = [
    observation(
      featureId,
      { location, provenance: prov },
      {
        localId: p.id,
        property: "air.index",
        qualifiers: { scale: "ca_aqhi" },
        result: { type: "quantity", value: p.aqhi, unit: "1" },
        // AQHI is computed from three-hour mean concentrations.
        at: { start, end },
        aggregation: "mean",
      },
    ),
  ];
  return { feature, observations };
}

describe("environment fit check", () => {
  it.each([
    ["PEGELONLINE water gauge", pegelonline],
    ["Sensor.Community citizen node", sensorCommunity],
    ["ECCC AQHI station", ecccAqhi],
  ])("maps the %s onto kernel records that pass hard validation", (_label, map) => {
    const { feature, observations } = map();
    const checked = [feature, ...observations].map((r) => registry.validateDraft(r));
    for (const result of checked) {
      expect(result.ok, JSON.stringify(result.ok ? null : result.issues)).toBe(true);
    }
    expect(observations.length).toBeGreaterThan(0);
  });

  it("keys a citizen node's readings per sensor component and property", () => {
    const { observations } = sensorCommunity();
    const keys = new Set(observations.map((o) => `${subjectKey(o as never)} ${o.property}`));
    expect(keys).toEqual(
      new Set([
        "feature:oc:feature:eu-sensor-community:73594#49473 weather.air_temperature",
        "feature:oc:feature:eu-sensor-community:73594#49473 weather.air_pressure",
        "feature:oc:feature:eu-sensor-community:73594#49473 weather.humidity",
        "feature:oc:feature:eu-sensor-community:73594#49473 weather.air_pressure_msl",
        "feature:oc:feature:eu-sensor-community:73594#49472 air.pm10",
        "feature:oc:feature:eu-sensor-community:73594#49472 air.pm2_5",
      ]),
    );
  });

  it("never lets an index share a series with a concentration or another scale", () => {
    const [aqhi] = ecccAqhi().observations;
    expect(qualifierKey(aqhi!.qualifiers as Record<string, unknown>)).toBe('{"scale":"ca_aqhi"}');
    const noScale: Record<string, unknown> = { ...aqhi! };
    delete noScale["qualifiers"];
    expect(registry.validateDraft(noScale).ok).toBe(false);
    expect(registry.validateDraft({ ...aqhi!, qualifiers: {} }).ok).toBe(false);
    const wrongUnit = { ...aqhi!, result: { type: "quantity", value: 1, unit: "ug/m3" } };
    expect(registry.validateDraft(wrongUnit).ok).toBe(false);
  });

  it("rejects a zone-less source timestamp until ingest adds the designator", () => {
    const [reading] = sensorCommunity().observations;
    const naive = { ...reading!, phenomenonTime: { instant: "2026-09-18 10:06:52" } };
    expect(registry.validateDraft(naive).ok).toBe(false);
  });
});
