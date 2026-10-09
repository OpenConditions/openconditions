import { readFileSync } from "node:fs";
import { type HazardsCatalogFeed, hazardsDomain } from "@openconditions/hazards";
import {
  buildRegistry,
  extendVocabulary,
  type RegistryModule,
  sealRecord,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Hazards fit check: real published records of fire detections, fire
 * perimeters, burnt areas, smoke, floods and earthquakes, mapped onto
 * `natural_hazard` situations and `fire.frp` observations and sealed against
 * the production registry. Captured 2026-10-01 from:
 * - NASA FIRMS active fire detections, VIIRS S-NPP and MODIS, Europe, last
 *   24 hours (public domain);
 * - NIFC WFIGS current interagency fire perimeters, the fields the parser
 *   reads (public domain);
 * - EFFIS burnt areas of the last week (Copernicus Emergency Management
 *   Service, © European Union, CC BY 4.0);
 * - NOAA/NESDIS Hazard Mapping System smoke polygons (public domain);
 * - Environment Agency flood warnings and a flood area's polygon (Open
 *   Government Licence v3.0);
 * - USGS earthquakes of magnitude 4.5 and above of the past week (public
 *   domain).
 * Every source but the Environment Agency is read by the hazards domain's
 * own parser; the Environment Agency's format is registered by a test-only
 * module and mapped below.
 */
const fitFormats: RegistryModule = {
  name: "hazards-fit",
  entries: [extendVocabulary({ vocabulary: "source_format", values: ["ea-flood-monitoring"] })],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const FETCHED = "2026-10-01T00:30:00Z";

const utf8 = (name: string) =>
  readFileSync(new URL(`./fixtures/hazards/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(utf8(name));
const bytes = (name: string) => Buffer.from(utf8(name));

type Draft = Record<string, unknown>;

/**
 * A feed as its region file writes it: the fields its records take from the
 * feed (the loader's derived fields play no part in a parse).
 */
const feedOf = (id: string, format: string, license: string, attribution: string) =>
  ({ id, format, license, attribution }) as HazardsCatalogFeed;

/** One poll of `feed` over the given payloads by role, read by its format's parser. */
function parse(feed: HazardsCatalogFeed, payloads: Record<string, string[]>) {
  return hazardsDomain.formats[feed.format]!.parse(
    feed,
    Object.fromEntries(Object.entries(payloads).map(([role, files]) => [role, files.map(bytes)])),
    { fetchedAt: FETCHED, cadenceSec: 600, reference: {} },
  );
}

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

const FIRMS_LICENSE = "CC0-1.0";
const VIIRS = feedOf(
  "nasa-firms-viirs-fires",
  "firms",
  FIRMS_LICENSE,
  "NASA FIRMS (LANCE / ESDIS)",
);
const MODIS = feedOf(
  "nasa-firms-modis-fires",
  "firms",
  FIRMS_LICENSE,
  "NASA FIRMS (LANCE / ESDIS)",
);
const NIFC = feedOf(
  "us-nifc-fires",
  "wfigs",
  "LicenseRef-US-Gov-Public-Domain",
  "National Interagency Fire Center (NIFC) / WFIGS and contributing agencies — dynamic data, not legal documents.",
);
const EFFIS = feedOf(
  "eu-effis-fires",
  "effis",
  "CC-BY-4.0",
  "© European Union, 1995-2025, EFFIS (Copernicus Emergency Management Service), modified",
);
const HMS = feedOf(
  "us-noaa-hms-smoke",
  "hms",
  "CC0-1.0",
  "NOAA/NESDIS Hazard Mapping System (HMS)",
);
const USGS = feedOf(
  "usgs-quakes",
  "usgs",
  "LicenseRef-US-Gov-Public-Domain",
  "U.S. Geological Survey",
);

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

const byName = (records: readonly Draft[], name: string) =>
  records.find(
    (r) => (r["details"] as { name?: { text: string }[] }).name?.[0]?.text === name,
  ) as Draft;

describe("hazards fit check", () => {
  it("observes every FIRMS fire pixel's power where it burns", () => {
    const viirs = parse(VIIRS, { main: ["firms-viirs-snpp.csv"] });
    const modis = parse(MODIS, { main: ["firms-modis.csv"] });
    const records = [...viirs.observations, ...modis.observations];
    expect(sealAll(records)).toEqual([]);
    expect(records).toHaveLength(7);
    expect(new Set(records.map((r) => r["property"]))).toEqual(new Set(["fire.frp"]));
    const [frp] = records as [Draft];
    expect(frp["result"]).toEqual({ type: "quantity", value: 15.36, unit: "MW" });
    expect(frp["phenomenonTime"]).toEqual({ instant: "2026-09-29T10:56:00Z" });
    expect(frp["quality"]).toEqual({ supplierCode: "high" });
    // The pixel's brightness, the pass and the pixel size travel as extras.
    expect(frp["extras"]).toEqual({
      instrument: "viirs",
      satellite: "N",
      brightnessK: 367,
      backgroundK: 298.89,
      daynight: "day",
      scan: 0.6,
      track: 0.7,
      version: "2.0NRT",
    });
    expect(records[4]!["quality"]).toEqual({ confidence: 0.83 });
    expect(records[4]!["extras"]).toMatchObject({ instrument: "modis", brightnessK: 313.83 });
  });

  it("maps NIFC perimeters, a prescribed burn as planned", () => {
    const records = parse(NIFC, { perimeters: ["nifc-perimeters.geojson"] }).situations;
    expect(sealAll(records)).toEqual([]);
    const aspen = byName(records, "Aspen Acres");
    const tartar = byName(records, "Tartar");
    const burn = byName(records, "Ranger Academy RX Burn 5");
    // A fire is the incident its IRWIN id names, which every system reporting it shares.
    expect(aspen["id"]).toBe("oc:situation:us-nifc-fires:1CDF5E5A-F22E-4352-A582-C2A47663B93D");
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
    const records = [
      ...parse(EFFIS, { main: ["effis-burnt-areas.geojson"] }).situations,
      ...parse(HMS, { main: ["hms-smoke.geojson"] }).situations,
    ];
    expect(sealAll(records)).toEqual([]);
    expect(records.map((r) => (r["details"] as { density?: string }).density)).toEqual([
      undefined,
      undefined,
      "light",
      "medium",
      "heavy",
    ]);
    // Smoke stays current while the day's analysis lists it; the image
    // sequence it was seen in is a detail.
    expect(records[2]!["validity"]).toEqual({ status: "active", start: "2026-09-30T12:00:00Z" });
    expect((records[2]!["details"] as { detection: object }).detection).toMatchObject({
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
    const records = parse(USGS, {
      recent: [],
      window: ["usgs-earthquakes.geojson"],
    }).situations;
    expect(sealAll(records)).toEqual([]);
    const costaRica = records.find((r) => r["id"] === "oc:situation:usgs-quakes:us6000tymj")!;
    const japan = records.find((r) => r["id"] === "oc:situation:usgs-quakes:us6000tym9")!;
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
