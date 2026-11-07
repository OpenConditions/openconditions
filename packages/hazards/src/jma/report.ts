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
  product: string;
  system: string;
  area: string;
  name: string;
  code: string;
  wording: string;
  status: string;
}
export interface JmaReport {
  messageUrl?: string;
  acquiredAt?: string;
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
// 20261104 manual, 気象警報・注意報（Ｒ０６）_解説資料_別表類.xlsx, 別表3.
const WEATHER_CODES: Partial<Record<JmaFamily, Record<string, string>>> = {
  VPWW55: {
    "00": "解除",
    "10": "レベル２大雨注意報",
    "03": "レベル３大雨警報",
    "43": "レベル４大雨危険警報",
    "33": "レベル５大雨特別警報",
  },
  VPWW56: {
    "00": "解除",
    "29": "レベル２土砂災害注意報",
    "09": "レベル３土砂災害警報",
    "49": "レベル４土砂災害危険警報",
    "39": "レベル５土砂災害特別警報",
  },
  VPWW57: {
    "00": "解除",
    "19": "レベル２高潮注意報",
    "08": "レベル３高潮警報",
    "48": "レベル４高潮危険警報",
    "38": "レベル５高潮特別警報",
  },
};
const HEADERS: Record<JmaFamily, { kind: string; version: string; title: string }> = {
  VXSE51: { kind: "震度速報", version: "1.0_0", title: "震度速報" },
  VXSE52: { kind: "震源速報", version: "1.0_0", title: "震源に関する情報" },
  VXSE53: { kind: "地震情報", version: "1.0_0", title: "震源・震度に関する情報" },
  VPWW55: {
    kind: "気象警報・注意報",
    version: "1.5_0",
    title: "気象警報・注意報（Ｒ０６）（大雨）",
  },
  VPWW56: {
    kind: "気象警報・注意報",
    version: "1.5_0",
    title: "気象警報・注意報（Ｒ０６）（土砂）",
  },
  VPWW57: {
    kind: "気象警報・注意報",
    version: "1.5_0",
    title: "気象警報・注意報（Ｒ０６）（高潮）",
  },
  VFVO50: { kind: "噴火警報・予報", version: "1.0_0", title: "噴火警報・予報" },
};

// Resolve every element, including unused native details, before selecting fields.
function validateNamespaces(
  element: Node,
  inherited: Record<string, string>,
  expected: string,
): void {
  const scope = { ...inherited };
  for (const [key, value] of Object.entries(element)) {
    if (key === "@_xmlns" || key.startsWith("@_xmlns:")) {
      const prefix = key === "@_xmlns" ? "" : key.slice(8);
      if (
        typeof value !== "string" ||
        ![
          NS,
          `${NS}informationBasis1/`,
          `${NS}body/seismology1/`,
          `${NS}body/meteorology1/`,
          `${NS}body/volcanology1/`,
          `${NS}elementBasis1/`,
          `${NS}addition1/`,
          "http://www.w3.org/2001/XMLSchema-instance",
        ].includes(value)
      )
        throw new Error("JMA: unknown namespace declaration");
      scope[prefix] = value;
    }
  }
  if (scope[""] !== expected) throw new Error("JMA: nested namespace substitution");
  for (const [key, value] of Object.entries(element)) {
    if (key.startsWith("@_") || key === "#text") continue;
    const parts = key.split(":");
    const ns = parts.length === 2 ? scope[parts[0]!] : scope[""];
    if (!ns) throw new Error("JMA: undeclared namespace prefix");
    for (const child of list(value)) {
      if (child && typeof child === "object") {
        const childExpected =
          key === "Head"
            ? `${NS}informationBasis1/`
            : key === "Body"
              ? text(node(child)["@_xmlns"])
              : expected;
        validateNamespaces(node(child), scope, childExpected);
      }
    }
  }
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
  if (v && typeof v === "object") {
    const nil = node(v)["@_xsi:nil"];
    if (nil !== undefined && !["true", "false", "0", "1"].includes(String(nil)))
      throw new Error("JMA: invalid nil date");
    if ((nil === "true" || nil === "1") && s) throw new Error("JMA: contradictory nil date");
  }
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
  if (!raw) return undefined;
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
  validateNamespaces(r, {}, NS);
  const header = HEADERS[family];
  if (
    required(h["InfoKind"]) !== header.kind ||
    ![header.version, ...(family === "VXSE52" ? ["1.0_1"] : [])].includes(
      required(h["InfoKindVersion"]),
    ) ||
    required(c["Title"]) !== header.title
  )
    throw new Error("JMA: unsupported operational header");
  const status = required(c["Status"]);
  if (!["通常", "訓練", "試験"].includes(status)) throw new Error("JMA: unknown Control status");
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
    operational: status === "通常",
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
    if ((family === "VXSE51" && !intensity) || (family !== "VXSE51" && !eq))
      throw new Error("JMA: unusable earthquake body");
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
      const coordinates = list(area["jmx_eb:Coordinate"]);
      if (coordinates.length !== 1)
        throw new Error("JMA: ambiguous or missing hypocentre coordinate");
      const coordinate = coordinates[0];
      if (coordinate && typeof coordinate === "object") {
        const metadata = node(coordinate);
        if (metadata["@_type"] !== undefined && metadata["@_type"] !== "震源位置（度）")
          throw new Error("JMA: unqualified hypocentre datum or unit");
        if (metadata["@_unit"] !== undefined && metadata["@_unit"] !== "度")
          throw new Error("JMA: unqualified hypocentre unit");
      }
      const raw = text(coordinate);
      const description =
        coordinate && typeof coordinate === "object" ? text(node(coordinate)["@_description"]) : "";
      result.earthquake.coordinateRaw = raw;
      result.earthquake.coordinateDescription = description;
      const position = jmaCoordinate(raw, "degree");
      if (position) result.earthquake.position = position;
      const depth = /[+-]\d+(?:\.\d+)?[+-]\d+(?:\.\d+)?([+-]\d+(?:\.\d+)?)\/$/.exec(raw);
      if (depth && position && !/ごく浅い|以上|以浅|不明/.test(description.replace(/\s/g, "")))
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
            const noWarning = text(kind["Status"]) === "発表警報・注意報はなし";
            const codes = WEATHER_CODES[family];
            if (
              codes &&
              !noWarning &&
              (codes[text(kind["Code"])] === undefined ||
                codes[text(kind["Code"])] !== text(kind["Name"]))
            )
              throw new Error("JMA: unknown weather code or wording mismatch");
            if (noWarning && (text(kind["Code"]) || text(kind["Name"])))
              throw new Error("JMA: contradictory no-warning item");
            result.warnings.push({
              product: system,
              system:
                family === "VFVO50"
                  ? required(node(item["Areas"])["@_codeType"])
                  : system === "気象警報・注意報（市町村等）"
                    ? "気象・地震・火山情報／市町村等"
                    : system === "気象警報・注意報（高潮予報区）"
                      ? "高潮予報区間"
                      : "気象情報／府県予報区・細分区域等",
              area: required(area["Code"]),
              name: required(area["Name"]),
              code: noWarning ? "" : required(kind["Code"]),
              wording: noWarning ? "" : required(kind["Name"]),
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
