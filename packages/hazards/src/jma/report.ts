import { XMLParser, XMLValidator } from "fast-xml-parser";

const NS = "http://xml.kishou.go.jp/jmaxml1/";
export const JMA_FAMILIES = [
  "VXSE51",
  "VXSE52",
  "VXSE53",
  "VPWW55",
  "VPWW56",
  "VPWW57",
  "VFVO50",
] as const;
export type JmaFamily = (typeof JMA_FAMILIES)[number];
type Node = Record<string, unknown>;
export interface JmaWarning {
  system: string;
  area: string;
  name: string;
  code: string;
  wording: string;
  status: string;
}
export interface JmaReport {
  family: JmaFamily;
  controlAt: string;
  reportAt: string;
  targetAt?: string;
  validAt?: string;
  eventId: string;
  serial: string;
  infoType: string;
  infoKindVersion: string;
  publishingOffice: string;
  editorialOffice: string;
  title: string;
  headline: string;
  cancelled: boolean;
  operational: boolean;
  earthquake?: {
    originAt?: string;
    position?: [number, number];
    depthM?: number;
    magnitude?: number;
    intensity?: string;
    coordinateRaw?: string;
    coordinateDescription?: string;
    magnitudeDescription?: string;
  };
  nativeXml: string;
  warnings: JmaWarning[];
}
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
});
const node = (value: unknown): Node => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JMA: expected element");
  return value as Node;
};
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" ? text((v as Node)["#text"]) : "";
const required = (v: unknown): string => {
  const t = text(v);
  if (!t.trim()) throw new Error("JMA: required text missing");
  return t;
};
const instant = (v: unknown, optional = false): string | undefined => {
  const s = text(v);
  if (!s && optional) return undefined;
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new Error("JMA: invalid time");
  return s;
};
export function jmaCoordinate(
  raw: string,
  unit: "degree" | "degree-minute",
): [number, number] | undefined {
  if (!raw || raw.includes("NaN")) return undefined;
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\/$/.exec(raw);
  if (!m) throw new Error("JMA: invalid coordinate");
  const convert = (v: string) => {
    const n = Number(v);
    if (unit === "degree") return n;
    const abs = Math.abs(n),
      d = Math.floor(abs / 100),
      minutes = abs - d * 100;
    if (minutes >= 60) throw new Error("JMA: invalid minutes");
    return Math.sign(n) * (d + minutes / 60);
  };
  const lat = convert(m[1]!),
    lon = convert(m[2]!);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("JMA: coordinate outside world");
  return [lon, lat];
}
/** Strict UTF-8, well-formed XML and the native namespaces; no DTD or entity expansion. */
export function readJmaReport(body: Buffer, family: JmaFamily): JmaReport {
  if (!JMA_FAMILIES.includes(family)) throw new Error("JMA: unsupported family");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("JMA: invalid XML");
  const doc = node(parser.parse(xml));
  const r = node(doc["Report"]),
    c = node(r["Control"]),
    h = node(r["Head"]),
    b = node(r["Body"]);
  const bodyNs = family.startsWith("VPWW")
    ? "meteorology1/"
    : family === "VFVO50"
      ? "volcanology1/"
      : "seismology1/";
  if (
    r["@_xmlns"] !== NS ||
    h["@_xmlns"] !== `${NS}informationBasis1/` ||
    b["@_xmlns"] !== `${NS}body/${bodyNs}`
  )
    throw new Error("JMA: unexpected namespace");
  const infoType = required(h["InfoType"]);
  if (!["発表", "訂正", "取消"].includes(infoType)) throw new Error("JMA: unknown InfoType");
  const result: JmaReport = {
    family,
    nativeXml: xml,
    controlAt: instant(c["DateTime"])!,
    reportAt: instant(h["ReportDateTime"])!,
    eventId: text(h["EventID"]),
    serial: text(h["Serial"]),
    infoType,
    infoKindVersion: required(h["InfoKindVersion"]),
    publishingOffice: required(c["PublishingOffice"]),
    editorialOffice: required(c["EditorialOffice"]),
    title: required(h["Title"]),
    headline: h["Headline"] ? text(node(h["Headline"])["Text"]) : "",
    cancelled: infoType === "取消",
    operational: required(c["Status"]) === "通常",
    warnings: [],
  };
  for (const [key, field] of [
    ["TargetDateTime", "targetAt"],
    ["ValidDateTime", "validAt"],
  ] as const) {
    const value = instant(h[key], true);
    if (value) result[field] = value;
  }
  if (family.startsWith("VXSE") && !result.eventId)
    throw new Error("JMA: missing earthquake identity");
  if (result.cancelled) return result;
  if (family.startsWith("VXSE")) {
    const eq = b["Earthquake"] ? node(b["Earthquake"]) : undefined;
    const intensity = b["Intensity"] ? node(b["Intensity"]) : undefined;
    result.earthquake = {};
    if (intensity?.["Observation"]) {
      const max = text(node(intensity["Observation"])["MaxInt"]);
      if (max && !["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7", "不明"].includes(max))
        throw new Error("JMA: unknown intensity");
      if (max) result.earthquake.intensity = max;
    }
    if (eq) {
      const originAt = instant(eq["OriginTime"], true);
      if (originAt) result.earthquake.originAt = originAt;
      const area = node(node(eq["Hypocenter"])["Area"]);
      const coordinate = list(area["jmx_eb:Coordinate"])[0];
      const raw = text(coordinate);
      const description =
        coordinate && typeof coordinate === "object" ? text(node(coordinate)["@_description"]) : "";
      result.earthquake.coordinateRaw = raw;
      result.earthquake.coordinateDescription = description;
      const position = jmaCoordinate(raw, "degree");
      if (position) result.earthquake.position = position;
      const depth = /[+-]\d+(?:\.\d+)?[+-]\d+(?:\.\d+)?([+-]\d+(?:\.\d+)?)\/$/.exec(raw);
      if (depth && position && !/ごく浅い|以上|以浅|不明/.test(description))
        result.earthquake.depthM = -Number(depth[1]);
      const mag = node(eq["jmx_eb:Magnitude"]);
      if (mag["@_type"] !== "Mj") throw new Error("JMA: unsupported magnitude scale");
      const m = text(mag);
      if (/^-?\d+(?:\.\d+)?$/.test(m)) result.earthquake.magnitude = Number(m);
      else if (m !== "NaN") throw new Error("JMA: invalid magnitude");
      result.earthquake.magnitudeDescription = text(mag["@_description"]);
    }
  } else {
    for (const raw of list(b[family === "VFVO50" ? "VolcanoInfo" : "Warning"])) {
      const warning = node(raw),
        system = required(warning["@_type"]);
      for (const rawItem of list(warning["Item"])) {
        const item = node(rawItem);
        const areas = family === "VFVO50" ? list(node(item["Areas"])["Area"]) : list(item["Area"]);
        for (const rawArea of areas) {
          const area = node(rawArea);
          for (const rawKind of list(item["Kind"])) {
            const kind = node(rawKind);
            result.warnings.push({
              system,
              area: required(area["Code"]),
              name: required(area["Name"]),
              code: required(kind["Code"]),
              wording: required(kind["Name"]),
              status: text(kind["Status"] ?? kind["Condition"]),
            });
          }
        }
      }
    }
    if (!result.warnings.length) throw new Error("JMA: warning has no items");
  }
  return result;
}
