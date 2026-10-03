import { readFileSync } from "node:fs";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  partOfTree,
  type RegistryModule,
  sealRecord,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Roadside fit check: real published records of border crossings and their
 * queues, rest areas with the car parks inside them, weigh stations and
 * ferries, mapped onto Feature, Component and Observation and sealed against
 * the production registry. Captured 2026-09-29 from:
 * - U.S. Customs and Border Protection border wait times (public domain);
 * - Canada Border Services Agency border wait times (Open Government
 *   Licence – Canada);
 * - the Norwegian road database NVDB (rest areas, control and weigh
 *   stations, ferry connections and quays; NLOD 2.0), geometry simplified
 *   by the API's own `geometritoleranse=10`;
 * - Ontario 511 rest areas and ferries (Open Government Licence – Ontario);
 * - Iowa DOT weigh scales (CC BY 4.0);
 * - Washington State Ferries terminal sailing space (WSDOT Traveler
 *   Information API).
 * OpenConditions parses none of these formats yet, so a test-only module
 * registers them.
 */
const fitFormats: RegistryModule = {
  name: "roadside-fit",
  entries: [
    extendVocabulary({
      vocabulary: "source_format",
      values: ["cbp-bwt", "cbsa-bwt", "nvdb", "ibi511-web", "arcgis", "wsf"],
    }),
  ],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const FETCHED = "2026-09-29T21:10:00Z";

const utf8 = (name: string) =>
  readFileSync(new URL(`./fixtures/roadside/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(utf8(name));

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
  fuzziness: geometry === null ? "low_res" : "exact",
});
const en = (value: string) => [{ lang: "en", text: value }];
const nb = (value: string) => [{ lang: "nb", text: value }];

interface Feature {
  id: string;
  location: unknown;
  provenance: ReturnType<typeof provenance>;
}

function feature(
  prov: ReturnType<typeof provenance>,
  kind: string,
  location: unknown,
  rest: Record<string, unknown>,
  localId = prov.recordId,
): Draft & Feature {
  return {
    id: `oc:feature:${prov.sourceId}:${localId}`,
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
    at: string;
    componentKey?: string;
    qualifiers?: Record<string, unknown>;
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
    subject: {
      kind: "feature",
      featureId: subject.id,
      ...(o.componentKey === undefined ? {} : { componentKey: o.componentKey }),
    },
    ...(o.qualifiers === undefined ? {} : { qualifiers: o.qualifiers }),
    result: o.result,
    phenomenonTime: { instant: o.at },
    aggregation: "instantaneous",
  };
  return { id: observationId(subject.provenance.sourceId, draft as never), ...draft };
}

const category = (value: string, vocabulary: string) => ({ type: "category", value, vocabulary });
const wait = (value: object) => ({
  type: "structured",
  schema: "border_wait",
  v: 1,
  value: { v: 1, ...value },
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
  const abs = Math.abs(offsetMin);
  const offset = `${offsetMin < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${date}T${time}${offset}`;
}
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/** `h:mm am|pm` → `HH:MM:00`. */
const clock = (h: string, mm: string, half: string) =>
  `${String((Number(h) % 12) + (half.toLowerCase() === "pm" ? 12 : 0)).padStart(2, "0")}:${mm}:00`;

/**
 * CBP's zone labels are not reliable (a Michigan port says EST in
 * September, an Arizona port PST), so the port's own zone decides; a time
 * that would lie after the capture is yesterday's.
 */
const CBP_PORT_ZONES: Record<string, string> = {
  "070801": "America/New_York",
  "300403": "America/Los_Angeles",
  "090101": "America/New_York",
  "011502": "America/New_York",
  L01901: "America/New_York",
  "380201": "America/Detroit",
  "240215": "America/Denver",
  "535502": "America/Chicago",
  "260101": "America/Phoenix",
  l24501: "America/Denver",
  "230404": "America/Chicago",
  "250401": "America/Los_Angeles",
};
const CBP_MODES = {
  commercial_vehicle_lanes: "commercial",
  passenger_vehicle_lanes: "passenger",
  pedestrian_lanes: "pedestrian",
} as const;
const CBP_PROGRAMS: Record<string, string> = {
  standard_lanes: "standard",
  FAST_lanes: "fast",
  NEXUS_SENTRI_lanes: "trusted_traveller",
  ready_lanes: "ready_lane",
};

/** "24 hrs/day", "8 am-4 pm", "6 am-Midnight" → OSM opening hours; anything else stays unparsed. */
function cbpHours(hours: string, zone: string) {
  if (hours === "24 hrs/day") return { osm: "24/7", twentyFourSeven: true, timezone: zone };
  const m = /^(\d{1,2}) (am|pm)-(?:(\d{1,2}) (am|pm)|Midnight)$/.exec(hours);
  if (m === null) return undefined;
  const open = clock(m[1]!, "00", m[2]!).slice(0, 5);
  const close = m[3] === undefined ? "24:00" : clock(m[3], "00", m[4]!).slice(0, 5);
  return { osm: `${open}-${close}`, timezone: zone };
}

interface CbpLane {
  operational_status: string;
  delay_minutes: string;
  lanes_open: string;
  update_time: string;
}
type CbpPort = Record<string, unknown> & {
  port_number: string;
  port_name: string;
  crossing_name: string;
  border: string;
  port_status: string;
  date: string;
  time: string;
  hours: string;
};

/**
 * One CBP port is one crossing feature, located by country alone: neither
 * border feed publishes coordinates. A queue CBP marks N/A does not exist at
 * that port, so it gets no lane group; "Update Pending" is a queue whose
 * state is unknown; "no delay" may still come with a few minutes.
 */
function cbpCrossings() {
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const p of json("cbp-bwt.json") as CbpPort[]) {
    const zone = CBP_PORT_ZONES[p.port_number]!;
    const [month, day, year] = p.date.split("/");
    const date = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
    const pageTime = zoned(date, p.time, zone);
    const from = p.border === "Canadian Border" ? "CA" : "MX";
    const components: object[] = [];
    const waits: { key: string; lane: CbpLane }[] = [];
    for (const [field, mode] of Object.entries(CBP_MODES)) {
      for (const [program, lane] of Object.entries(p[field] as Record<string, CbpLane | string>)) {
        if (typeof lane === "string" || lane.operational_status === "N/A") continue;
        const key = `${mode}/${CBP_PROGRAMS[program]}`;
        components.push({
          key,
          kind: "lane_group",
          details: {
            kind: "lane_group",
            v: 1,
            mode,
            program: CBP_PROGRAMS[program],
            direction: { from, to: "US" },
          },
        });
        waits.push({ key, lane });
      }
    }
    const hours = cbpHours(p.hours, zone);
    const crossing = feature(
      provenance(
        "us-cbp-bwt",
        "cbp-bwt",
        p.port_number,
        "U.S. Customs and Border Protection",
        "public-domain",
      ),
      "border_crossing",
      { ...at(null), admin: { country: "US" } },
      {
        name: en(
          p.crossing_name.trim() ? `${p.port_name}: ${p.crossing_name.trim()}` : p.port_name,
        ),
        externalIds: [{ scheme: "cbp:port", id: p.port_number, authority: "CBP" }],
        ...(hours === undefined ? {} : { openingHours: hours }),
        ...(components.length > 0 ? { components } : {}),
        details: {
          kind: "border_crossing",
          v: 1,
          countries: [from, "US"],
          ports: [
            {
              country: "US",
              name: en(p.port_name),
              externalIds: [{ scheme: "cbp:port", id: p.port_number }],
            },
          ],
          modes:
            [...new Set(components.map((c) => (c as { details: { mode: string } }).details.mode))]
              .length > 0
              ? [
                  ...new Set(
                    components.map((c) => (c as { details: { mode: string } }).details.mode),
                  ),
                ]
              : ["passenger"],
        },
      },
    );
    features.push(crossing);
    observations.push(
      observation(crossing, {
        property: "facility.open_status",
        result: category(p.port_status === "Open" ? "open" : "closed", "facility_open_status"),
        at: pageTime,
      }),
    );
    for (const { key, lane } of waits) {
      const status = lane.operational_status;
      const time = /At (\d{1,2}):(\d{2}) (am|pm)/.exec(lane.update_time);
      let instant = pageTime;
      if (time !== null) {
        instant = zoned(date, clock(time[1]!, time[2]!, time[3]!), zone);
        if (Date.parse(instant) > Date.parse(FETCHED)) {
          instant = zoned(addDays(date, -1), clock(time[1]!, time[2]!, time[3]!), zone);
        }
      }
      const minutes = lane.delay_minutes === "" ? {} : { waitMinutes: Number(lane.delay_minutes) };
      const lanesOpen = lane.lanes_open === "" ? {} : { lanesOpen: Number(lane.lanes_open) };
      const result =
        status === "Update Pending"
          ? { type: "unknown" }
          : status === "Lanes Closed"
            ? wait({ status: "closed" })
            : wait({ status: status === "delay" ? "delay" : "no_delay", ...minutes, ...lanesOpen });
      observations.push(
        observation(crossing, { property: "border.wait", result, at: instant, componentKey: key }),
      );
    }
  }
  return { features, observations };
}

/** CBSA's labels are right: Saskatchewan's CST is its time all year. */
const CBSA_ZONE_OFFSETS: Record<string, string> = {
  NDT: "-02:30",
  NST: "-03:30",
  ADT: "-03:00",
  AST: "-04:00",
  EDT: "-04:00",
  EST: "-05:00",
  CDT: "-05:00",
  CST: "-06:00",
  MDT: "-06:00",
  MST: "-07:00",
  PDT: "-07:00",
  PST: "-08:00",
};

/**
 * CBSA publishes one row per customs office with the Canada-bound waits
 * only (the U.S.-bound columns are "--"), and no id: office names even
 * differ between its CSV and JSON editions, so the name is the key.
 */
function cbsaCrossings() {
  const [header, ...rows] = utf8("cbsa-bwt.csv").replace(/^﻿/, "").trim().split(/\r?\n/);
  const keys = header!.split(";;").map((k) => k.trim());
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const row of rows) {
    const r = Object.fromEntries(row.split(";;").map((v, i) => [keys[i]!, v.trim()]));
    const office = r["Customs Office"]!;
    const [d, t, label] = r["Last updated"]!.split(" ");
    const instant = `${d}T${t}:00${CBSA_ZONE_OFFSETS[label!]}`;
    const queues = [
      ["commercial", r["Commercial Flow - Canada bound"]!],
      ["passenger", r["Travellers Flow - Canada bound"]!],
    ].filter(([, v]) => v !== "Not Applicable" && v !== "--");
    const crossing = feature(
      provenance("ca-cbsa-bwt", "cbsa-bwt", office, "Canada Border Services Agency", "OGL-CA"),
      "border_crossing",
      { ...at(null), admin: { country: "CA" }, areaDescription: en(r["Location"]!) },
      {
        name: en(office),
        components: queues.map(([mode]) => ({
          key: `${mode}/standard`,
          kind: "lane_group",
          details: { kind: "lane_group", v: 1, mode, direction: { from: "US", to: "CA" } },
        })),
        details: {
          kind: "border_crossing",
          v: 1,
          countries: ["CA", "US"],
          ports: [{ country: "CA", name: en(office) }],
          modes: queues.map(([mode]) => mode),
        },
      },
    );
    features.push(crossing);
    for (const [mode, value] of queues) {
      const minutes = /^(\d+) minutes?$/.exec(value!);
      observations.push(
        observation(crossing, {
          property: "border.wait",
          result: wait(
            minutes === null
              ? { status: "no_delay" }
              : { status: "delay", waitMinutes: Number(minutes[1]) },
          ),
          at: instant,
          componentKey: `${mode}/standard`,
        }),
      );
    }
  }
  return { features, observations };
}

interface NvdbObject {
  id: number;
  metadata: { versjon: number };
  egenskaper: { navn: string; verdi?: unknown }[];
  geometri: { wkt: string };
  relasjoner?: { barn?: { type: { id: number } }[] };
  lokasjon: { vegsystemreferanser?: { kortform: string }[] };
}
const nvdb = (name: string) => json(name).objekter as NvdbObject[];
const prop = <T = string>(o: NvdbObject, name: string) =>
  o.egenskaper.find((e) => e.navn === name)?.verdi as T | undefined;

/** NVDB's WKT lists latitude first; corrected to RFC 7946 order. */
function nvdbGeometry(wkt: string) {
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

/** NVDB child objects of a rest area that are amenities; buildings and green areas are not. */
const NVDB_REST_AREA_CHILDREN: Record<number, string> = {
  28: "picnic_facilities",
  27: "refuse_bin",
  243: "toilets",
};
/** NVDB parking counts → the parking area they describe. */
const NVDB_REST_AREA_SPACES: [string, string, object][] = [
  ["Antall oppstillingspl. små kjt.", "car", {}],
  ["Antall oppstillingspl. store kjt.", "truck", {}],
  ["Antall oppstillingspl. forflytningshemmede", "car", { userGroup: "disabled" }],
  ["Antall oppstillingspl. med lading, små kjt.", "car", { userGroup: "ev_charging" }],
  ["Antall oppstillingspl. med lading, store kjt.", "truck", { userGroup: "ev_charging" }],
];

/**
 * An NVDB rest area becomes a rest area and, when it has spaces, a car park
 * that is `part_of` it. NVDB publishes every space count, zeros included,
 * so its list of areas is complete and a zero is an area that does not
 * exist. Amenities come partly from yes/no properties and partly from child
 * objects (toilet blocks, outdoor furniture, bins).
 */
function nvdbRestAreas() {
  const features: (Draft & Feature)[] = [];
  for (const o of nvdb("nvdb-rest-areas.json")) {
    const yes = (name: string) => prop(o, name) === "Ja";
    const amenities = [
      ...(yes("Dusj") ? ["shower"] : []),
      ...(yes("Drikkevann") ? ["fresh_water"] : []),
      ...(yes("Strømuttak") ? ["power_outlet"] : []),
      ...(o.relasjoner?.barn ?? []).flatMap((b) => NVDB_REST_AREA_CHILDREN[b.type.id] ?? []),
    ];
    const from = prop(o, "Helt vinterstengt, fra dato");
    const to = prop(o, "Helt vinterstengt, til dato");
    const both = prop(o, "Lovlig adkomst") === "Begge retninger";
    const area = feature(nvdbProvenance(o), "rest_area", nvdbLocation(o), {
      type: "rest_area",
      name: nb(prop(o, "Navn")!),
      ...(amenities.length > 0 ? { amenities: [...new Set(amenities)] } : {}),
      details: {
        kind: "rest_area",
        v: 1,
        direction: { value: both ? "both" : "unknown", basis: "road_reference" },
        ...(from && to ? { seasonalClosure: { from, to } } : {}),
        paved: yes("Fast dekke"),
      },
    });
    features.push(area);
    const components = NVDB_REST_AREA_SPACES.flatMap(([name, vehicleType, group]) => {
      const capacity = prop<number>(o, name) ?? 0;
      if (capacity === 0) return [];
      const key = `${vehicleType}/${(group as { userGroup?: string }).userGroup ?? "any"}`;
      return [
        {
          key,
          kind: "parking_area",
          details: { kind: "parking_area", v: 1, vehicleType, ...group, capacity },
        },
      ];
    });
    if (components.length === 0) continue;
    features.push(
      feature(
        nvdbProvenance(o),
        "parking_site",
        area.location,
        {
          type: "rest_area_parking",
          relations: [{ relation: "part_of", ref: { class: "feature", id: area.id } }],
          components,
          details: {
            kind: "parking_site",
            v: 1,
            usage: components.some((c) => c.key.startsWith("truck")) ? ["truck"] : undefined,
          },
        },
        `${o.id}/parking`,
      ),
    );
  }
  return features.map((f) => {
    const d = f["details"] as Record<string, unknown>;
    if (d["usage"] === undefined) delete d["usage"];
    return f;
  });
}

/** NVDB control and weigh stations: the station type, how it weighs, and when the scale can be used. */
function nvdbWeighStations() {
  const types: Record<string, [string, string?]> = {
    Kontrollplass: ["control_area"],
    "Liten kontrollstasjon": ["inspection_station", "small"],
    "Stor kontrollstasjon": ["inspection_station", "large"],
  };
  const scales: Record<string, string> = {
    "Fastmontert vekt": "static",
    "Mobil vekt": "portable",
    "Ikke egnet for veiing": "none",
  };
  return nvdb("nvdb-weigh-stations.json").map((o) => {
    const [type, subtype] = types[prop(o, "Type")!]!;
    const scale = prop(o, "Veiing");
    const spaces = prop<number>(o, "Antall oppstillingsplasser, lange");
    return feature(nvdbProvenance(o), "weigh_station", nvdbLocation(o), {
      type,
      ...(subtype === undefined ? {} : { subtype }),
      name: nb(prop(o, "Navn")!),
      // "Hele døgnet" is the only availability NVDB states in hours; "I åpningstid" names hours it does not hold.
      ...(prop(o, "Vekt tilgjengelig") === "Hele døgnet"
        ? { openingHours: { osm: "24/7", twentyFourSeven: true, timezone: "Europe/Oslo" } }
        : {}),
      details: {
        kind: "weigh_station",
        v: 1,
        ...(scale === undefined ? {} : { scaleType: scales[scale] }),
        ...(spaces === undefined ? {} : { truckSpaces: spaces }),
      },
    });
  });
}

interface OntarioRow {
  name: string;
  type: string;
  status: string;
  roadway: string;
  direction: string;
  fuel: string;
  lavatory: string;
  foodService: string;
  open: string;
  lastUpdated: string;
}
/** Ontario's rest-area list also holds its truck inspection stations and their lay-bys. */
const ONTARIO_TYPES: Record<string, [string, string]> = {
  "Picnic Park": ["rest_area", "picnic"],
  "Rest Area": ["rest_area", "rest_area"],
  "Service Centre": ["rest_area", "service_area"],
  "Scenic Lookout": ["rest_area", "viewpoint"],
  "Truck Inspection Station": ["weigh_station", "inspection_station"],
  "TIS Lay-by Area": ["weigh_station", "control_area"],
};
const MONTHS: Record<string, string> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};
const monthDay = (s: string) => {
  const [month, day] = s.trim().split(" ");
  return `${MONTHS[month!]}-${day!.padStart(2, "0")}`;
};
const dayShift = (md: string, days: number) =>
  new Date(Date.parse(`2001-${md}T00:00:00Z`) + days * 86400000).toISOString().slice(5, 10);

/**
 * Ontario publishes when a site is open ("May 15 to October 15"); the model
 * keeps when it is closed, the complement. Seasons named by holidays stay
 * the source's words. `lastUpdated` is `YY-M-D h:mm AM`, Eastern time.
 */
function ontarioSeason(open: string) {
  if (open === "Year-round") return {};
  const m = /^(\w+ \d+) (?:to|-) (\w+ \d+)$/.exec(open);
  if (m !== null && MONTHS[m[1]!.split(" ")[0]!] && MONTHS[m[2]!.split(" ")[0]!]) {
    return {
      seasonalClosure: { from: dayShift(monthDay(m[2]!), 1), to: dayShift(monthDay(m[1]!), -1) },
    };
  }
  return { season: en(open) };
}
function ontarioTime(value: string) {
  const [d, t, half] = value.split(" ");
  const [yy, mo, dd] = d!.split("-");
  const [h, mi] = t!.split(":");
  return zoned(
    `20${yy}-${mo!.padStart(2, "0")}-${dd!.padStart(2, "0")}`,
    clock(h!, mi!, half!),
    "America/Toronto",
  );
}
const COMPASS: Record<string, string> = {
  Northbound: "N",
  Southbound: "S",
  Eastbound: "E",
  Westbound: "W",
};

/**
 * Ontario 511 rest areas carry no coordinates, only the highway, direction
 * and a description. Their status is the source's word even where a comment
 * contradicts it ("This site is closed as of April 21, 2025" on an open
 * service centre): the record keeps what was published.
 */
function ontarioRestAreas() {
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const r of json("on511-rest-areas.json").data as OntarioRow[]) {
    const [kind, type] = ONTARIO_TYPES[r.type]!;
    const compass = COMPASS[r.direction];
    const direction =
      compass === undefined
        ? { value: "both", basis: "text", text: r.direction }
        : { value: "unknown", basis: "compass", compass };
    const amenities = [
      ...(r.lavatory === "Y" ? ["toilets"] : []),
      ...(r.fuel === "Y" ? ["petrol_station"] : []),
      ...(r.foodService === "Not Available" ? [] : ["restaurant"]),
    ];
    const site = feature(
      provenance(
        "ca-on-511-events",
        "ibi511-web",
        r.name,
        "Ontario Ministry of Transportation",
        "LicenseRef-OGL-ON",
      ),
      kind,
      {
        ...at(null),
        roads: [{ ref: r.roadway }],
        direction,
        admin: { country: "CA", subdivision: "CA-ON" },
      },
      {
        type,
        name: en(r.name),
        ...(amenities.length > 0 ? { amenities } : {}),
        details:
          kind === "rest_area"
            ? { kind, v: 1, ...ontarioSeason(r.open) }
            : { kind, v: 1, directions: [direction] },
      },
    );
    features.push(site);
    observations.push(
      observation(site, {
        property: "facility.open_status",
        result: category(
          r.status === "Open" ? "open" : r.status === "Closed" ? "closed" : "unknown",
          "facility_open_status",
        ),
        at: ontarioTime(r.lastUpdated),
      }),
    );
  }
  return { features, observations };
}

interface IowaScale {
  properties: {
    INVENTORY_ID: string;
    ADDRESS: string;
    ROUTE: string;
    MILEPOST: number;
    TRAVEL_DIRECTION: string;
    NUM_TRUCK_PARKING: number;
  };
  geometry: { type: string; coordinates: number[] };
}
/** Iowa DOT weigh scales: the building register, with the direction it serves. */
function iowaWeighStations() {
  const compass: Record<string, string> = { NB: "N", SB: "S", EB: "E", WB: "W" };
  return (json("iowa-weigh-scales.geojson").features as IowaScale[]).map((f) => {
    const p = f.properties;
    const direction = { value: "unknown", basis: "compass", compass: compass[p.TRAVEL_DIRECTION] };
    return feature(
      provenance("us-ia-weigh-scales", "arcgis", p.INVENTORY_ID, "Iowa DOT", "CC-BY-4.0"),
      "weigh_station",
      {
        ...at(f.geometry),
        roads: [{ ref: p.ROUTE }],
        linear: { system: "milepost", ref: p.ROUTE, from: p.MILEPOST },
        direction,
        admin: { country: "US", subdivision: "US-IA" },
      },
      {
        type: "inspection_station",
        name: en(p.ADDRESS),
        externalIds: [{ scheme: "provider", id: p.INVENTORY_ID, authority: "Iowa DOT" }],
        details: {
          kind: "weigh_station",
          v: 1,
          directions: [direction],
          truckSpaces: p.NUM_TRUCK_PARKING,
        },
      },
    );
  });
}

/** NVDB ferry connections and quays, which carry the NeTEx ids the national timetable uses. */
function nvdbFerries() {
  const routes = nvdb("nvdb-ferry-routes.json").map((o) => {
    const from = prop(o, "Drift fra dato");
    const to = prop(o, "Drift til dato");
    return feature(nvdbProvenance(o), "ferry_route", nvdbLocation(o), {
      name: nb(prop(o, "Navn")!),
      lifecycle: prop(o, "Driftsstatus") === "Nedlagt" ? "decommissioned" : "operational",
      externalIds: [{ scheme: "netex:line", id: prop(o, "NeTEx_id")! }],
      ...(prop(o, "AutoPASS for ferje") === "Ja"
        ? { access: { audience: "public", payment: ["rfid"] } }
        : {}),
      details: {
        kind: "ferry_route",
        v: 1,
        vehicleCapable: true,
        operatorRoute: String(prop(o, "FDB_Ferjesambands_Id")),
        ...(from && to ? { season: { from, to } } : {}),
      },
    });
  });
  const quays = nvdb("nvdb-ferry-quays.json").map((o) => {
    const berths = prop<number>(o, "Antall ferjelemmer");
    return feature(nvdbProvenance(o), "ferry_terminal", nvdbLocation(o), {
      name: nb(prop(o, "Navn")!),
      lifecycle: prop(o, "Driftsstatus") === "Nedlagt" ? "decommissioned" : "operational",
      externalIds: [{ scheme: "netex:stop_place", id: prop(o, "NSR_Stopplace_ID")! }],
      details: { kind: "ferry_terminal", v: 1, ...(berths === undefined ? {} : { berths }) },
    });
  });
  return [...routes, ...quays];
}

interface OntarioFerry {
  DT_RowId: string;
  lastUpdated: string;
  filterAndOrderProperty1: string;
  filterAndOrderProperty2: string;
  filterAndOrderProperty4: string;
}
const ONTARIO_FERRY_STATUSES: Record<string, string> = {
  "In Service": "running",
  "Not In Service": "suspended",
  "No Status Available": "unknown",
};

/** Ontario 511 ferries: one record per service, with its state and no coordinates. */
function ontarioFerries() {
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const r of json("on511-ferries.json").data as OntarioFerry[]) {
    const route = feature(
      provenance(
        "ca-on-511-ferries",
        "ibi511-web",
        r.DT_RowId,
        "Ontario Ministry of Transportation",
        "LicenseRef-OGL-ON",
      ),
      "ferry_route",
      { ...at(null, "linear"), admin: { country: "CA", subdivision: "CA-ON" } },
      {
        name: en(r.filterAndOrderProperty1),
        operator: { role: "operator", name: en(r.filterAndOrderProperty4) },
        details: { kind: "ferry_route", v: 1 },
      },
    );
    features.push(route);
    observations.push(
      observation(route, {
        property: "ferry.status",
        result: category(ONTARIO_FERRY_STATUSES[r.filterAndOrderProperty2]!, "ferry_status"),
        at: ontarioTime(r.lastUpdated),
      }),
    );
  }
  return { features, observations };
}

interface WsfTerminal {
  TerminalID: number;
  TerminalName: string;
  DepartingSpaces: {
    Departure: string;
    IsCancelled: boolean;
    SpaceForArrivalTerminals: { DisplayDriveUpSpace: boolean; DriveUpSpaceCount: number | null }[];
  }[];
}
/** WCF `/Date(ms±hhmm)/` → an instant with that offset. */
function wcfDate(value: string): string {
  const [, ms, sign, hh, mm] = /\/Date\((-?\d+)([+-])(\d{2})(\d{2})\)\//.exec(value)!;
  const offsetMin = (sign === "-" ? -1 : 1) * (Number(hh) * 60 + Number(mm));
  const local = new Date(Number(ms) + offsetMin * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

/**
 * WSF reports, per departing terminal, each departure's drive-up space and
 * whether it is cancelled, naming no route; the terminal is the subject and
 * the departure the qualifier. The payload holds no time of its own, so the
 * capture time is the phenomenon time.
 */
function wsfSailings() {
  const features: (Draft & Feature)[] = [];
  const observations: Draft[] = [];
  for (const t of json("wsf-terminal-sailing-space.json") as WsfTerminal[]) {
    const terminal = feature(
      provenance(
        "us-wa-wsf",
        "wsf",
        String(t.TerminalID),
        "Washington State Ferries",
        "WSDOT-traveler-information",
      ),
      "ferry_terminal",
      { ...at(null), admin: { country: "US", subdivision: "US-WA" } },
      { name: en(t.TerminalName), details: { kind: "ferry_terminal", v: 1 } },
    );
    features.push(terminal);
    for (const d of t.DepartingSpaces) {
      const qualifiers = { departure: wcfDate(d.Departure) };
      observations.push(
        observation(terminal, {
          property: "ferry.status",
          result: category(d.IsCancelled ? "cancelled" : "running", "ferry_status"),
          at: FETCHED,
          qualifiers,
        }),
      );
      const space = d.SpaceForArrivalTerminals[0];
      if (space?.DisplayDriveUpSpace && space.DriveUpSpaceCount !== null) {
        observations.push(
          observation(terminal, {
            property: "ferry.vehicle_space",
            result: { type: "count", value: space.DriveUpSpaceCount },
            at: FETCHED,
            qualifiers,
          }),
        );
      }
    }
  }
  return { features, observations };
}

describe("roadside fit", () => {
  it("seals every CBP crossing with its queues and open status", () => {
    const { features, observations } = cbpCrossings();
    expect(sealAll([...features, ...observations])).toEqual([]);
  });

  it("gives a queue CBP marks N/A no lane group at all", () => {
    const alexandria = cbpCrossings().features.find((f) => f.provenance.recordId === "070801")!;
    expect((alexandria["components"] as { key: string }[]).map((c) => c.key)).toEqual([
      "commercial/standard",
      "passenger/standard",
      "passenger/trusted_traveller",
    ]);
  });

  it("keeps a few minutes under no delay, and an unknown when the update is pending", () => {
    const { observations } = cbpCrossings();
    const waits = observations
      .filter((o) => o["property"] === "border.wait")
      .map(
        (o) => o["result"] as { type: string; value?: { status: string; waitMinutes?: number } },
      );
    expect(
      waits.some((r) => r.value?.status === "no_delay" && (r.value.waitMinutes ?? 0) > 0),
    ).toBe(true);
    expect(waits.filter((r) => r.type === "unknown")).toHaveLength(14);
  });

  it("dates an Arizona queue by the port's zone, not by the label it prints", () => {
    const { observations } = cbpCrossings();
    const douglas = observations.find(
      (o) =>
        o["property"] === "border.wait" &&
        (o["subject"] as { featureId: string; componentKey: string }).featureId.endsWith(
          ":260101",
        ) &&
        (o["subject"] as { componentKey: string }).componentKey === "commercial/standard",
    )!;
    expect(douglas["phenomenonTime"]).toEqual({ instant: "2026-09-29T14:00:00-07:00" });
  });

  it("seals CBSA's Canada-bound queues, keyed by office name", () => {
    const { features, observations } = cbsaCrossings();
    expect(sealAll([...features, ...observations])).toEqual([]);
    expect(
      features.every((f) => (f["details"] as { countries: string[] }).countries.includes("CA")),
    ).toBe(true);
  });

  it("puts each rest area's car park inside it, and builds the tree", () => {
    const features = nvdbRestAreas();
    expect(sealAll(features)).toEqual([]);
    const tree = partOfTree(features as never);
    expect(tree.issues).toEqual([]);
    expect(tree.roots).toHaveLength(4);
    for (const root of tree.roots) expect(tree.parts.get(root)).toHaveLength(1);
  });

  it("reads rest-area amenities from NVDB's child objects", () => {
    const withToilets = nvdbRestAreas().find((f) => f.provenance.recordId === "80194767")!;
    expect(withToilets["amenities"]).toEqual(["picnic_facilities", "toilets", "refuse_bin"]);
  });

  it("seals Ontario's rest areas, and its inspection stations as weigh stations", () => {
    const { features, observations } = ontarioRestAreas();
    expect(sealAll([...features, ...observations])).toEqual([]);
    expect(features.filter((f) => f["kind"] === "weigh_station")).toHaveLength(2);
    const actinolite = features.find((f) => f.provenance.recordId.startsWith("Actinolite"))!;
    expect(actinolite["details"]).toMatchObject({
      seasonalClosure: { from: "10-16", to: "05-14" },
    });
  });

  it("records a service centre as open because the status says so, whatever its comment says", () => {
    const { observations } = ontarioRestAreas();
    const maple = observations.find((o) =>
      (o["subject"] as { featureId: string }).featureId.includes("Maple Service Centre"),
    )!;
    expect(maple["result"]).toEqual(category("open", "facility_open_status"));
  });

  it("seals weigh stations from both registers", () => {
    expect(sealAll([...nvdbWeighStations(), ...iowaWeighStations()])).toEqual([]);
  });

  it("seals ferry connections and quays with their national timetable ids", () => {
    expect(sealAll(nvdbFerries())).toEqual([]);
  });

  it("observes whether an Ontario ferry service runs", () => {
    const { features, observations } = ontarioFerries();
    expect(sealAll([...features, ...observations])).toEqual([]);
    expect(observations.map((o) => (o["result"] as { value: string }).value)).toEqual([
      "suspended",
      "running",
      "running",
      "unknown",
      "unknown",
    ]);
  });

  it("observes each WSF departure's status and drive-up space on its terminal", () => {
    const { features, observations } = wsfSailings();
    expect(sealAll([...features, ...observations])).toEqual([]);
    expect(observations.filter((o) => o["property"] === "ferry.vehicle_space")).toHaveLength(2);
  });
});
