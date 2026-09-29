import { readFileSync } from "node:fs";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type RegistryModule,
  sealRecord,
} from "@openconditions/model";
import { type StructureInput, structureRestrictions } from "@openconditions/model-roads";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Road network fit check: real published records of structures, level
 * crossings, blackspots, tolls, mountain passes, chain controls and
 * travel-time routes, mapped onto Feature, Observation and Offer and sealed
 * against the production registry, together with the standing restrictions
 * a structure derives. Captured 2026-09-29 from:
 * - FHWA National Bridge Inventory 2025, District of Columbia and Delaware
 *   (public domain);
 * - FRA Highway-Rail Crossing Inventory, Delaware, the fields the mapper
 *   reads (data.transportation.gov `m2f8-22s6`, public domain);
 * - the Norwegian road database NVDB (height restrictions, tunnel bores,
 *   level crossings, toll stations, mountain passes; NLOD 2.0);
 * - Transport Infrastructure Ireland collision rates 2014–2016 (CC BY 4.0),
 *   converted from the published shapefile to WGS84 GeoJSON with every
 *   attribute verbatim;
 * - APRR motorway tariffs 2026-02 as republished on data.gouv.fr (Licence
 *   Ouverte 2.0), station names as extracted, including the mangled ones;
 * - WSDOT toll rates (Traveler Information API) and mountain pass reports
 *   (the wsdot.com service the pass pages read);
 * - Caltrans CWWP2 chain controls and District 12 travel times;
 * - the Norwegian road administration's DATEX II 3.1 sample travel-time
 *   publication (NLOD 2.0).
 * OpenConditions parses none of these formats yet, so a test-only module
 * registers them.
 */
