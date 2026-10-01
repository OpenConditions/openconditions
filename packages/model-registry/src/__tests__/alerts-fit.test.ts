import { readFileSync } from "node:fs";
import {
  buildRegistry,
  extendVocabulary,
  type RegistryModule,
  sealRecord,
} from "@openconditions/model";
import {
  type CapPair,
  capCircle,
  capClassification,
  capPolygon,
  capReferences,
  hazardsCrosswalk,
} from "@openconditions/model-hazards";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Alerts fit check: real CAP messages from four publishers, mapped onto
 * `alert` situations and sealed against the production registry. Captured
 * 2026-09-30 and 2026-10-01 from:
 * - the U.S. National Weather Service alerts API (CAP 1.2 per alert;
 *   public domain);
 * - Deutscher Wetterdienst open data, CAP warnings per district in every
 *   language DWD publishes (CC BY 4.0), captured 2026-09-29;
 * - Environment and Climate Change Canada's CAP datamart (ECCC Data
 *   Servers End-use Licence);
 * - MeteoAlarm's warnings API, the CAP of Météo-France, MET Norway and
 *   AEMET as JSON (CC BY 4.0 with MeteoAlarm's redistribution terms).
 * OpenConditions parses no CAP yet, so a test-only module registers the
 * formats, and the mapper below is the specification of the CAP parser.
 */
const fitFormats: RegistryModule = {
  name: "alerts-fit",
  entries: [extendVocabulary({ vocabulary: "source_format", values: ["cap", "meteoalarm-json"] })],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const FETCHED = "2026-10-01T00:30:00Z";

const utf8 = (name: string) =>
  readFileSync(new URL(`./fixtures/alerts/${name}`, import.meta.url), "utf8");

type Draft = Record<string, unknown>;

/** A CAP message in CAP's own shape: every repeatable element a list, every value a string. */
interface CapArea {
  areaDesc: string;
  polygon?: string[];
  circle?: string[];
  geocode?: CapPair[];
}
interface CapInfo {
  language?: string;
  category: string[];
  event: string;
  responseType?: string[];
  urgency: string;
  severity: string;
  certainty: string;
  audience?: string;
  eventCode?: CapPair[];
  effective?: string;
  onset?: string;
  expires?: string;
  senderName?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  web?: string;
  contact?: string;
  parameter?: CapPair[];
  area?: CapArea[];
}
interface CapAlert {
  identifier: string;
  sender: string;
  sent: string;
  status: string;
  msgType: string;
  scope: string;
  code?: string[];
  references?: string;
  info?: CapInfo[];
}

const REPEATED = new Set([
  "code",
  "info",
  "category",
  "responseType",
  "eventCode",
  "parameter",
  "area",
  "polygon",
  "circle",
  "geocode",
]);

/** CAP XML → the same shape MeteoAlarm serves as JSON. */
function capXml(name: string): CapAlert {
  return new XMLParser({
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (tag) => REPEATED.has(tag),
  }).parse(utf8(name)).alert as CapAlert;
}

interface CapSource {
  sourceId: string;
  sourceFormat: string;
  provider: string;
  license: string;
  country: string;
}

/** CAP geocode names → the registry's admin geocode schemes; the rest are not areas. */
const GEOCODE_SCHEMES: Record<string, string> = {
  SAME: "same",
  UGC: "ugc",
  WARNCELLID: "warncellid",
  EMMA_ID: "emma_id",
  NUTS2: "nuts",
  NUTS3: "nuts",
  "profile:CAP-CP:Location:0.3": "sgc",
  "layer:EC-MSC-SMC:1.0:CLC": "eccc_clc",
};

const text = (infos: readonly CapInfo[], pick: (i: CapInfo) => string | undefined) => {
  const parts = infos.flatMap((i) => {
    const value = pick(i)?.trim();
    return value ? [{ lang: i.language ?? "en-US", text: value }] : [];
  });
  return parts.length > 0 ? parts : undefined;
};

type Pos = [number, number];

/** Ray casting: whether a point lies inside a ring. */
function pointIn([x, y]: Pos, ring: readonly Pos[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * An info block's areas as one geometry. Polygons are the source's; DWD
 * sends the islands and lakes a district's outline does not cover as
 * `EXCLUDE_POLYGON` geocodes, which become holes of the polygon they lie
 * in. A circle, and a polygon split at the antimeridian, is derived; an
 * area with only geocodes has no geometry.
 */
function capGeometry(areas: readonly CapArea[]) {
  const polygons: Pos[][][] = [];
  let derived = false;
  const shapes: object[] = [];
  for (const a of areas) {
    const holes = (a.geocode ?? [])
      .filter((g) => g.valueName === "EXCLUDE_POLYGON")
      .flatMap((g) => capPolygon(g.value) ?? []);
    for (const p of a.polygon ?? []) {
      const rings = capPolygon(p);
      if (rings === null) continue;
      if (rings.length > 1) derived = true;
      for (const ring of rings) {
        polygons.push([ring, ...holes.filter((h) => pointIn(h[0]!, ring))]);
      }
    }
    for (const c of a.circle ?? []) {
      const shape = capCircle(c);
      if (shape === null) continue;
      derived = true;
      if (shape.type === "Polygon") polygons.push(shape.coordinates);
      else shapes.push(shape);
    }
  }
  const all = [
    ...(polygons.length === 1 ? [{ type: "Polygon", coordinates: polygons[0] }] : []),
    ...(polygons.length > 1 ? [{ type: "MultiPolygon", coordinates: polygons }] : []),
    ...shapes,
  ];
  const geometry =
    all.length === 0
      ? null
      : all.length === 1
        ? all[0]!
        : { type: "GeometryCollection", geometries: all };
  return { geometry, derived };
}

function capLocation(infos: readonly CapInfo[], country: string) {
  const areas = infos[0]!.area ?? [];
  const { geometry, derived } = capGeometry(areas);
  const geocodes = areas.flatMap((a) =>
    (a.geocode ?? []).flatMap((g) =>
      GEOCODE_SCHEMES[g.valueName] === undefined
        ? []
        : [{ scheme: GEOCODE_SCHEMES[g.valueName]!, code: g.value }],
    ),
  );
  if (areas.length === 0) {
    return { geometry: null, extent: "none", geometryOrigin: "none", fuzziness: "extent_unknown" };
  }
  const description = text(infos, (i) => (i.area ?? []).map((a) => a.areaDesc).join("; "));
  return {
    geometry,
    extent: "area",
    geometryOrigin: geometry === null ? "none" : derived ? "derived" : "source",
    fuzziness: "exact",
    admin: geocodes.length > 0 ? { country, geocodes } : { country },
    ...(description === undefined ? {} : { areaDescription: description }),
  };
}

/**
 * What makes two info blocks one situation: everything but their language's
 * words. The hazard they warn of counts too, read as `capClassification`
 * reads it, because MeteoAlarm states it only in a parameter, and the other
 * parameters are translated.
 */
const signature = (i: CapInfo) =>
  JSON.stringify([
    capClassification(i.eventCode ?? [], i.parameter ?? []),
    i.category,
    i.eventCode?.filter((e) => e.valueName !== "LICENSE"),
    i.responseType,
    i.urgency,
    i.severity,
    i.certainty,
    i.effective,
    i.onset,
    i.expires,
    (i.area ?? []).map((a) => [a.polygon, a.circle, a.geocode]),
  ]);

const iso = (s: string | undefined) => s?.trim();

/**
 * A warning is in force from when its message takes effect (`effective`,
 * which CAP defaults to `sent`) until the message expires. The event it
 * warns of may begin later, even after the message expires (an NWS watch
 * is reissued before its hazard starts), so `onset` stays in the details.
 * A message that expires before it takes effect is in force for no time.
 */
function capValidity(alert: CapAlert, info: CapInfo, allClear: boolean) {
  const end = iso(info.expires);
  let start = iso(info.effective ?? alert.sent)!;
  if (end !== undefined && Date.parse(start) > Date.parse(end)) start = end;
  const status = alert.msgType === "Cancel" ? "cancelled" : allClear ? "ended" : "active";
  return {
    status,
    start,
    ...(end === undefined ? {} : { end }),
    ...(status === "cancelled"
      ? { endedReason: "cancelled" }
      : status === "ended"
        ? { endedReason: "source_ended" }
        : {}),
  };
}

const RELATION_OF: Record<string, string> = {
  Update: "update_of",
  Cancel: "cancels",
  Ack: "related",
  Error: "related",
};

function capSituations(alert: CapAlert, source: CapSource): Draft[] {
  const groups = new Map<string, CapInfo[]>();
  for (const info of alert.info ?? []) {
    const key = signature(info);
    groups.set(key, [...(groups.get(key) ?? []), info]);
  }
  const references = alert.references === undefined ? [] : capReferences(alert.references);
  const root = [...references].sort((a, b) => Date.parse(a.sent) - Date.parse(b.sent))[0];
  const value = (vocabulary: string, token: string) =>
    hazardsCrosswalk.value(vocabulary, "cap", token.trim());
  return [...groups.values()].map((infos, n) => {
    const info = infos[0]!;
    // The first hazard keeps the message's id, so a reference to the message names a record;
    // the parser cancels or updates every situation of that message (`provenance.recordId`).
    const localId = n === 0 ? alert.identifier : `${alert.identifier}#${n + 1}`;
    const c = capClassification(info.eventCode ?? [], info.parameter ?? []) ?? {
      kind: "alert",
      type: "other",
    };
    const responseType = (info.responseType ?? []).map((r) => value("cap_response_type", r)!);
    const validity = capValidity(alert, info, responseType.includes("all_clear"));
    const label = value("severity", info.severity)!;
    const prov = {
      origin: "feed",
      sourceId: source.sourceId,
      sourceFormat: source.sourceFormat,
      accessMode: "bulk",
      recordId: alert.identifier,
      sourceUpdatedAt: iso(alert.sent),
      attribution: { provider: source.provider, license: source.license },
      privacy: { class: "authoritative" },
    };
    const onset = iso(info.onset);
    return {
      id: `oc:situation:${source.sourceId}:${localId}`,
      class: "situation",
      kind: c.kind,
      type: c.type,
      ...(c.subtype === undefined ? {} : { subtype: c.subtype }),
      // A warning of an event that has not begun when it is sent is a forecast.
      temporality:
        onset !== undefined && Date.parse(onset) > Date.parse(alert.sent) ? "forecast" : "live",
      externalIds: [{ scheme: "cap", id: alert.identifier, authority: alert.sender }],
      location: capLocation(infos, source.country),
      ...(references.length > 0
        ? {
            relations: references.map((r) => ({
              relation: RELATION_OF[alert.msgType]!,
              ref: { class: "situation", id: `oc:situation:${source.sourceId}:${r.identifier}` },
            })),
          }
        : {}),
      provenance: prov,
      freshness: { fetchedAt: FETCHED },
      planned: false,
      certainty: value("certainty", info.certainty)!,
      severity:
        label === "unknown"
          ? { label, declaredRaw: info.severity }
          : { label, source: "declared", declaredRaw: info.severity },
      ...(text(infos, (i) => i.headline) === undefined
        ? {}
        : { headline: text(infos, (i) => i.headline) }),
      ...(text(infos, (i) => i.description) === undefined
        ? {}
        : { description: text(infos, (i) => i.description) }),
      ...(text(infos, (i) => i.instruction) === undefined
        ? {}
        : { instruction: text(infos, (i) => i.instruction) }),
      validity,
      effects: [],
      // One message sees only the references it lists, often just the message before it; the
      // parser resolves the chain's root from the stored predecessor's groupId, and an original
      // warning names itself, so its updates join its group.
      groupId: root?.identifier ?? alert.identifier,
      details: {
        kind: "alert",
        v: 1,
        cap: {
          identifier: alert.identifier,
          sender: alert.sender,
          sent: iso(alert.sent),
          status: value("cap_status", alert.status),
          msgType: value("cap_msg_type", alert.msgType),
          scope: value("cap_scope", alert.scope),
          ...(references.length > 0
            ? { references: references.map((r) => ({ ...r, sent: iso(r.sent) })) }
            : {}),
          ...(alert.code === undefined ? {} : { codes: alert.code }),
          category: info.category.map((x) => value("cap_category", x)),
          event: text(infos, (i) => i.event),
          ...((info.eventCode ?? []).length === 0 ? {} : { eventCodes: info.eventCode }),
          ...(responseType.length > 0 ? { responseType } : {}),
          urgency: value("cap_urgency", info.urgency),
          severity: value("cap_severity", info.severity),
          certainty: value("cap_certainty", info.certainty),
          ...(text(infos, (i) => i.audience) === undefined
            ? {}
            : { audience: text(infos, (i) => i.audience) }),
          ...(info.effective === undefined ? {} : { effective: iso(info.effective) }),
          ...(info.onset === undefined ? {} : { onset: iso(info.onset) }),
          ...((info.parameter ?? []).length === 0 ? {} : { parameters: info.parameter }),
          ...(info.web === undefined ? {} : { web: info.web.trim() }),
          ...(text(infos, (i) => i.senderName) === undefined
            ? {}
            : { senderName: text(infos, (i) => i.senderName) }),
          ...(text(infos, (i) => i.contact) === undefined
            ? {}
            : { contact: text(infos, (i) => i.contact) }),
        },
      },
    };
  });
}

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

const NWS: CapSource = {
  sourceId: "us-nws",
  sourceFormat: "cap",
  provider: "National Weather Service",
  license: "public-domain",
  country: "US",
};
const DWD: CapSource = {
  sourceId: "de-dwd",
  sourceFormat: "cap",
  provider: "Deutscher Wetterdienst",
  license: "CC-BY-4.0",
  country: "DE",
};
const ECCC: CapSource = {
  sourceId: "ca-eccc",
  sourceFormat: "cap",
  provider: "Environment and Climate Change Canada",
  license: "ECCC-data-servers-end-use-licence",
  country: "CA",
};
const meteoalarm = (country: string): CapSource => ({
  sourceId: "eu-meteoalarm",
  sourceFormat: "meteoalarm-json",
  provider: "MeteoAlarm",
  license: "CC-BY-4.0",
  country,
});

const nws = (name: string) => capSituations(capXml(name), NWS);
const meteoalarmAlerts = (
  JSON.parse(utf8("meteoalarm-warnings.json")) as {
    warnings: { alert: CapAlert }[];
  }
).warnings.map((w) => w.alert);
/** MeteoAlarm identifiers carry the ISO 3166 numeric code of their country (`.250.` France). */
const COUNTRY_OF: Record<string, string> = { "250": "FR", "578": "NO", "724": "ES" };
const meteoalarmSituations = meteoalarmAlerts.flatMap((a) =>
  capSituations(a, meteoalarm(COUNTRY_OF[a.identifier.split(".")[4]!]!)),
);

const byKind = (records: readonly Draft[]) =>
  records.map((r) => [r["type"], r["subtype"]].filter(Boolean).join("."));

describe("alerts fit check", () => {
  it("maps NWS alerts, classified by their VTEC phenomenon", () => {
    const records = [
      "nws-tornado-warning.xml",
      "nws-flood-warning.xml",
      "nws-flood-watch.xml",
      "nws-tropical-storm-warning.xml",
      "nws-extreme-heat-watch.xml",
    ].flatMap(nws);
    expect(sealAll(records)).toEqual([]);
    expect(byKind(records)).toEqual([
      "thunderstorm.tornado",
      "flood",
      "flood",
      "tropical_cyclone.tropical_storm",
      "heat.extreme",
    ]);
  });

  it("keeps a tornado warning's update as an update of the warning it continues", () => {
    const [tornado] = nws("nws-tornado-warning.xml") as [Draft];
    expect(tornado["severity"]).toEqual({
      label: "critical",
      source: "declared",
      declaredRaw: "Extreme",
    });
    expect(tornado["certainty"]).toBe("observed");
    expect(tornado["relations"]).toEqual([
      {
        relation: "update_of",
        ref: {
          class: "situation",
          id: "oc:situation:us-nws:urn:oid:2.49.0.1.840.0.93490fce2a191c24d1f347aa7be723bfaccb940a.001.1",
        },
      },
    ]);
    expect(tornado["groupId"]).toBe(
      "urn:oid:2.49.0.1.840.0.93490fce2a191c24d1f347aa7be723bfaccb940a.001.1",
    );
    const location = tornado["location"] as { geometry: { type: string }; admin: object };
    expect(location.geometry.type).toBe("Polygon");
    expect(location.admin).toEqual({
      country: "US",
      geocodes: [
        { scheme: "same", code: "020105" },
        { scheme: "same", code: "020167" },
        { scheme: "ugc", code: "KSC105" },
        { scheme: "ugc", code: "KSC167" },
      ],
    });
  });

  it("keeps a watch for later days as a forecast, and a zone watch without a polygon by its zones", () => {
    const [heat] = nws("nws-extreme-heat-watch.xml") as [Draft];
    expect(heat["temporality"]).toBe("forecast");
    const [watch] = nws("nws-flood-watch.xml") as [Draft];
    const location = watch["location"] as { geometry: unknown; geometryOrigin: string };
    expect(location.geometry).toBeNull();
    expect(location.geometryOrigin).toBe("none");
  });

  it("maps DWD warnings in every language, with islands cut out of the coast", () => {
    const storm = capSituations(capXml("dwd-thunderstorm.xml"), DWD);
    const coast = capSituations(capXml("dwd-coastal-gusts-mul.xml"), DWD);
    expect(sealAll([...storm, ...coast])).toEqual([]);
    expect(byKind([...storm, ...coast])).toEqual(["thunderstorm", "wind.strong_wind"]);
    const [gusts] = coast as [Draft];
    const event = (gusts["details"] as { cap: { event: { lang: string; text: string }[] } }).cap
      .event;
    expect(event.map((t) => t.lang)).toEqual(["de-DE", "en", "fr", "es", "ar", "ru", "tr", "pl"]);
    expect(event[1]).toEqual({ lang: "en", text: "near gale" });
    const geometry = (gusts["location"] as { geometry: { type: string; coordinates: unknown[][] } })
      .geometry;
    expect(geometry.type).toBe("Polygon");
    expect(geometry.coordinates).toHaveLength(10);
    // The German block's instruction is empty and the translations' is not; an empty element is no text.
    const instruction = gusts["instruction"] as { lang: string }[];
    expect(instruction.map((t) => t.lang)).toEqual(["en", "fr", "es", "ar", "ru", "tr", "pl"]);
  });

  it("maps ECCC's bilingual alerts and ends the storm surge on its all-clear", () => {
    const records = ["eccc-storm-surge.xml", "eccc-storm-surge-ended.xml", "eccc-fog.xml"].flatMap(
      (f) => capSituations(capXml(f), ECCC),
    );
    expect(sealAll(records)).toEqual([]);
    expect(byKind(records)).toEqual(["coastal.storm_surge", "coastal.storm_surge", "other"]);
    const [surge, ended, fog] = records as [Draft, Draft, Draft];
    expect((surge["relations"] as unknown[]).length).toBe(2);
    expect((surge["validity"] as { status: string }).status).toBe("active");
    expect(ended["validity"]).toMatchObject({ status: "ended", endedReason: "source_ended" });
    const details = fog["details"] as { cap: { event: unknown; category: string[] } };
    expect(details.cap.event).toEqual([
      { lang: "en-CA", text: "fog" },
      { lang: "fr-CA", text: "brouillard" },
    ]);
    expect((surge["details"] as { cap: { category: string[] } }).cap.category).toEqual([
      "env",
      "met",
    ]);
  });

  it("maps MeteoAlarm warnings, including an all-clear that names no area", () => {
    expect(sealAll(meteoalarmSituations)).toEqual([]);
    expect(byKind(meteoalarmSituations)).toEqual([
      "flood.rain",
      "flood.rain",
      "flood",
      "wind",
      "avalanche",
    ]);
    const allClear = meteoalarmSituations[1]!;
    expect(allClear["location"]).toEqual({
      geometry: null,
      extent: "none",
      geometryOrigin: "none",
      fuzziness: "extent_unknown",
    });
    expect(allClear["validity"]).toEqual({
      status: "ended",
      start: "2026-09-30T22:00:00+02:00",
      end: "2026-09-30T22:00:00+02:00",
      endedReason: "source_ended",
    });
    const france = meteoalarmSituations[2]!["location"] as { admin: object; geometry: unknown };
    expect(france.geometry).toBeNull();
    expect(france.admin).toEqual({
      country: "FR",
      geocodes: [
        { scheme: "nuts", code: expect.stringMatching(/^FR/) },
        { scheme: "nuts", code: expect.stringMatching(/^FR/) },
      ],
    });
  });
});

/**
 * What CAP allows and these messages do not show, each made from a real
 * message by one change.
 */
describe("alerts fit check, cases the captures lack", () => {
  const tornado = () => capXml("nws-tornado-warning.xml");

  it("splits a message whose info blocks warn of two hazards into two situations of one group", () => {
    const alert = tornado();
    const hail = {
      ...alert.info![0]!,
      eventCode: [{ valueName: "SAME", value: "SVR" }],
      parameter: [],
    };
    const records = capSituations({ ...alert, info: [alert.info![0]!, hail] }, NWS);
    expect(sealAll(records)).toEqual([]);
    // The first part keeps the message's own id, so a later reference to the message resolves.
    expect(records.map((r) => r["id"])).toEqual([
      `oc:situation:us-nws:${alert.identifier}`,
      `oc:situation:us-nws:${alert.identifier}#2`,
    ]);
    expect(byKind(records)).toEqual(["thunderstorm.tornado", "thunderstorm.severe"]);
    expect(new Set(records.map((r) => r["groupId"])).size).toBe(1);
  });

  it("splits a MeteoAlarm message whose hazards differ only in their awareness type", () => {
    const [france] = meteoalarmAlerts.filter((a) => a.identifier.includes(".FR.")) as [CapAlert];
    const awareness = (info: CapInfo, type: string) => ({
      ...info,
      parameter: (info.parameter ?? []).map((p) =>
        p.valueName === "awareness_type" ? { ...p, value: type } : p,
      ),
    });
    const info = france.info![0]!;
    const records = capSituations(
      { ...france, info: [awareness(info, "1; Wind"), awareness(info, "10; Rain")] },
      meteoalarm("FR"),
    );
    expect(sealAll(records)).toEqual([]);
    expect(byKind(records)).toEqual(["wind", "rain"]);
  });

  it("groups an original warning with its updates", () => {
    const [original] = capSituations(capXml("dwd-thunderstorm.xml"), DWD) as [Draft];
    expect(original["groupId"]).toBe(
      (original["details"] as { cap: { identifier: string } }).cap.identifier,
    );
  });

  it("keeps a cancellation as a cancelled situation that cancels the warning", () => {
    const [cancel] = capSituations({ ...tornado(), msgType: "Cancel" }, NWS) as [Draft];
    expect(sealAll([cancel])).toEqual([]);
    expect(cancel["validity"]).toMatchObject({ status: "cancelled", endedReason: "cancelled" });
    expect((cancel["relations"] as { relation: string }[])[0]!.relation).toBe("cancels");
  });

  it("never inverts the validity of a message that expires before it takes effect", () => {
    const alert = tornado();
    const late = { ...alert.info![0]!, effective: "2026-09-30T19:30:00-05:00" };
    const [record] = capSituations({ ...alert, info: [late] }, NWS) as [Draft];
    expect(sealAll([record])).toEqual([]);
    expect(record["validity"]).toMatchObject({
      start: "2026-09-30T19:00:00-05:00",
      end: "2026-09-30T19:00:00-05:00",
    });
  });
});
