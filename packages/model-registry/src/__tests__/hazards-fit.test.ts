import { readFileSync } from "node:fs";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type RegistryModule,
  sealRecord,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Hazards fit check: real published records of fire detections, fire
 * perimeters, burnt areas, smoke, floods and earthquakes, mapped onto
 * `natural_hazard` situations and `fire.*` observations and sealed against
 * the production registry. Captured 2026-10-01 from:
 * - NASA FIRMS active fire detections, VIIRS S-NPP and MODIS, Europe, last
 *   24 hours (public domain);
 * - NIFC WFIGS current interagency fire perimeters, the fields the mapper
 *   reads (public domain);
 * - EFFIS burnt areas of the last week (Copernicus Emergency Management
 *   Service, © European Union, CC BY 4.0);
 * - NOAA/NESDIS Hazard Mapping System smoke polygons (public domain);
 * - Environment Agency flood warnings and a flood area's polygon (Open
 *   Government Licence v3.0);
 * - USGS earthquakes of magnitude 4.5 and above of the past week (public
 *   domain).
 * OpenConditions parses none of these formats yet, so a test-only module
 * registers them; the mappers are the specification of their parsers.
 */
const fitFormats: RegistryModule = {
  name: "hazards-fit",
  entries: [
    extendVocabulary({
      vocabulary: "source_format",
      values: ["firms-csv", "arcgis", "effis-wfs", "ea-flood-monitoring", "usgs-geojson"],
    }),
  ],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const FETCHED = "2026-10-01T00:30:00Z";

const utf8 = (name: string) =>
  readFileSync(new URL(`./fixtures/hazards/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(utf8(name));

type Draft = Record<string, unknown>;

function provenance(
  sourceId: string,
  sourceFormat: string,
  recordId: string,
  provider: string,
  license: string,
  sourceUpdatedAt?: string,
) {
  return {
    origin: "feed",
    sourceId,
    sourceFormat,
    accessMode: "bulk",
    recordId,
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    attribution: { provider, license },
    privacy: { class: "authoritative" },
  };
}

const en = (text: string) => [{ lang: "en", text }];
const epoch = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? undefined : new Date(ms).toISOString();

interface Hazard {
  prov: ReturnType<typeof provenance>;
  localId: string;
  type: string;
  subtype?: string;
  location: object;
  validity: object;
  details: object;
  planned?: boolean;
  certainty?: string;
  severity?: object;
  headline?: object;
  externalIds?: object[];
}

function hazard(h: Hazard): Draft {
  return {
    id: `oc:situation:${h.prov.sourceId}:${h.localId}`,
    class: "situation",
    kind: "natural_hazard",
    type: h.type,
    ...(h.subtype === undefined ? {} : { subtype: h.subtype }),
    temporality: "live",
    ...(h.externalIds === undefined ? {} : { externalIds: h.externalIds }),
    location: h.location,
    provenance: h.prov,
    freshness: { fetchedAt: FETCHED },
    planned: h.planned ?? false,
    certainty: h.certainty ?? "observed",
    severity: h.severity ?? { label: "unknown" },
    ...(h.headline === undefined ? {} : { headline: h.headline }),
    validity: h.validity,
    effects: [],
    details: { kind: "natural_hazard", v: 1, ...h.details },
  };
}

const area = (geometry: object | null, admin?: object, areaDescription?: object) => ({
  geometry,
  extent: "area",
  geometryOrigin: geometry === null ? "none" : "source",
  fuzziness: "exact",
  ...(admin === undefined ? {} : { admin }),
  ...(areaDescription === undefined ? {} : { areaDescription }),
});

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

/**
 * FIRMS: one row per fire pixel, located at the pixel centre (VIIRS 375 m,
 * MODIS 1 km). VIIRS grades its confidence in words, MODIS as a percentage;
 * the satellite, day or night pass and pixel size are allow-listed extras.
 */
function firms(name: string, sourceId: string, instrument: "VIIRS" | "MODIS"): Draft[] {
  const [header, ...rows] = utf8(name).trim().split(/\r?\n/);
  const columns = header!.split(",");
  return rows.flatMap((line) => {
    const row = Object.fromEntries(line.split(",").map((v, i) => [columns[i]!, v]));
    const at = `${row["acq_date"]}T${row["acq_time"]!.slice(0, 2)}:${row["acq_time"]!.slice(2)}:00Z`;
    const location = {
      geometry: { type: "Point", coordinates: [Number(row["longitude"]), Number(row["latitude"])] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: instrument === "VIIRS" ? "medium_res" : "low_res",
    };
    const prov = provenance(
      sourceId,
      "firms-csv",
      `${row["latitude"]},${row["longitude"]},${at}`,
      "NASA FIRMS",
      "public-domain",
    );
    const quality =
      instrument === "VIIRS"
        ? { supplierCode: row["confidence"]! }
        : { confidence: Number(row["confidence"]) / 100 };
    const brightness = instrument === "VIIRS" ? row["bright_ti4"] : row["brightness"];
    return [
      ["fire.frp", { type: "quantity", value: Number(row["frp"]), unit: "MW" }],
      ["fire.brightness", { type: "quantity", value: Number(brightness), unit: "K" }],
    ].map(([property, result]) => {
      const draft = {
        class: "observation",
        kind: "observation",
        property,
        temporality: "live",
        location,
        provenance: prov,
        freshness: { fetchedAt: FETCHED },
        subject: { kind: "location" },
        result,
        phenomenonTime: { instant: at },
        aggregation: "instantaneous",
        quality,
        extras: {
          satellite: row["satellite"],
          daynight: row["daynight"],
          scan: Number(row["scan"]),
          track: Number(row["track"]),
        },
      };
      return { id: observationId(sourceId, draft as never), ...draft };
    });
  });
}

const ACRE_HA = 0.40468564224;
const round2 = (v: number) => Math.round(v * 100) / 100;
const CAUSES: Record<string, string> = {
  Natural: "natural",
  Human: "human",
  Undetermined: "undetermined",
};

/**
 * NIFC perimeters: a wildfire's latest perimeter, or a prescribed burn's
 * (planned). Acres become hectares; the incident's IRWIN id is shared with
 * every other system that reports the fire.
 */
function nifc(): Draft[] {
  return json("nifc-perimeters.geojson").features.map(
    (f: { geometry: object; properties: Record<string, never> }) => {
      const p = f.properties;
      const prescribed = p["attr_IncidentTypeCategory"] === "RX";
      const irwin = (p["attr_IrwinID"] as string).replace(/[{}]/g, "");
      const cause = CAUSES[p["attr_FireCause"] as string];
      const out = epoch(p["attr_FireOutDateTime"]);
      return hazard({
        prov: provenance(
          "us-nifc",
          "arcgis",
          String(p["OBJECTID"]),
          "National Interagency Fire Center",
          "public-domain",
          epoch(p["attr_ModifiedOnDateTime_dt"]),
        ),
        localId: irwin,
        type: "wildfire",
        subtype: prescribed ? "prescribed_burn" : "wildfire_perimeter",
        planned: prescribed,
        externalIds: [{ scheme: "irwin", id: irwin }],
        location: area(f.geometry, { country: "US", subdivision: p["attr_POOState"] }),
        validity: {
          status: out === undefined ? "active" : "ended",
          start: epoch(p["attr_FireDiscoveryDateTime"]),
          ...(out === undefined ? {} : { end: out }),
        },
        details: {
          name: en(p["poly_IncidentName"]),
          areaHa: round2((p["poly_GISAcres"] as number) * ACRE_HA),
          ...(p["attr_PercentContained"] === null
            ? {}
            : { containmentPct: p["attr_PercentContained"] }),
          discoveredAt: epoch(p["attr_FireDiscoveryDateTime"]),
          ...(cause === undefined ? {} : { ignitionCause: cause }),
        },
      });
    },
  );
}

/** EFFIS times are UTC without a zone; the land-cover shares have no model field. */
const effisTime = (s: string) => `${s.replace(" ", "T")}Z`;

function effis(): Draft[] {
  return json("effis-burnt-areas.geojson").features.map(
    (f: { geometry: object; properties: Record<string, string> }) => {
      const p = f.properties;
      return hazard({
        prov: provenance(
          "eu-effis",
          "effis-wfs",
          p["id"]!,
          "EFFIS / Copernicus Emergency Management Service",
          "CC-BY-4.0",
          effisTime(p["LASTUPDATE"]!),
        ),
        localId: p["id"]!,
        type: "wildfire",
        subtype: "burned_area",
        location: area(f.geometry, { country: p["COUNTRY"], municipality: p["COMMUNE"] }),
        validity: { status: "unknown", start: effisTime(p["FIREDATE"]!) },
        details: {
          areaHa: Number(p["AREA_HA"]),
          discoveredAt: effisTime(p["FIREDATE"]!),
        },
      });
    },
  );
}

/** HMS times are `YYYYDDD HHMM` in UTC, the day counted in the year. */
function hmsTime(s: string): string {
  const [date, time] = s.split(" ") as [string, string];
  const day = new Date(Date.UTC(Number(date.slice(0, 4)), 0, Number(date.slice(4))));
  return `${day.toISOString().slice(0, 10)}T${time.slice(0, 2)}:${time.slice(2)}:00Z`;
}

function hms(): Draft[] {
  return json("hms-smoke.geojson").features.map(
    (f: { geometry: object; properties: Record<string, string | number> }) => {
      const p = f.properties;
      const day = String(p["Start"]).split(" ")[0];
      return hazard({
        prov: provenance(
          "us-noaa-hms",
          "arcgis",
          `${day}-${p["FID"]}`,
          "NOAA/NESDIS Hazard Mapping System",
          "public-domain",
        ),
        localId: `${day}-${p["FID"]}`,
        type: "smoke",
        location: area(f.geometry),
        validity: {
          status: "unknown",
          start: hmsTime(String(p["Start"])),
          end: hmsTime(String(p["End_"])),
        },
        details: {
          density: String(p["Density"]).toLowerCase(),
          detection: { satellite: String(p["Satellite"]) },
        },
      });
    },
  );
}

/**
 * The Environment Agency's warning levels: flooding is possible (alert),
 * expected (warning), or a danger to life (severe warning). Its times carry
 * no zone and are UK local time.
 */
const EA_LEVELS: Record<number, { certainty: string; label: string }> = {
  1: { certainty: "likely", label: "critical" },
  2: { certainty: "likely", label: "major" },
  3: { certainty: "possible", label: "moderate" },
};
const london = (s: string) => {
  const probe = new Date(`${s}Z`);
  const offset = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")!
    .value.replace("GMT", "");
  const [h = "0", m = "0"] = offset === "" ? [] : offset.slice(1).split(":");
  const sign = offset.startsWith("-") ? "-" : "+";
  return `${s}${sign}${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
};

function ea(): Draft[] {
  const polygon = json("ea-flood-area-111WATCHXH.geojson").features[0].geometry;
  return json("ea-floods.json").items.map((w: Record<string, never>) => {
    const level = EA_LEVELS[w["severityLevel"] as number];
    const areaId = w["floodAreaID"] as string;
    const floodArea = w["floodArea"] as Record<string, string>;
    const changed = london(w["timeSeverityChanged"]);
    return hazard({
      prov: provenance(
        "gb-ea-floods",
        "ea-flood-monitoring",
        areaId,
        "Environment Agency",
        "OGL-UK-3.0",
        london(w["timeMessageChanged"]),
      ),
      localId: areaId,
      type: "flood",
      subtype: w["isTidal"] ? "coastal" : "river",
      certainty: level?.certainty ?? "unknown",
      severity:
        level === undefined
          ? { label: "unknown", declaredRaw: w["severity"] }
          : { label: level.label, source: "declared", declaredRaw: w["severity"] },
      location: area(
        areaId === "111WATCHXH" ? polygon : null,
        { country: "GB", municipality: floodArea["county"] },
        en(w["description"]),
      ),
      validity:
        level === undefined
          ? { status: "ended", end: changed, endedReason: "source_ended" }
          : { status: "active", start: changed },
      details: { waterBody: floodArea["riverOrSea"] },
    });
  });
}

/**
 * USGS: the third coordinate is the hypocentre's depth in kilometres, not
 * an altitude, so it leaves the geometry. PAGER's alert colour is the
 * declared severity; most events have none.
 */
const PAGER: Record<string, string> = {
  green: "minor",
  yellow: "moderate",
  orange: "major",
  red: "critical",
};

function usgs(): Draft[] {
  return json("usgs-earthquakes.geojson").features.map(
    (f: {
      id: string;
      geometry: { coordinates: [number, number, number] };
      properties: Record<string, never>;
    }) => {
      const p = f.properties;
      const [lon, lat, depthKm] = f.geometry.coordinates;
      const at = epoch(p["time"])!;
      const pager = p["alert"] as string | null;
      return hazard({
        prov: provenance(
          "us-usgs-earthquakes",
          "usgs-geojson",
          f.id,
          "U.S. Geological Survey",
          "public-domain",
          epoch(p["updated"]),
        ),
        localId: f.id,
        type: "earthquake",
        externalIds: [{ scheme: "usgs:event", id: f.id }],
        location: {
          geometry: { type: "Point", coordinates: [lon, lat] },
          extent: "point",
          geometryOrigin: "source",
          fuzziness: "exact",
        },
        severity:
          pager === null
            ? { label: "unknown" }
            : { label: PAGER[pager], source: "declared", declaredRaw: pager },
        headline: en(p["title"]),
        validity: { status: "ended", start: at, end: at },
        details: {
          magnitude: { value: p["mag"], scale: p["magType"] },
          depth: { value: Math.round(depthKm * 1000), unit: "m" },
        },
      });
    },
  );
}

describe("hazards fit check", () => {
  it("observes every FIRMS fire pixel's power and brightness where it burns", () => {
    const records = [
      ...firms("firms-viirs-snpp.csv", "global-firms-viirs-snpp", "VIIRS"),
      ...firms("firms-modis.csv", "global-firms-modis", "MODIS"),
    ];
    expect(sealAll(records)).toEqual([]);
    expect(records).toHaveLength(14);
    const [frp] = records as [Draft];
    expect(frp["result"]).toEqual({ type: "quantity", value: 15.36, unit: "MW" });
    expect(frp["phenomenonTime"]).toEqual({ instant: "2026-09-29T10:56:00Z" });
    expect(frp["quality"]).toEqual({ supplierCode: "high" });
    expect(records[8]!["quality"]).toEqual({ confidence: 0.83 });
  });

  it("maps NIFC perimeters, a prescribed burn as planned", () => {
    const records = nifc();
    expect(sealAll(records)).toEqual([]);
    const [aspen, tartar, burn] = records as [Draft, Draft, Draft];
    expect(aspen["details"]).toMatchObject({
      name: en("Aspen Acres"),
      areaHa: 41279.34,
      containmentPct: 82,
      ignitionCause: "human",
    });
    expect((tartar["details"] as { containmentPct: number }).containmentPct).toBe(100);
    expect(burn["subtype"]).toBe("prescribed_burn");
    expect(burn["planned"]).toBe(true);
    expect(burn["details"]).not.toHaveProperty("ignitionCause");
  });

  it("maps EFFIS burnt areas and HMS smoke by density", () => {
    const records = [...effis(), ...hms()];
    expect(sealAll(records)).toEqual([]);
    expect(records.map((r) => (r["details"] as { density?: string }).density)).toEqual([
      undefined,
      undefined,
      "light",
      "medium",
      "heavy",
    ]);
    expect(records[2]!["validity"]).toEqual({
      status: "unknown",
      start: "2026-09-30T12:00:00Z",
      end: "2026-09-30T15:00:00Z",
    });
  });

  it("maps Environment Agency flood warnings that are no longer in force as ended", () => {
    const records = ea();
    expect(sealAll(records)).toEqual([]);
    const [christchurch] = records as [Draft];
    expect(christchurch["subtype"]).toBe("coastal");
    expect(christchurch["severity"]).toEqual({
      label: "unknown",
      declaredRaw: "Warning no longer in force",
    });
    expect(christchurch["validity"]).toEqual({
      status: "ended",
      end: "2026-09-30T09:19:00+01:00",
      endedReason: "source_ended",
    });
    expect(christchurch["details"]).toEqual({
      kind: "natural_hazard",
      v: 1,
      waterBody: "English Channel",
    });
  });

  it("maps USGS earthquakes with their magnitude and depth", () => {
    const records = usgs();
    expect(sealAll(records)).toEqual([]);
    const [costaRica, japan] = records as [Draft, Draft];
    expect(costaRica["details"]).toMatchObject({
      magnitude: { value: 5.6, scale: "mww" },
      depth: { value: 8000, unit: "m" },
    });
    expect(costaRica["severity"]).toEqual({
      label: "minor",
      source: "declared",
      declaredRaw: "green",
    });
    expect(
      (costaRica["location"] as { geometry: { coordinates: number[] } }).geometry.coordinates,
    ).toEqual([-86.5063, 9.7526]);
    expect(japan["severity"]).toEqual({ label: "unknown" });
  });
});