const fitFormats: RegistryModule = {
  name: "network-fit",
  entries: [
    extendVocabulary({
      vocabulary: "source_format",
      values: [
        "nbi",
        "fra-crossing-inventory",
        "nvdb",
        "esri-shapefile",
        "aprr-tariffs",
        "wsdot-traveler",
        "wsdot-web",
        "cwwp2",
      ],
    }),
  ],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const crosswalk = registry.crosswalk;
const FETCHED = "2026-09-29T21:10:00Z";

const text = (name: string) =>
  readFileSync(new URL(`./fixtures/network/${name}`, import.meta.url), "latin1");
const utf8 = (name: string) =>
  readFileSync(new URL(`./fixtures/network/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(utf8(name));
const xml = (name: string) =>
  new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true }).parse(
    utf8(name),
  );

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

const at = (geometry: object | null, extent = "point") => ({
  geometry,
  extent,
  geometryOrigin: geometry === null ? "none" : "source",
  fuzziness: "exact",
});
const point = (lon: number, lat: number) => at({ type: "Point", coordinates: [lon, lat] });
const en = (value: string) => [{ lang: "en", text: value }];
const nb = (value: string) => [{ lang: "nb", text: value }];
const m = (value: number) => ({ value, unit: "m" });

interface Feature {
  id: string;
  location: unknown;
  provenance: ReturnType<typeof provenance>;
}

function feature(
  prov: ReturnType<typeof provenance> & { recordVersion?: string },
  kind: string,
  location: unknown,
  rest: Record<string, unknown>,
): Draft & Feature {
  return {
    id: `oc:feature:${prov.sourceId}:${prov.recordId}`,
    class: "feature",
    kind,
    temporality: "static",
    location,
    provenance: prov,
    freshness: { fetchedAt: FETCHED },
    lifecycle: "operational",
    ...rest,
  } as Draft & Feature;
}

function observation(
  subject: Feature,
  o: {
    property: string;
    result: unknown;
    at: { instant: string } | { start: string; end: string };
    qualifiers?: Record<string, unknown>;
    aggregation?: string;
    quality?: object;
    baseline?: object;
  },
): Draft {
  const draft = {
    class: "observation",
    kind: "observation",
    property: o.property,
    temporality: "live",
    location: subject.location,
    provenance: subject.provenance,
    freshness: { fetchedAt: FETCHED },
    subject: { kind: "feature", featureId: subject.id },
    ...(o.qualifiers === undefined ? {} : { qualifiers: o.qualifiers }),
    result: o.result,
    phenomenonTime: o.at,
    aggregation: o.aggregation ?? "instantaneous",
    ...(o.quality === undefined ? {} : { quality: o.quality }),
    ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
  };
  return { id: observationId(subject.provenance.sourceId, draft as never), ...draft };
}

const category = (value: string, vocabulary: string) => ({ type: "category", value, vocabulary });

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

/** An instant for a local wall-clock time in an IANA zone, with its offset. */
function zoned(date: string, time: string, zone: string): string {
  const guess = Date.parse(`${date}T${time}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const shown = Date.parse(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
  );
  const offsetMin = (shown - guess) / 60000;
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${date}T${time}${sign}${hh}:${mm}`;
}

/** WCF `/Date(ms±hhmm)/` → an instant with that offset; undefined for .NET's minimum date. */
function wcfDate(value: string): string | undefined {
  const [, ms, sign, hh, mm] = /\/Date\((-?\d+)([+-])(\d{2})(\d{2})\)\//.exec(value)!;
  if (Number(ms) < 0) return undefined;
  const offsetMin = (sign === "-" ? -1 : 1) * (Number(hh) * 60 + Number(mm));
  const local = new Date(Number(ms) + offsetMin * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

/** Inverse transverse Mercator for UTM zone 33 north (WGS84), metres → [lon, lat]. */
function utm33(easting: number, northing: number): [number, number] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const x = easting - 500000;
  const mu = northing / k0 / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const t1 = Math.tan(phi1) ** 2;
  const c1 = ep2 * Math.cos(phi1) ** 2;
  const r1 = (a * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const d = x / (n1 * k0);
  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) /
    Math.cos(phi1);
  const round = (v: number) => Math.round(v * 1e7) / 1e7;
  return [round(15 + (lon * 180) / Math.PI), round((lat * 180) / Math.PI)];
}

interface NvdbObject {
  id: number;
  metadata: { versjon: number; sist_modifisert?: string };
  egenskaper: { navn: string; verdi?: unknown; enum_id?: number }[];
  geometri: { wkt: string };
  relasjoner?: { barn?: { type: { id: number }; vegobjekter: number[] }[] };
  lokasjon: { vegsystemreferanser?: { kortform: string }[] };
}
const nvdb = (name: string) => json(name).objekter as NvdbObject[];
const prop = <T = string>(o: NvdbObject, name: string) =>
  o.egenskaper.find((e) => e.navn === name)?.verdi as T | undefined;

/**
 * NVDB's WKT lists latitude before longitude, and a Z of -999999 means the
 * height is unknown; both are corrected here, so a geometry leaves in
 * RFC 7946 order.
 */
function nvdbGeometry(wkt: string): { type: string; coordinates: unknown } {
  const pairs = (s: string) =>
    s.split(",").map((p) => {
      const [lat, lon] = p.trim().split(/\s+/).map(Number);
      return [lon!, lat!];
    });
  const body = wkt.slice(wkt.indexOf("(")).replace(/^\(+|\)+$/g, "");
  if (wkt.startsWith("POINT")) return { type: "Point", coordinates: pairs(body)[0] };
  if (wkt.startsWith("LINESTRING")) return { type: "LineString", coordinates: pairs(body) };
  return { type: "Polygon", coordinates: [pairs(body)] };
}
const nvdbLocation = (o: NvdbObject) => {
  const geometry = nvdbGeometry(o.geometri.wkt);
  const ref = o.lokasjon.vegsystemreferanser?.[0]?.kortform;
  return {
    ...at(
      geometry,
      geometry.type === "Point" ? "point" : geometry.type === "LineString" ? "linear" : "area",
    ),
    admin: { country: "NO" },
    ...(ref === undefined ? {} : { roads: [{ ref: ref.split(" ")[0] }] }),
  };
};
const nvdbProvenance = (o: NvdbObject) => ({
  ...provenance("no-nvdb", "nvdb", String(o.id), "Statens vegvesen", "NLOD-2.0"),
  recordVersion: String(o.metadata.versjon),
});

/** NVDB `Type hinder` → the structure the height restriction belongs to; the rest are not structures. */
const NVDB_HEIGHT_OBSTACLES: Record<string, string | null> = {
  Tunnel: "tunnel",
  "Undergang/Bru": "underpass",
  "Skiltportal/wire": "gantry",
  "Bru-stag": "bridge",
  Skredoverbygg: "tunnel",
  Kjøreledning: null,
  Kabel: null,
  "Annet hinder": null,
  Brukabler: null,
  Ferjesamband: null,
  Bygning: null,
};

/**
 * A height restriction in NVDB is measured on the road it sits on, so every
 * clearance is for the carried road: the three measured minima across the
 * opening, the calculated height (measured minus margin) and, where signage
 * is required, the signed height.
 */
function nvdbStructures() {
  const out: (Draft & Feature)[] = [];
  for (const o of nvdb("nvdb-height-restrictions.json")) {
    const type = NVDB_HEIGHT_OBSTACLES[prop(o, "Type hinder")!];
    if (!type) continue;
    const clearance = (name: string, basis: string, position?: string) => {
      const v = prop<number>(o, name);
      return v === undefined
        ? []
        : [{ road: "carried", height: m(v), basis, ...(position ? { position } : {}) }];
    };
    const width = prop<number>(o, "Bredde");
    out.push(
      feature(nvdbProvenance(o), "structure", nvdbLocation(o), {
        type,
        name: nb(prop(o, "Navn")!.trim()),
        details: {
          kind: "structure",
          v: 1,
          ...(width === undefined ? {} : { width: m(width) }),
          clearances: [
            ...clearance("H-min, venstre kant", "measured", "left"),
            ...clearance("H-min, midt", "measured", "centre"),
            ...clearance("H-min, høyre kant", "measured", "right"),
            ...clearance("Beregnet høyde", "calculated"),
            ...clearance("Skilta høyde", "signed"),
          ],
        },
      }),
    );
  }
  for (const o of nvdb("nvdb-tunnel-bores.json")) {
    out.push(
      feature(nvdbProvenance(o), "structure", nvdbLocation(o), {
        type: "tunnel",
        name: nb(prop(o, "Navn")!),
        details: {
          kind: "structure",
          v: 1,
          length: m(prop<number>(o, "Lengde")!),
          width: m(prop<number>(o, "Bredde")!),
          yearBuilt: prop<number>(o, "Åpningsår"),
          clearances: [{ road: "carried", height: m(prop<number>(o, "Høyde")!), basis: "design" }],
        },
      }),
    );
  }
  return out;
}

/** NBI item 16/17: DDMMSSss and DDDMMSSss, west longitude unsigned. */
const nbiDegrees = (v: string, west: boolean) => {
  const s = v.padStart(west ? 9 : 8, "0");
  const deg = Number(s.slice(0, west ? 3 : 2));
  const min = Number(s.slice(west ? 3 : 2, west ? 5 : 4));
  const sec = Number(s.slice(west ? 5 : 4)) / 100;
  const value = Math.round((deg + min / 60 + sec / 3600) * 1e6) / 1e6;
  return west ? -value : value;
};
const unquote = (v: string) => v.replace(/^'|'$/g, "").trim().replace(/\s+/g, " ");

/**
 * NBI rows: item 43B 19 is a culvert, everything else a bridge. Clearance
 * 99.99 means none (30 m or more); an under-clearance counts for a road only
 * when item 54A says a highway passes beneath (H), not a railway (R) or
 * water (N). Item 41 K is closed.
 */
function nbiStructures() {
  const out: (Draft & Feature)[] = [];
  for (const name of ["nbi-dc.txt", "nbi-de.txt"]) {
    const [header, ...rows] = text(name).trim().split(/\r?\n/);
    const keys = header!.split(",");
    for (const line of rows) {
      const cells = line.match(/('[^']*'|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, ""));
      const r = Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? ""]));
      const number = r["STRUCTURE_NUMBER_008"]!.trim();
      const state = r["STATE_CODE_001"]!;
      const over = Number(r["VERT_CLR_OVER_MT_053"]);
      const under = Number(r["VERT_CLR_UND_054B"]);
      const clearances = [
        ...(over > 0 && over < 99.99
          ? [{ road: "carried", height: m(over), basis: "measured" }]
          : []),
        ...(r["VERT_CLR_UND_REF_054A"] === "H" && under > 0 && under < 99.99
          ? [{ road: "crossed", height: m(under), basis: "measured" }]
          : []),
      ];
      const cond = (v: string) => (/^[0-9N]$/.test(v) ? { value: v } : {});
      const conditions = Object.fromEntries(
        (
          [
            ["deck", r["DECK_COND_058"]],
            ["superstructure", r["SUPERSTRUCTURE_COND_059"]],
            ["substructure", r["SUBSTRUCTURE_COND_060"]],
            ["culvert", r["CULVERT_COND_062"]],
          ] as [string, string][]
        ).flatMap(([k, v]) => ("value" in cond(v) ? [[k, v]] : [])),
      );
      out.push(
        feature(
          provenance(
            "us-nbi",
            "nbi",
            `${state}-${number}`,
            "Federal Highway Administration",
            "public-domain",
          ),
          "structure",
          {
            ...point(nbiDegrees(r["LONG_017"]!, true), nbiDegrees(r["LAT_016"]!, false)),
            admin: { country: "US" },
          },
          {
            type: r["STRUCTURE_TYPE_043B"] === "19" ? "culvert" : "bridge",
            name: en(
              `${unquote(r["FACILITY_CARRIED_007"]!)} over ${unquote(r["FEATURES_DESC_006A"]!)}`,
            ),
            lifecycle: r["OPEN_CLOSED_POSTED_041"] === "K" ? "temporarily_closed" : "operational",
            externalIds: [{ scheme: "nbi:structure", id: `${state}-${number}`, authority: "FHWA" }],
            details: {
              kind: "structure",
              v: 1,
              carries: unquote(r["FACILITY_CARRIED_007"]!),
              crosses: unquote(r["FEATURES_DESC_006A"]!),
              yearBuilt: Number(r["YEAR_BUILT_027"]),
              ...(clearances.length > 0 ? { clearances } : {}),
              nbi: {
                structureNumber: number,
                stateCode: state,
                openStatus: r["OPEN_CLOSED_POSTED_041"],
                postingEvaluation: r["POSTING_EVAL_070"],
                conditions,
              },
            },
          },
        ),
      );
    }
  }
  return out;
}

interface FraCrossing {
  crossingid: string;
  crossingtype?: string;
  crossingpurpose: string;
  crossingposition: string;
  crossingclosed: string;
  street?: string;
  latitude?: string;
  longitude?: string;
  gateconfiguration?: string;
  countroadwaygatearms: string;
  countflashinglightpair: string;
  numberofbells: string;
  highwaytrafficsignal?: string;
  waysidehorn?: string;
  numbercrossbuckassemblies: string;
  numberstopsigns: string;
  numberyieldsigns: string;
  numberofmaintracks: string;
  numberofsidingtracks?: string;
}

/**
 * FRA inventory rows. Position is from the railway's side: "RR Under" is a
 * road over the railway. A passive crossing has no field of its own: it is
 * one without gates, lights, bells or signals. Four-quadrant gates close
 * the whole road, two or three quadrants only the entry lanes.
 */
function fraCrossings() {
  return (json("fra-crossings-de.json") as FraCrossing[]).map((r) => {
    const n = (v: string | undefined) => Number(v ?? 0);
    const warnings = [
      ...(n(r.countflashinglightpair) > 0 ? ["flashing_lights"] : []),
      ...(n(r.numberofbells) > 0 ? ["bells"] : []),
      ...(r.highwaytrafficsignal === "Yes" ? ["traffic_signal"] : []),
      ...(r.waysidehorn === "Yes" ? ["horn"] : []),
      ...(n(r.numbercrossbuckassemblies) > 0 ? ["crossbucks"] : []),
      ...(n(r.numberstopsigns) > 0 ? ["stop_sign"] : []),
      ...(n(r.numberyieldsigns) > 0 ? ["yield_sign"] : []),
    ];
    const gates = n(r.countroadwaygatearms);
    const tracks = n(r.numberofmaintracks) + n(r.numberofsidingtracks);
    const position = { "At Grade": "at_grade", "RR Under": "road_over", "RR Over": "road_under" }[
      r.crossingposition
    ]!;
    return feature(
      provenance(
        "us-fra-crossings",
        "fra-crossing-inventory",
        r.crossingid,
        "Federal Railroad Administration",
        "public-domain",
      ),
      "rail_crossing",
      {
        ...(r.latitude ? point(Number(r.longitude), Number(r.latitude)) : at(null)),
        admin: { country: "US", subdivision: "US-DE" },
      },
      {
        lifecycle: r.crossingclosed === "Yes" ? "decommissioned" : "operational",
        ...(r.street ? { name: en(r.street) } : {}),
        externalIds: [{ scheme: "fra:crossing", id: r.crossingid, authority: "FRA" }],
        ...(r.crossingtype === "Private" ? { access: { audience: "private" } } : {}),
        details: {
          kind: "rail_crossing",
          v: 1,
          position,
          ...(position === "at_grade"
            ? { barrier: gates === 0 ? "none" : r.gateconfiguration === "4 Quad" ? "full" : "half" }
            : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(tracks > 0 ? { tracks } : {}),
          usage: r.crossingpurpose === "Highway" ? "road" : "pedestrian",
        },
      },
    );
  });
}

/** NVDB `Type` of a railway crossing → position, barrier and whether it is signalled. */
const NVDB_RAIL_CROSSINGS: Record<
  string,
  { position: string; barrier?: string; signals?: boolean }
> = {
  "I plan": { position: "at_grade" },
  "I plan, uten lysregulering og bommer": { position: "at_grade", barrier: "none", signals: false },
  "I plan, lysregulert, uten bommer": { position: "at_grade", barrier: "none", signals: true },
  "I plan, lysregulert og bommer": { position: "at_grade", barrier: "unknown", signals: true },
  "I plan, lysregulert, hele bommer": { position: "at_grade", barrier: "full", signals: true },
  "I plan, lysregulert, halve bommer": { position: "at_grade", barrier: "half", signals: true },
  "I plan, lysregulert, grind": { position: "at_grade", barrier: "gate", signals: true },
  "Veg over": { position: "road_over" },
  "Veg under": { position: "road_under" },
};

function nvdbRailCrossings() {
  return nvdb("nvdb-rail-crossings.json").map((o) => {
    const t = NVDB_RAIL_CROSSINGS[prop(o, "Type")!]!;
    return feature(nvdbProvenance(o), "rail_crossing", nvdbLocation(o), {
      details: {
        kind: "rail_crossing",
        v: 1,
        position: t.position,
        ...(t.barrier ? { barrier: t.barrier } : {}),
        ...(t.signals ? { warnings: ["flashing_lights"] } : {}),
        ...(prop(o, "Særskilt fare")?.startsWith("Lange og lave") ? { humped: true } : {}),
      },
    });
  });
}

interface TiiSite {
  properties: Record<string, string | number>;
  geometry: { type: string; coordinates: unknown };
}

/**
 * TII collision-rate sections. The counts are collisions by their worst
 * outcome (fatal, serious, minor injury, material damage only); injury
 * collisions are the first three together. The rate's basis is not
 * documented with the data, so it is kept in the register's words.
 */
function tiiBlackspots() {
  return (json("tii-collision-rates.geojson").features as TiiSite[]).map((s) => {
    const p = s.properties;
    const n = (k: string) => Number(p[k]);
    return feature(
      provenance(
        "ie-tii-collision-rates",
        "esri-shapefile",
        String(p["Site_ID"]),
        "Transport Infrastructure Ireland",
        "CC-BY-4.0",
      ),
      "blackspot",
      {
        ...at(s.geometry, "linear"),
        admin: { country: "IE" },
        roads: [{ ref: String(p["ROUTE"]) }],
      },
      {
        details: {
          kind: "blackspot",
          v: 1,
          period: { from: "2014-01-01", to: "2016-12-31" },
          accidents: n("INJ_Coll") + n("MDO_Coll"),
          bySeverity: {
            fatal: n("F_Coll"),
            serious: n("SI_Coll"),
            slight: n("MI_Coll"),
            injury: n("INJ_Coll"),
            damageOnly: n("MDO_Coll"),
          },
          rate: { value: n("INJ_Coll_R"), basis: "INJ_Coll_R: injury collision rate" },
          band: String(p["Threshold"]),
          method: `collision rate against the reference population "${p["Ref_Pop"]}"`,
        },
      },
    );
  });
}

const LIGHT = { dimension: "gross_weight", operator: "lte", value: { value: 3500, unit: "kg" } };
const HEAVY = { dimension: "gross_weight", operator: "gt", value: { value: 3500, unit: "kg" } };
const classes = (...include: object[]) => ({ kind: "classes", include });
/** "til 08:59" includes that minute; an offer's end time is exclusive. */
const endExclusive = (hhmm: string) => {
  const [h, mi] = hhmm.split(":").map(Number);
  const t = h! * 60 + mi! + 1;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * AutoPASS toll stations. NVDB stores one reference rate per vehicle group
 * ("the first non-zero rate after midnight on a Monday"), with rush-hour
 * rates and their windows but no days; the stations' own tariff pages hold
 * the rest. Small is up to 3500 kg.
 */
function nvdbTolls() {
  const features: (Draft & Feature)[] = [];
  const offers: Draft[] = [];
  for (const o of nvdb("nvdb-toll-stations.json")) {
    const plant = prop(o, "Navn bompengeanlegg");
    const rule = prop(o, "Timesregel");
    const ruleMinutes = prop<number>(o, "Timesregel, varighet");
    const station = feature(nvdbProvenance(o), "toll_point", nvdbLocation(o), {
      name: nb(prop(o, "Navn bomstasjon")!),
      ...(plant === undefined ? {} : { operator: { role: "operator", name: nb(plant) } }),
      details: {
        kind: "toll_point",
        v: 1,
        system: "AutoPASS",
        paymentMethods: ["rfid"],
        // A station may name its hour rule without the hour: the rule is then left out, never assumed to be 60 minutes.
        ...(rule === undefined || ruleMinutes === undefined
          ? {}
          : {
              passageRule: {
                window: { value: ruleMinutes * 60, unit: "s" },
                charged: rule === "Dyreste passering gjelder" ? "most_expensive" : "first",
              },
            }),
      },
    });
    features.push(station);
    const nok = (v: number) => ({ amount: v.toFixed(2), currency: "NOK" });
    const flat = (price: number, vehicle: object, window?: [string, string]) => ({
      components: [{ type: "flat", price: nok(price) }],
      restrictions: {
        ...(window ? { startTime: window[0], endTime: endExclusive(window[1]) } : {}),
        vehicle,
      },
    });
    const rush = (vehicle: object, rate?: number) =>
      rate === undefined
        ? []
        : [
            flat(rate, vehicle, [prop(o, "Rushtid morgen, fra")!, prop(o, "Rushtid morgen, til")!]),
            flat(rate, vehicle, [
              prop(o, "Rushtid ettermiddag, fra")!,
              prop(o, "Rushtid ettermiddag, til")!,
            ]),
          ];
    const small = classes({ when: [LIGHT] });
    const large = classes({ when: [HEAVY] });
    offers.push({
      id: `oc:offer:no-nvdb:${o.id}/tariff`,
      class: "offer",
      kind: "toll",
      temporality: "static",
      location: station.location,
      provenance: station.provenance,
      freshness: { fetchedAt: FETCHED },
      subject: { class: "feature", id: station.id },
      currency: "NOK",
      elements: [
        ...rush(small, prop<number>(o, "Rushtidstakst liten bil")),
        flat(prop<number>(o, "Takst liten bil")!, small),
        ...rush(large, prop<number>(o, "Rushtidstakst stor bil")),
        flat(prop<number>(o, "Takst stor bil")!, large),
      ],
      validity: { status: "active" },
    });
  }
  return { features, offers };
}

/**
 * French motorway classes (ASFA): 1 = up to 2 m high and 3.5 t, 2 = 2–3 m
 * and up to 3.5 t, 3 = two axles and over 3 m or 3.5 t, 4 = three or more
 * axles and over 3 m or 3.5 t, 5 = motorcycles.
 */
const HEIGHT = (operator: string, value: number) => ({
  dimension: "height",
  operator,
  value: m(value),
});
const AXLES = (operator: string, value: number) => ({
  dimension: "axle_count",
  operator,
  value: { value, unit: "1" },
});
const FRENCH_CLASSES = [
  classes({ class: "motor_vehicle", when: [HEIGHT("lt", 2), LIGHT] }),
  classes({ class: "motor_vehicle", when: [HEIGHT("gte", 2), HEIGHT("lt", 3), LIGHT] }),
  classes(
    { class: "motor_vehicle", when: [AXLES("eq", 2), HEIGHT("gte", 3)] },
    { class: "motor_vehicle", when: [AXLES("eq", 2), HEAVY] },
  ),
  classes(
    { class: "motor_vehicle", when: [AXLES("gte", 3), HEIGHT("gte", 3)] },
    { class: "motor_vehicle", when: [AXLES("gte", 3), HEAVY] },
  ),
  classes({ class: "motorcycle" }),
];

/**
 * APRR prices each pair of stations; each pair is a toll section with one
 * offer holding a price per class. The file names stations only, with no
 * coordinates, so a section is located by its country until ingest joins
 * the ministry's register of toll plazas.
 */
function aprrTolls() {
  const [header, ...rows] = utf8("aprr-tariffs.csv").trim().split(/\r?\n/);
  const keys = header!.split(",");
  const features: (Draft & Feature)[] = [];
  const offers: Draft[] = [];
  for (const row of rows) {
    const r = Object.fromEntries(row.split(",").map((v, i) => [keys[i]!, v]));
    const localId = `${r["gare_entree"]}|${r["gare_sortie"]}`;
    const fr = (v: string) => [{ lang: "fr", text: v }];
    const section = feature(
      provenance("fr-aprr-tolls", "aprr-tariffs", localId, "APRR", "etalab-2.0"),
      "toll_section",
      { ...at(null, "linear"), admin: { country: "FR" } },
      {
        name: fr(`${r["gare_entree"]} – ${r["gare_sortie"]}`),
        details: {
          kind: "toll_section",
          v: 1,
          entryName: fr(r["gare_entree"]!),
          exitName: fr(r["gare_sortie"]!),
          length: m(Math.round(Number(r["distance_tarifaire_km"]) * 1000)),
        },
      },
    );
    features.push(section);
    offers.push({
      id: `oc:offer:fr-aprr-tolls:${localId}`,
      class: "offer",
      kind: "toll",
      temporality: "static",
      location: section.location,
      provenance: section.provenance,
      freshness: { fetchedAt: FETCHED },
      subject: { class: "feature", id: section.id },
      currency: "EUR",
      elements: FRENCH_CLASSES.map((vehicle, i) => ({
        components: [
          {
            type: "flat",
            price: { amount: Number(r[`tarif_classe_${i + 1}`]).toFixed(2), currency: "EUR" },
          },
        ],
        restrictions: { vehicle },
      })),
      priceIncludesVat: true,
      validity: { status: "active", start: "2026-02-01T00:00:00+01:00" },
    });
  }
  return { features, offers };
}

interface WsdotTrip {
  TripName: string;
  StateRoute: string;
  CurrentToll: number;
  TimeUpdated: string;
  StartLocationName: string;
  EndLocationName: string;
  StartLatitude: number;
  StartLongitude: number;
  EndLatitude: number;
  EndLongitude: number;
}

/**
 * WSDOT express-lane trips: one toll section per trip, priced in cents.
 * A trip that is not being priced reports 0 with .NET's minimum date, so a
 * zero there is unknown, not free. The published travel direction is left
 * out: both directions of one road carry the same letter.
 */
function wsdotTolls() {
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const t of json("wsdot-toll-rates.json") as WsdotTrip[]) {
    const section = feature(
      provenance(
        "us-wa-wsdot-tolls",
        "wsdot-traveler",
        t.TripName,
        "WSDOT",
        "WSDOT-traveler-information",
      ),
      "toll_section",
      {
        ...at(
          {
            type: "LineString",
            coordinates: [
              [t.StartLongitude, t.StartLatitude],
              [t.EndLongitude, t.EndLatitude],
            ],
          },
          "linear",
        ),
        roads: [{ ref: `SR ${Number(t.StateRoute)}` }],
        admin: { country: "US", subdivision: "US-WA" },
      },
      {
        details: {
          kind: "toll_section",
          v: 1,
          system: "Good To Go!",
          entryName: en(t.StartLocationName),
          exitName: en(t.EndLocationName),
        },
      },
    );
    features.push(section);
    const when = wcfDate(t.TimeUpdated);
    observations.push(
      observation(section, {
        property: "toll.price",
        result:
          when === undefined
            ? { type: "unknown" }
            : {
                type: "money",
                amount: (t.CurrentToll / 100).toFixed(2),
                currency: "USD",
                per: "1",
              },
        at: { instant: when ?? FETCHED },
      }),
    );
  }
  return { features, observations };
}

/**
 * NVDB weather-exposed roads flagged as official mountain passes: the
 * stretch between two gates, its normal-year winter and night closures and
 * how many days it is closed.
 */
function nvdbPasses() {
  return nvdb("nvdb-mountain-passes.json").map((o) => {
    const window = (from: string, to: string) => {
      const a = prop(o, from);
      const b = prop(o, to);
      return a && b ? { from: a, to: b } : undefined;
    };
    const winter = window("Vinterstengt, fra dato", "Vinterstengt, til dato");
    const night = window("Nattestengt, fra dato", "Nattestengt, til dato");
    const reduced = window("Avgrensa vinterdrift, fra dato", "Avgrensa vinterdrift, til dato");
    const gradient = prop<number>(o, "Stigning, offisiell");
    const closedDays = prop<number>(o, "Antall stengte døgn");
    return feature(nvdbProvenance(o), "mountain_pass", nvdbLocation(o), {
      name: nb(prop(o, "Navn")!),
      details: {
        kind: "mountain_pass",
        v: 1,
        fromName: nb(prop(o, "Sted, fra")!),
        toName: nb(prop(o, "Sted, til")!),
        ...(gradient === undefined ? {} : { gradientPct: gradient }),
        ...(winter ? { winterClosure: winter } : {}),
        ...(night ? { nightClosure: night } : {}),
        ...(reduced ? { reducedWinterService: reduced } : {}),
        ...(closedDays === undefined ? {} : { closedDaysPerYear: closedDays }),
      },
    });
  });
}

interface WsdotPass {
  mountainPass: {
    mountainPassId: number;
    mountainPassName: string;
    elevation: number;
    latitude: number;
    longitude: number;
    stateRouteId: string;
  };
  condition: {
    displayDate: string;
    restrictionOne: { travelDirectionName: string; publicPage: string };
    restrictionTwo: { travelDirectionName: string; publicPage: string };
  };
}
const COMPASS: Record<string, string> = {
  Northbound: "N",
  Southbound: "S",
  Eastbound: "E",
  Westbound: "W",
};

/**
 * WSDOT pass reports state a restriction per direction in free text; only
 * the texts the fixture holds are mapped here ("No restrictions" is open),
 * anything else is `unknown` until ingest classifies it. Elevation is feet.
 */
function wsdotPasses() {
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const p of json("wsdot-mountain-passes.json") as WsdotPass[]) {
    const mp = p.mountainPass;
    const pass = feature(
      provenance(
        "us-wa-wsdot-passes",
        "wsdot-web",
        String(mp.mountainPassId),
        "WSDOT",
        "WSDOT-traveler-information",
      ),
      "mountain_pass",
      {
        ...point(mp.longitude, mp.latitude),
        roads: [{ ref: `SR ${Number(mp.stateRouteId)}` }],
        admin: { country: "US", subdivision: "US-WA" },
      },
      {
        name: en(mp.mountainPassName),
        details: {
          kind: "mountain_pass",
          v: 1,
          elevation: m(Math.round(mp.elevation * 0.3048 * 10) / 10),
        },
      },
    );
    features.push(pass);
    for (const r of [p.condition.restrictionOne, p.condition.restrictionTwo]) {
      observations.push(
        observation(pass, {
          property: "pass.status",
          result: category(r.publicPage === "No restrictions" ? "open" : "unknown", "pass_status"),
          at: { instant: p.condition.displayDate.replace(/\.\d+Z$/, "Z") },
          qualifiers: { direction: COMPASS[r.travelDirectionName] },
        }),
      );
    }
  }
  return { features, observations };
}

interface CaltransPoint {
  cc: {
    index: string;
    location: {
      locationName: string;
      longitude: string;
      latitude: string;
      elevation: string;
      direction: string;
      route: string;
    };
    inService: string;
    statusData: { statusTimestamp: { statusDate: string; statusTime: string }; status: string };
  };
}
/** Caltrans status codes that are chain levels; the others are operations (escorts, holds, closures). */
const CALTRANS_CHAIN_LEVELS: Record<string, string | null> = {
  "R-0": "none",
  "R-1": "R1",
  "R-2": "R2",
  "R-3": "R3",
  "R-1 MODIFIED": null,
  ESC: null,
  TH: null,
  TS: null,
  TTA: null,
  TTS: null,
  TTSD: null,
  VM: null,
  HT: null,
  MIN: null,
  MAX: null,
  W: null,
  RC: null,
  "Road Closed": null,
  "Not Reported": null,
};

/**
 * Caltrans chain-control checkpoints, one per direction. The status time
 * is when the status last changed (Pacific local, no offset), so it is the
 * phenomenon time; an R-0 that has held since spring is still R-0 now.
 * "R-1 MODIFIED" (trucks and trailers only) is a vehicle-scoped requirement,
 * which a level cannot say: ingest makes it an effect. A status that is not
 * a Caltrans code at all (two District 7 rows carry a longitude there) is
 * unknown.
 */
function caltransChainControls() {
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const { cc } of json("caltrans-chain-controls.json").data as CaltransPoint[]) {
    const l = cc.location;
    const located = l.latitude !== "Not Reported";
    const compass = { North: "N", South: "S", East: "E", West: "W" }[l.direction];
    const zone = feature(
      provenance("us-ca-caltrans-cc", "cwwp2", cc.index, "Caltrans", "Caltrans-conditions-of-use"),
      "chain_control_zone",
      {
        ...(located ? point(Number(l.longitude), Number(l.latitude)) : at(null)),
        ...(located ? { elevationM: Math.round(Number(l.elevation) * 0.3048) } : {}),
        roads: [{ ref: l.route }],
        // "*" and "" name both directions or none; only a compass word is a direction.
        ...(compass === undefined
          ? {}
          : { direction: { value: "unknown", basis: "compass", compass } }),
        admin: { country: "US", subdivision: "US-CA" },
      },
      {
        name: en(l.locationName),
        lifecycle: cc.inService === "true" ? "operational" : "temporarily_closed",
        details: { kind: "chain_control_zone", v: 1 },
      },
    );
    features.push(zone);
    const s = cc.statusData;
    const known = s.status in CALTRANS_CHAIN_LEVELS;
    const level = known ? CALTRANS_CHAIN_LEVELS[s.status] : undefined;
    if (level === null) continue;
    observations.push(
      observation(zone, {
        property: "winter.chain_level",
        result: level === undefined ? { type: "unknown" } : category(level, "chain_level"),
        at: {
          instant: zoned(
            s.statusTimestamp.statusDate,
            s.statusTimestamp.statusTime,
            "America/Los_Angeles",
          ),
        },
      }),
    );
  }
  return { features, observations };
}

interface CaltransRoute {
  tt: {
    index: string;
    location: {
      travelFlowDirection: string;
      begin: {
        beginLocationName: string;
        beginRoute: string;
        beginPostmile: string;
        beginLongitude: string;
      };
      end: { endLocationName: string; endPostmile: string };
    };
    traveltime: { traveltimeTimestamp: { traveltimeEpoch: string }; calculatedTraveltime: string };
  };
}

/**
 * Caltrans District 12 travel times. The route end points carry placeholder
 * coordinates (0.000001), so a route is located by its road and postmiles
 * only; the documentation says minutes, but the values are seconds (a
 * 13-mile stretch at 1026).
 */
function caltransTravelTimes() {
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const { tt } of json("caltrans-travel-times.json").data as CaltransRoute[]) {
    const b = tt.location.begin;
    const e = tt.location.end;
    const route = feature(
      provenance("us-ca-caltrans-tt", "cwwp2", tt.index, "Caltrans", "Caltrans-conditions-of-use"),
      "travel_time_route",
      {
        ...at(null, "linear"),
        roads: [{ ref: b.beginRoute }],
        linear: {
          system: "milepost",
          ref: b.beginRoute,
          from: Number(b.beginPostmile),
          to: Number(e.endPostmile),
        },
        admin: { country: "US", subdivision: "US-CA" },
      },
      {
        details: {
          kind: "travel_time_route",
          v: 1,
          fromName: en(b.beginLocationName),
          toName: en(e.endLocationName),
        },
      },
    );
    features.push(route);
    const epoch = Number(tt.traveltime.traveltimeTimestamp.traveltimeEpoch);
    observations.push(
      observation(route, {
        property: "traffic.travel_time",
        result: { type: "quantity", value: Number(tt.traveltime.calculatedTraveltime), unit: "s" },
        at: { instant: new Date(epoch * 1000).toISOString().replace(".000Z", "Z") },
      }),
    );
  }
  return { features, observations };
}

/**
 * DATEX II 3.1 travel times: the route table holds each predefined location
 * with its line in UTM zone 33 metres (EPSG 32633), the elaborated data its
 * travel time over a 5-minute period, the free-flow time and speed as the
 * baseline, the trend, and a separate traffic status for the same route.
 */
function vegvesenTravelTimes() {
  const routes = new Map<string, Draft & Feature>();
  const table = xml("vegvesen-travel-time-locations.xml").messageContainer.payload;
  const list = <T>(v: T | T[]) => (Array.isArray(v) ? v : [v]);
  for (const loc of list(table.predefinedLocationReference) as Record<string, any>[]) {
    const coords = String(loc.location.gmlLineString.posList).trim().split(/\s+/).map(Number);
    const line: [number, number][] = [];
    for (let i = 0; i < coords.length; i += 2) line.push(utm33(coords[i]!, coords[i + 1]!));
    const route = feature(
      {
        ...provenance(
          "no-vegvesen-traveltime",
          "datex2",
          loc["@id"],
          "Statens vegvesen",
          "NLOD-2.0",
        ),
        recordVersion: loc["@version"],
      },
      "travel_time_route",
      { ...at({ type: "LineString", coordinates: line }, "linear"), admin: { country: "NO" } },
      {
        name: nb(loc.predefinedLocationName.values.value["#text"]),
        details: { kind: "travel_time_route", v: 1 },
      },
    );
    routes.set(loc["@id"], route);
  }
  const observations: Draft[] = [];
  const data = xml("vegvesen-travel-time-data.xml").messageContainer.payload;
  for (const q of list(data.physicalQuantity) as Record<string, any>[]) {
    const route = routes.get(q.pertinentLocation.predefinedLocationReference["@id"])!;
    const basic = q.basicData;
    if (basic["@type"] === "ns10:TravelTimeData") {
      const period = basic.measurementOrCalculationTime.period;
      observations.push(
        observation(route, {
          property: crosswalk.property("datex2_v3", "TravelTimeData/travelTime")!,
          result: { type: "quantity", value: Number(basic.travelTime.duration), unit: "s" },
          at: { start: period.startOfPeriod, end: period.endOfPeriod },
          aggregation: "mean",
          quality: {
            trend: crosswalk.value(
              "trend",
              "datex2_v3",
              `travelTimeTrendType:${basic.travelTimeTrendType}`,
            ),
          },
          baseline: {
            source: "native",
            freeFlow: { value: Number(basic.freeFlowTravelTime.duration), unit: "s" },
          },
        }),
      );
    } else {
      observations.push(
        observation(route, {
          property: "traffic.los",
          result: category(
            crosswalk.value("los", "datex2_v3", basic.trafficStatus.trafficStatusValue)!,
            "los",
          ),
          at: { instant: data.publicationTime },
        }),
      );
    }
  }
  return { features: [...routes.values()], observations };
}

describe("road network fit", () => {
  const structures = [...nbiStructures(), ...nvdbStructures()];
  const derived = structures.flatMap((s) => structureRestrictions(s as unknown as StructureInput));

  it("seals every bridge, culvert and tunnel of both registers", () => {
    expect(sealAll(structures)).toEqual([]);
    const types = structures.map((s) => s["type"]);
    expect(types).toContain("culvert");
    expect(types).toContain("tunnel");
  });

  it("puts a US under-clearance on the road beneath only when a highway passes there", () => {
    const byId = new Map(structures.map((s) => [s.id, s]));
    const kStreet = byId.get("oc:feature:us-nbi:11-0032")!;
    expect((kStreet["details"] as { clearances: unknown[] }).clearances).toEqual([
      { road: "carried", height: m(4.22), basis: "measured" },
      { road: "crossed", height: m(4.29), basis: "measured" },
    ]);
    const railBeneath = byId.get("oc:feature:us-nbi:11-0503(EB)")!;
    expect((railBeneath["details"] as { clearances?: unknown }).clearances).toBeUndefined();
  });

  it("derives sealed standing restrictions from the structures", () => {
    expect(sealAll(derived)).toEqual([]);
    const kinds = derived.map((d) => `${d["kind"]}.${d["type"]}.${d["subtype"] ?? ""}`);
    expect(kinds).toContain("restriction.dimension.height");
    expect(kinds).toContain("restriction.dimension.weight");
    expect(kinds).toContain("closure.closure.bridge");
  });

  it("makes the signed height the legal limit of a Norwegian tunnel", () => {
    const hjelle = structures.find(
      (s) => (s["name"] as { text: string }[])?.[0]?.text === "Hjelletunnelen",
    )!;
    const [restriction] = structureRestrictions(hjelle as unknown as StructureInput);
    expect((restriction!["effects"] as object[])[0]).toMatchObject({
      value: { value: 4, unit: "m" },
      meaning: "maximum_permitted",
    });
  });

  it("keeps a US bridge posted for load, whose weight the inventory lacks, as withheld evidence", () => {
    const posted = derived.filter((d) => d["subtype"] === "weight");
    expect(posted.length).toBeGreaterThan(0);
    for (const d of posted) {
      expect((d["effects"] as object[])[0]).toMatchObject({
        kind: "unsupported",
        normalization: "unsupported",
      });
    }
  });

  it("seals every level crossing, open or closed, at grade or not", () => {
    const crossings = [...fraCrossings(), ...nvdbRailCrossings()];
    expect(sealAll(crossings)).toEqual([]);
    const positions = new Set(
      crossings.map((c) => (c["details"] as { position: string }).position),
    );
    expect([...positions].sort()).toEqual(["at_grade", "road_over", "road_under"]);
    const closed = crossings.filter((c) => c["lifecycle"] === "decommissioned");
    expect(closed.length).toBeGreaterThan(0);
  });

  it("tells a passive crossing by the absence of active warnings", () => {
    const passive = fraCrossings().find((c) => c.provenance.recordId === "140749B")!;
    expect(passive["details"]).toMatchObject({
      barrier: "none",
      warnings: ["crossbucks", "yield_sign"],
    });
  });

  it("counts blackspot collisions by their worst outcome", () => {
    const spots = tiiBlackspots();
    expect(sealAll(spots)).toEqual([]);
    for (const s of spots) {
      const d = s["details"] as { accidents: number; bySeverity: Record<string, number> };
      const b = d.bySeverity;
      expect(b["fatal"]! + b["serious"]! + b["slight"]!).toBe(b["injury"]);
      expect(b["injury"]! + b["damageOnly"]!).toBe(d.accidents);
    }
  });

  it("prices a Norwegian toll station by vehicle weight and rush hour", () => {
    const { features, offers } = nvdbTolls();
    expect(sealAll([...features, ...offers])).toEqual([]);
    const elements = offers[0]!["elements"] as {
      restrictions: { startTime?: string; endTime?: string };
    }[];
    expect(elements[0]!.restrictions).toMatchObject({ startTime: "06:30", endTime: "09:00" });
  });

  it("prices a French motorway journey per vehicle class", () => {
    const { features, offers } = aprrTolls();
    expect(sealAll([...features, ...offers])).toEqual([]);
    expect(offers[0]!["elements"]).toHaveLength(5);
    const free = offers.find((o) => o["id"] === "oc:offer:fr-aprr-tolls:BALAN|PEROUGES")!;
    expect(
      (free["elements"] as { components: { price: { amount: string } }[] }[])[0]!.components[0]!
        .price.amount,
    ).toBe("0.00");
  });

  it("observes a dynamic toll per trip and leaves an unpriced trip unknown, not free", () => {
    const { features, observations } = wsdotTolls();
    expect(sealAll([...features, ...observations])).toEqual([]);
    const results = observations.map((o) => (o["result"] as { type: string }).type);
    expect(results.filter((t) => t === "money")).toHaveLength(6);
    expect(results.filter((t) => t === "unknown")).toHaveLength(1);
  });

  it("keeps a Norwegian pass's normal-year closures", () => {
    const passes = nvdbPasses();
    expect(sealAll(passes)).toEqual([]);
    const sognefjellet = passes.find(
      (p) => (p["name"] as { text: string }[])[0]!.text === "Sognefjellet",
    )!;
    expect(sognefjellet["details"]).toMatchObject({
      winterClosure: { from: "12-01", to: "05-01" },
      nightClosure: { from: "11-01", to: "05-05" },
      closedDaysPerYear: 188,
    });
  });

  it("observes a US pass's status per direction", () => {
    const { features, observations } = wsdotPasses();
    expect(sealAll([...features, ...observations])).toEqual([]);
    expect(observations.map((o) => (o["qualifiers"] as { direction: string }).direction)).toContain(
      "N",
    );
  });

  it("observes each chain-control checkpoint's level since it last changed", () => {
    const { features, observations } = caltransChainControls();
    expect(sealAll([...features, ...observations])).toEqual([]);
    expect(
      observations.filter((o) => (o["result"] as { type: string }).type === "unknown"),
    ).toHaveLength(1);
    expect(observations[0]!["phenomenonTime"]).toEqual({ instant: "2023-03-25T16:12:38-07:00" });
  });

  it("observes journey times on routes located by road and postmile alone", () => {
    const { features, observations } = caltransTravelTimes();
    expect(sealAll([...features, ...observations])).toEqual([]);
    expect(observations[0]!["result"]).toEqual({ type: "quantity", value: 1026, unit: "s" });
  });

  it("reads a DATEX travel time with its free-flow baseline, trend and level of service", () => {
    const { features, observations } = vegvesenTravelTimes();
    expect(sealAll([...features, ...observations])).toEqual([]);
    const [time, los] = observations;
    expect(time).toMatchObject({
      property: "traffic.travel_time",
      result: { value: 142 },
      quality: { trend: "steady" },
      baseline: { freeFlow: { value: 150, unit: "s" } },
    });
    expect(los!["result"]).toEqual(category("free_flow", "los"));
    const [lon, lat] = (features[0]!["location"] as { geometry: { coordinates: number[][] } })
      .geometry.coordinates[0]!;
    expect(lon).toBeCloseTo(5.4, 0);
    expect(lat).toBeCloseTo(60.5, 0);
  });
});
