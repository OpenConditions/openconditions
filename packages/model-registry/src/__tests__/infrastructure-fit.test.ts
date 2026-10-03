import { readFileSync } from "node:fs";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type RegistryModule,
  sealRecord,
} from "@openconditions/model";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Road infrastructure fit check: real published records of every road
 * infrastructure feature kind, mapped onto Feature, Component and Observation and sealed
 * against the production registry. Records captured 2026-09-19 from
 * Digitraffic (Fintraffic, CC BY 4.0: road weather station, weather camera,
 * variable signs, traffic measurement station as DATEX II 3.7), NDW (CC0:
 * route-information panels as DATEX II 3), WSDOT (WZDx 4.2 device feed),
 * Ontario 511 (cameras) and Iowa DOT (snowplow AVL). Only the formats
 * OpenConditions does not parse yet are registered here, by a test-only module.
 */
const fitFormats: RegistryModule = {
  name: "infrastructure-fit",
  entries: [
    extendVocabulary({
      vocabulary: "source_format",
      values: [
        "digitraffic-weather",
        "digitraffic-weathercam",
        "digitraffic-variable-signs",
        "arcgis-avl",
      ],
    }),
  ],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const FETCHED = "2026-09-19T16:05:00Z";

const text = (name: string) =>
  readFileSync(new URL(`./fixtures/infrastructure/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(text(name));
const xml = (name: string) =>
  new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true }).parse(
    text(name),
  );
const list = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

type Draft = Record<string, unknown>;

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

const point = (lon: number, lat: number) => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  extent: "point",
  geometryOrigin: "source",
  fuzziness: "exact",
});

function observation(
  feature: { id: string; location: unknown; provenance: ReturnType<typeof provenance> },
  o: {
    property: string;
    result: unknown;
    at: { instant: string } | { start: string; end: string };
    componentKey?: string;
    aggregation?: string;
    baseline?: unknown;
    location?: unknown;
  },
): Draft {
  const draft = {
    class: "observation",
    kind: "observation",
    property: o.property,
    temporality: "live",
    location: o.location ?? feature.location,
    provenance: feature.provenance,
    freshness: { fetchedAt: FETCHED },
    subject: {
      kind: "feature",
      featureId: feature.id,
      ...(o.componentKey === undefined ? {} : { componentKey: o.componentKey }),
    },
    result: o.result,
    phenomenonTime: o.at,
    aggregation: o.aggregation ?? "instantaneous",
    ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
  };
  return { id: observationId(feature.provenance.sourceId, draft as never), ...draft };
}

const quantity = (value: number, unit: string) => ({ type: "quantity", value, unit });
const category = (value: string, vocabulary: string) => ({ type: "category", value, vocabulary });
const structured = (schema: string, value: object) => ({
  type: "structured",
  schema,
  v: 1,
  value: { v: 1, ...value },
});

/** Seals every record; returns the validation issues of those that fail. */
function sealAll(records: readonly Draft[]) {
  return records.flatMap((r) => {
    const sealed = sealRecord(registry, r, {
      instanceId: "fit.example",
      revision: 1,
      recordedAt: FETCHED,
    });
    return sealed.ok ? [] : [{ id: r["id"], issues: sealed.issues }];
  });
}

/** Digitraffic road-weather sensors → property, unit, channel number (numbered surface sensors). */
const DIGITRAFFIC_WEATHER: Record<string, [property: string, unit: string, channel?: number]> = {
  ILMA: ["weather.air_temperature", "Cel"],
  KASTEPISTE: ["weather.dew_point", "Cel"],
  ILMAN_KOSTEUS: ["weather.humidity", "%"],
  NÄKYVYYS_M: ["weather.visibility", "m"],
  KESKITUULI: ["weather.wind_speed", "m/s"],
  MAKSIMITUULI: ["weather.wind_gust", "m/s"],
  TUULENSUUNTA: ["weather.wind_direction", "deg"],
  SADE_INTENSITEETTI: ["weather.precipitation_rate", "mm/h"],
  TIE_1: ["road.surface_temperature", "Cel", 1],
  TIE_2: ["road.surface_temperature", "Cel", 2],
  MAA_1: ["road.subsurface_temperature", "Cel", 1],
  MAA_2: ["road.subsurface_temperature", "Cel", 2],
  JÄÄTYMISPISTE_1: ["road.freezing_point", "Cel", 1],
  JÄÄTYMISPISTE_2: ["road.freezing_point", "Cel", 2],
  KOSTEUDEN_MÄÄRÄ_1: ["road.water_film", "mm", 1],
  KOSTEUDEN_MÄÄRÄ_2: ["road.water_film", "mm", 2],
  SUOLAN_VÄKEVYYS_1: ["road.salt_concentration", "kg/m3", 1],
  SUOLAN_VÄKEVYYS_2: ["road.salt_concentration", "kg/m3", 2],
};
/**
 * Digitraffic KELI (road condition) codes → surface_state, from the provider's
 * published descriptions (`/api/weather/v1/sensors`); 0 means the sensor has a
 * fault, which is an unknown result, not a surface state.
 */
const DIGITRAFFIC_KELI: Record<number, string> = {
  1: "dry",
  2: "damp",
  3: "wet",
  4: "chemically_wet",
  5: "frost",
  6: "snow",
  7: "ice",
  8: "chemically_wet",
  9: "slush",
};
/** Digitraffic station `state` → device_status: fault reports and repairs in progress are errors. */
const DIGITRAFFIC_STATE: Record<string, string> = {
  OK: "ok",
  OK_FAULT_DOUBT_CANCELLED: "ok",
  FAULT_DOUBT: "warning",
  REPAIR_REQUEST_POSTED: "error",
  REPAIR_MAINTENANCE_DONE: "ok",
  REPAIR_INTERRUPTED: "error",
};

function digitrafficWeatherStation() {
  const station = json("digitraffic-weather-station-1001.json");
  const data = json("digitraffic-weather-station-1001-data.json") as {
    sensorValues: { id: number; name: string; measuredTime: string; value: number }[];
  };
  const p = station.properties;
  const [lon, lat] = station.geometry.coordinates;
  const prov = provenance(
    "fi-digitraffic-weather",
    "digitraffic-weather",
    String(p.id),
    "Fintraffic / digitraffic.fi",
    "CC-BY-4.0",
  );
  const values = data.sensorValues.filter((v) => v.name in DIGITRAFFIC_WEATHER);
  const keli = data.sensorValues.filter((v) => /^KELI_[12]$/.test(v.name));
  const channels = [...values, ...keli].filter(
    (v) => v.name.startsWith("KELI_") || DIGITRAFFIC_WEATHER[v.name]![2] !== undefined,
  );
  const feature = {
    id: `oc:feature:fi-digitraffic-weather:${p.id}`,
    class: "feature",
    kind: "weather_station",
    temporality: "static",
    lifecycle: p.collectionStatus === "GATHERING" ? "operational" : "temporarily_closed",
    name: (["fi", "sv", "en"] as const).map((lang) => ({ lang, text: p.names[lang] })),
    externalIds: [{ scheme: "provider", id: p.liviId, authority: "Fintraffic" }],
    // The published position carries a zero altitude that means "unknown".
    location: {
      ...point(lon, lat),
      roads: [{ ref: String(p.roadAddress.roadNumber) }],
      linear: {
        system: "provider",
        ref: String(p.roadAddress.roadNumber),
        from: p.roadAddress.roadSection,
      },
      admin: { country: "FI", municipality: p.municipality },
    },
    provenance: prov,
    freshness: { fetchedAt: FETCHED },
    components: channels.map((v) => ({
      key: String(v.id),
      kind: "sensor_channel",
      details: {
        kind: "sensor_channel",
        v: 1,
        index: Number(v.name.slice(-1)),
        property: v.name.startsWith("KELI_")
          ? "road.surface_state"
          : DIGITRAFFIC_WEATHER[v.name]![0],
      },
    })),
    details: {
      kind: "weather_station",
      v: 1,
      equipment: [p.stationType],
      measuredProperties: [
        ...new Set([...values.map((v) => DIGITRAFFIC_WEATHER[v.name]![0]), "road.surface_state"]),
      ],
      surfaceSensorCount: 2,
    },
  };
  const channelKey = (v: { id: number; name: string }) =>
    channels.some((c) => c.id === v.id) ? String(v.id) : undefined;
  const observations = [
    ...values.map((v) => {
      const [property, unit] = DIGITRAFFIC_WEATHER[v.name]!;
      const key = channelKey(v);
      return observation(feature, {
        property,
        result: quantity(v.value, unit),
        at: { instant: v.measuredTime },
        ...(key === undefined ? {} : { componentKey: key }),
        aggregation:
          v.name === "KESKITUULI" ? "mean" : v.name === "MAKSIMITUULI" ? "max" : "instantaneous",
      });
    }),
    ...keli.map((v) =>
      observation(feature, {
        property: "road.surface_state",
        result:
          DIGITRAFFIC_KELI[v.value] === undefined
            ? { type: "unknown" }
            : category(DIGITRAFFIC_KELI[v.value]!, "surface_state"),
        at: { instant: v.measuredTime },
        componentKey: String(v.id),
      }),
    ),
    observation(feature, {
      property: "device.status",
      result: category(DIGITRAFFIC_STATE[p.state] ?? "unknown", "device_status"),
      at: { instant: data.sensorValues[0]!.measuredTime },
    }),
  ];
  return { feature, observations };
}

function digitrafficWeathercam() {
  const cam = json("digitraffic-weathercam-C01503.json");
  const data = json("digitraffic-weathercam-C01503-data.json") as {
    presets: { id: string; measuredTime: string }[];
  };
  const p = cam.properties;
  const [lon, lat] = cam.geometry.coordinates;
  const prov = provenance(
    "fi-digitraffic-weathercam",
    "digitraffic-weathercam",
    p.id,
    "Fintraffic / digitraffic.fi",
    "CC-BY-4.0",
  );
  const direction = (d: string) =>
    d === "INCREASING_DIRECTION"
      ? { value: "positive", basis: "road_reference" }
      : d === "DECREASING_DIRECTION"
        ? { value: "negative", basis: "road_reference" }
        : undefined;
  const feature = {
    id: `oc:feature:fi-digitraffic-weathercam:${p.id}`,
    class: "feature",
    kind: "camera",
    type: "weather",
    temporality: "static",
    lifecycle: "operational",
    name: (["fi", "sv", "en"] as const).map((lang) => ({ lang, text: p.names[lang] })),
    location: { ...point(lon, lat), roads: [{ ref: String(p.roadAddress.roadNumber) }] },
    provenance: prov,
    freshness: { fetchedAt: FETCHED },
    components: p.presets.map(
      (preset: { id: string; presentationName: string; direction: string }) => {
        const d = direction(preset.direction);
        return {
          key: preset.id,
          kind: "camera_view",
          name: [{ lang: "fi", text: preset.presentationName }],
          details: { kind: "camera_view", v: 1, ...(d ? { direction: d } : {}) },
        };
      },
    ),
    details: {
      kind: "camera",
      v: 1,
      refreshSec: p.collectionInterval,
      imageRedistribution: "allowed",
    },
  };
  const observations = data.presets.map((d) => {
    const preset = p.presets.find((x: { id: string }) => x.id === d.id);
    return observation(feature, {
      property: "camera.image",
      componentKey: d.id,
      result: structured("camera_image", {
        status: "online",
        imageUrl: preset.imageUrl,
        imageAt: d.measuredTime,
      }),
      at: { instant: d.measuredTime },
    });
  });
  return { feature, observations };
}

interface OntarioCamera {
  Id: number;
  Source: string;
  SourceId: string;
  Roadway: string;
  Latitude: number;
  Longitude: number;
  Location: string;
  Views: { Id: number; Url: string; Status: string; Description: string }[];
}

function ontarioCamera() {
  const [cam] = json("ontario511-cameras.json") as [OntarioCamera];
  const prov = provenance("ca-on-511-events", "ibi511", String(cam.Id), "Ontario 511", "unknown");
  const feature = {
    id: `oc:feature:ca-on-511-events:${cam.Id}`,
    class: "feature",
    kind: "camera",
    type: "traffic",
    temporality: "static",
    lifecycle: "operational",
    name: [{ lang: "en", text: cam.Location }],
    externalIds: [{ scheme: "provider", id: cam.SourceId, authority: cam.Source }],
    location: {
      ...point(cam.Longitude, cam.Latitude),
      roads: [{ name: [{ lang: "en", text: cam.Roadway }] }],
    },
    provenance: prov,
    freshness: { fetchedAt: FETCHED },
    components: cam.Views.map((v) => ({
      key: String(v.Id),
      kind: "camera_view",
      ...(v.Description ? { name: [{ lang: "en", text: v.Description }] } : {}),
      details: { kind: "camera_view", v: 1 },
    })),
    // No licence is published for the images: link to them, never republish.
    details: { kind: "camera", v: 1, provider: cam.Source, imageRedistribution: "unknown" },
  };
  // "Enabled" says the view is configured, not that it delivers current images; there is no image time.
  const observations = cam.Views.map((v) =>
    observation(feature, {
      property: "camera.image",
      componentKey: String(v.Id),
      result: structured("camera_image", { status: "unknown", imageUrl: v.Url }),
      at: { instant: FETCHED },
    }),
  );
  return { feature, observations };
}

/** Digitraffic sign types → sign type; INFORMATION signs show a pictogram with text rows. */
const DIGITRAFFIC_SIGN_TYPES: Record<string, string> = {
  SPEEDLIMIT: "pictogram",
  WARNING: "pictogram",
  INFORMATION: "hybrid",
};

function digitrafficSigns() {
  const signs = json("digitraffic-variable-signs.json").features as {
    geometry: { coordinates: [number, number] };
    properties: {
      id: string;
      type: string;
      roadAddress: string;
      direction: string;
      displayValue?: string;
      effectDate: string;
      reliability: string;
      textRows: { screen: number; rowNumber: number; text: string }[];
    };
  }[];
  return signs.map(({ geometry, properties: p }) => {
    const prov = provenance(
      "fi-digitraffic-signs",
      "digitraffic-variable-signs",
      p.id,
      "Fintraffic / digitraffic.fi",
      "CC-BY-4.0",
    );
    const [road] = p.roadAddress.split(" ");
    const feature = {
      id: `oc:feature:fi-digitraffic-signs:${p.id}`,
      class: "feature",
      kind: "vms",
      type: DIGITRAFFIC_SIGN_TYPES[p.type]!,
      temporality: "static",
      lifecycle: "operational",
      location: {
        ...point(...geometry.coordinates),
        roads: [{ ref: road }],
        direction: {
          value: p.direction === "INCREASING" ? "positive" : "negative",
          basis: "road_reference",
        },
      },
      provenance: prov,
      freshness: { fetchedAt: FETCHED },
      details: { kind: "vms", v: 1 },
    };
    const rows = p.textRows.filter((r) => r.text.length > 0);
    const message = {
      index: 0,
      ...(rows.length > 0
        ? {
            text: [{ page: 1, lines: rows.map((r) => [{ lang: "und", text: r.text }]) }],
          }
        : {}),
      ...(p.type === "SPEEDLIMIT" && p.displayValue
        ? { speedLimit: { value: Number(p.displayValue), unit: "km/h" } }
        : {}),
      ...(p.type !== "SPEEDLIMIT" && p.displayValue
        ? { pictograms: [{ area: 0, code: p.displayValue, codeSystem: "provider" }] }
        : {}),
    };
    const display = observation(feature, {
      property: "vms.display",
      result: structured("vms_display", {
        workingStatus: p.reliability === "NORMAL" ? "in_service" : "fault",
        messages: [message],
      }),
      at: { instant: p.effectDate },
    });
    return { feature, observations: [display] };
  });
}

function ndwRoutePanels() {
  const doc = xml("ndw-drip.xml");
  const [table, status] = list(doc.messageContainer.payload) as [
    { vmsControllerTable: { vmsController: unknown } },
    { vmsControllerStatus: unknown },
  ];
  const controllers = list(table.vmsControllerTable.vmsController) as {
    "@id": string;
    "@version": string;
    vms: { "@vmsIndex": string; vms: Record<string, unknown> };
  }[];
  const statuses = list(status.vmsControllerStatus) as {
    vmsControllerReference: { "@id": string };
    vmsStatus: { vmsStatus: Record<string, unknown> };
  }[];
  return controllers.map((c) => {
    const vms = c.vms.vms as {
      description: { values: { value: { "#text": string } } };
      vmsType: string;
      vmsLocation: {
        pointByCoordinates: {
          bearing: number;
          pointCoordinates: { latitude: number; longitude: number };
        };
      };
    };
    const at = vms.vmsLocation.pointByCoordinates;
    const classification = registry.crosswalk.feature("datex2_v3", `vmsType:${vms.vmsType}`)!;
    const prov = {
      ...provenance("nl-ndw-vms", "datex2", c["@id"], "NDW", "CC0-1.0"),
      recordVersion: c["@version"],
    };
    const feature = {
      id: `oc:feature:nl-ndw-vms:${c["@id"]}`,
      class: "feature",
      kind: classification.kind,
      type: classification.type,
      temporality: "static",
      lifecycle: "operational",
      name: [{ lang: "nl", text: vms.description.values.value["#text"] }],
      externalIds: [{ scheme: "datex:vms", id: c["@id"], authority: "NDW" }],
      location: {
        ...point(at.pointCoordinates.longitude, at.pointCoordinates.latitude),
        direction: { value: "unknown", basis: "bearing", bearingDeg: at.bearing },
      },
      provenance: prov,
      freshness: { fetchedAt: FETCHED },
      components: [
        {
          key: c.vms["@vmsIndex"],
          kind: "sign_face",
          details: { kind: "sign_face", v: 1, vmsIndex: Number(c.vms["@vmsIndex"]) },
        },
      ],
      details: { kind: "vms", v: 1, mounting: "roadside" },
    };
    const s = statuses.find((x) => x.vmsControllerReference["@id"] === c["@id"])!.vmsStatus
      .vmsStatus as {
      statusUpdateTime: string;
      workingStatus: string;
      vmsMessage?: { vmsMessage: Record<string, unknown> };
    };
    // A sign without a message shows nothing: no messages, not an unknown one.
    const messages = list(s.vmsMessage).map(({ vmsMessage }) => {
      const msg = vmsMessage as {
        image?: { imageFormat: string };
        displayAreaSettings?: { displayAreaSettings: { textLine: unknown } };
      };
      const lines = list(msg.displayAreaSettings?.displayAreaSettings.textLine).map(
        (l) => (l as { textLine: { textLine: string } }).textLine.textLine,
      );
      return {
        index: 0,
        ...(lines.length > 0
          ? { text: [{ page: 1, lines: lines.map((t) => [{ lang: "nl", text: t }]) }] }
          : {}),
        ...(msg.image ? { graphic: { mediaType: `image/${msg.image.imageFormat}` } } : {}),
      };
    });
    const display = observation(feature, {
      property: "vms.display",
      componentKey: c.vms["@vmsIndex"],
      result: structured("vms_display", {
        workingStatus:
          registry.crosswalk.value("vms_working_status", "datex2_v3", s.workingStatus) ?? "unknown",
        messages,
      }),
      at: { instant: s.statusUpdateTime },
    });
    return { feature, observations: [display] };
  });
}

function wzdxArrowBoards() {
  const feed = json("wzdx-wsdot-devices.json");
  return (
    feed.features as {
      id: string;
      geometry: { coordinates: [number, number] };
      properties: Record<string, never>;
    }[]
  ).map((f) => {
    const core = f.properties["core_details"] as {
      device_type: string;
      device_status: string;
      update_date: string;
      description: string;
    };
    const classification = registry.crosswalk.feature("wzdx", `device_type:${core.device_type}`)!;
    const prov = provenance("us-wa-wsdot-devices", "wzdx", f.id, "Washington State DOT", "unknown");
    const feature = {
      id: `oc:feature:us-wa-wsdot-devices:${f.id}`,
      class: "feature",
      kind: classification.kind,
      type: classification.type,
      temporality: "static",
      lifecycle: "operational",
      description: [{ lang: "en", text: core.description }],
      externalIds: [{ scheme: "wzdx:device", id: f.id }],
      location: point(...f.geometry.coordinates),
      provenance: prov,
      freshness: { fetchedAt: FETCHED },
      details: { kind: "vms", v: 1, mounting: "portable" },
    };
    const pattern = f.properties["pattern"] as string;
    const at = { instant: core.update_date };
    return {
      feature,
      observations: [
        observation(feature, {
          property: "vms.display",
          result: structured("vms_display", {
            workingStatus: "in_service",
            messages: [
              {
                index: 0,
                pictograms: [{ area: 0, code: pattern, codeSystem: "wzdx" }],
                flashing: pattern.endsWith("-flashing"),
              },
            ],
          }),
          at,
        }),
        observation(feature, {
          property: "device.status",
          result: category(
            registry.crosswalk.value("device_status", "wzdx", core.device_status)!,
            "device_status",
          ),
          at,
        }),
      ],
    };
  });
}

function digitrafficTrafficStation() {
  const station = json("digitraffic-tms-23001.json");
  const table = xml("digitraffic-tms-23001-site-table.xml").payload.measurementSiteTable
    .measurementSite as {
    "@id": string;
    "@version": string;
    measurementSiteName: { values: { value: { "@lang": string; "#text": string }[] } };
    measurementSpecificCharacteristics: {
      "@index": string;
      measurementSpecificCharacteristics: { period: number; specificMeasurementValueType: string };
    }[];
  };
  const measured = list(
    xml("digitraffic-tms-23001-measured-data.xml").payload.siteMeasurements.physicalQuantity,
  ) as {
    "@index": string;
    physicalQuantity: { basicData: Record<string, unknown> };
  }[];
  const p = station.properties;
  const [lon, lat] = station.geometry.coordinates;
  const prov = {
    ...provenance(
      "fi-digitraffic-tms",
      "datex2",
      table["@id"],
      "Fintraffic / digitraffic.fi",
      "CC-BY-4.0",
    ),
    recordVersion: table["@version"],
  };
  const VALUE_TYPE: Record<string, string> = {
    trafficFlow: "traffic.volume",
    trafficSpeed: "traffic.speed",
  };
  const channels = table.measurementSpecificCharacteristics.map((c) => ({
    index: Number(c["@index"]),
    property: VALUE_TYPE[c.measurementSpecificCharacteristics.specificMeasurementValueType]!,
    periodSec: c.measurementSpecificCharacteristics.period,
  }));
  // The site table's coordinates are in the national grid (ETRS-TM35FIN) under WGS84 element
  // names, so the position comes from the station's JSON metadata.
  const feature = {
    id: `oc:feature:fi-digitraffic-tms:${table["@id"]}`,
    class: "feature",
    kind: "measurement_site",
    type: "traffic",
    temporality: "static",
    lifecycle: "operational",
    name: table.measurementSiteName.values.value.map((v) => ({
      lang: v["@lang"],
      text: v["#text"],
    })),
    externalIds: [{ scheme: "datex:site", id: table["@id"], authority: "Fintraffic" }],
    location: { ...point(lon, lat), roads: [{ ref: String(p.roadAddress.roadNumber) }] },
    provenance: prov,
    freshness: { fetchedAt: FETCHED },
    components: channels.map((c) => ({
      key: String(c.index),
      kind: "sensor_channel",
      details: {
        kind: "sensor_channel",
        v: 1,
        index: c.index,
        vehicleClass: "any",
        property: c.property,
      },
    })),
    details: {
      kind: "measurement_site",
      v: 1,
      equipment: "loop",
      measuredProperties: [...new Set(channels.map((c) => c.property))],
      siteVersion: table["@version"],
    },
  };
  const observations = measured.map((m) => {
    const basic = m.physicalQuantity.basicData;
    const cls = basic["@type"] as string;
    const channel = channels.find((c) => c.index === Number(m["@index"]))!;
    const end = (basic["measurementOrCalculationTime"] as { timeValue: string }).timeValue;
    const start = new Date(Date.parse(end) - channel.periodSec * 1000).toISOString();
    const path =
      cls === "roa:TrafficFlow" ? "TrafficFlow/vehicleFlow" : "TrafficSpeed/averageVehicleSpeed";
    const property = registry.crosswalk.property("datex2_v3", path)!;
    const value =
      cls === "roa:TrafficFlow"
        ? (basic["vehicleFlow"] as { vehicleFlowRate: number }).vehicleFlowRate
        : (basic["averageVehicleSpeed"] as { speed: number }).speed;
    return observation(feature, {
      property,
      componentKey: String(channel.index),
      result: quantity(value, property === "traffic.speed" ? "km/h" : "1/h"),
      at: { start, end },
      aggregation: "mean",
    });
  });
  return { feature, observations };
}

function iowaSnowplows() {
  const avl = json("iowa-dot-avl.json").features as {
    attributes: Record<string, number | string | null>;
    geometry: { x: number; y: number };
  }[];
  return avl.map(({ attributes: a, geometry }) => {
    const label = String(a["LABEL"]);
    const prov = provenance("us-ia-dot-avl", "arcgis-avl", label, "Iowa DOT", "unknown");
    const feature = {
      id: `oc:feature:us-ia-dot-avl:${label}`,
      class: "feature",
      kind: "service_vehicle",
      type: "snowplow",
      temporality: "static",
      lifecycle: "operational",
      // A vehicle has no fixed place: its position is the observation, not the feature's location.
      location: {
        geometry: null,
        extent: "none",
        geometryOrigin: "none",
        fuzziness: "exact",
        admin: { country: "US", subdivision: "US-IA" },
      },
      provenance: prov,
      freshness: { fetchedAt: FETCHED },
      details: { kind: "service_vehicle", v: 1, fleetId: label, agency: "Iowa DOT" },
    };
    const position = point(geometry.x, geometry.y);
    const plow = a["FRONTPLOWSTATE"];
    const value = {
      point: position.geometry,
      ...(a["HEADING"] !== null ? { bearingDeg: Number(a["HEADING"]) % 360 } : {}),
      ...(a["VELOCITY"] !== null
        ? { speed: { value: Math.round(Number(a["VELOCITY"]) * 1.609344 * 10) / 10, unit: "km/h" } }
        : {}),
      // 9999 = the truck reports no plow sensor.
      ...(plow === 0 || plow === 1 ? { plowUp: plow === 0 } : {}),
      ...(a["ROUTE_NAME"] ? { routeName: String(a["ROUTE_NAME"]) } : {}),
    };
    return {
      feature,
      observations: [
        observation(feature, {
          property: "vehicle.position",
          location: position,
          result: structured("vehicle_position", value),
          at: { instant: new Date(Number(a["MODIFIEDDT"])).toISOString() },
        }),
      ],
    };
  });
}

describe("road infrastructure fit check", () => {
  it.each([
    ["a Digitraffic road-weather station", () => [digitrafficWeatherStation()]],
    ["a Digitraffic weather camera", () => [digitrafficWeathercam()]],
    ["an Ontario 511 camera", () => [ontarioCamera()]],
    ["Digitraffic variable signs", digitrafficSigns],
    ["NDW route-information panels (DATEX II 3)", ndwRoutePanels],
    ["WZDx arrow boards", wzdxArrowBoards],
    [
      "a Digitraffic traffic station (DATEX II 3.7 site table + measured data)",
      () => [digitrafficTrafficStation()],
    ],
    ["Iowa DOT snowplows", iowaSnowplows],
  ])("maps %s onto records that seal", (_label, map) => {
    const mapped = map();
    expect(mapped.length).toBeGreaterThan(0);
    const records = mapped.flatMap((m) => [m.feature, ...m.observations]);
    expect(sealAll(records)).toEqual([]);
  });

  it("keeps each numbered surface sensor its own series", () => {
    const { observations } = digitrafficWeatherStation();
    const surface = observations.filter((o) => o["property"] === "road.surface_temperature");
    expect(surface.map((o) => (o["subject"] as { componentKey: string }).componentKey)).toEqual([
      "3",
      "5",
    ]);
    expect(new Set(surface.map((o) => o["id"])).size).toBe(2);
  });

  it("rejects a sign display in an unregistered working status", () => {
    const [{ observations }] = ndwRoutePanels();
    const display = structuredClone(observations[0]!) as {
      result: { value: { workingStatus: string } };
    };
    display.result.value.workingStatus = "working";
    expect(sealAll([display as never])).toHaveLength(1);
  });
});
