import { XMLParser } from "fast-xml-parser";
import type { JmaReport } from "./report.js";

/** Reviewed 2026-11-07 against JMA terms and the retained official samples.
 * JMA's CC BY 4.0 alternative does not clear participating non-JMA authorities.
 */
const OFFICES = new Set(["気象庁", "気象庁本庁", "札幌管区気象台", "横浜地方気象台"]);
// Closed inventory of retained native elements, not an XSD claim. New extension
// elements need review before we can redistribute their unprojected native XML.
const ELEMENTS = new Set(
  "Appendix Area AreaName Areas ArrivalTime Base Body ChangeStatus City Code CodeDefine Comment Comments Condition Control Coordinate CriteriaClass CriteriaPeriod DateTime Duration Earthquake EditingMark EditorialOffice EventID ForecastComment FullStatus Head Headline Hypocenter InfoKind InfoKindVersion InfoType Information Int Intensity IntensityStation Item Kind LastKind Local MaxInt Name Observation Office OfficeInfo OriginTime Pref Property PublishingOffice Report ReportDateTime Sentence Serial Significancy SignificancyPart Status TargetDateTime ValidDateTime Text TidalLevelPart Time Title Type VarComment VolcanoActivity VolcanoHeadline VolcanoInfo VolcanoInfoContent VolcanoPrevention Warning jmx_eb:Coordinate jmx_eb:Magnitude jmx_eb:TidalLevel".split(
    " ",
  ),
);
const reviewed = new WeakMap<JmaReport, string>();
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
});
const restricted =
  /転載禁止|無断転載|再配布禁止|利用禁止|第三者|著作権|出典|提供元|情報提供|資料提供|出所|共同発表|copyright|all rights reserved|not for redistribution|provided by|courtesy|attribution|©|credit|licen[cs]e/i;
function office(value: unknown): void {
  if (typeof value !== "string" || !OFFICES.has(value.trim()))
    throw new Error("JMA: unreviewed publishing/editorial/embedded office; poll withheld");
}
/** Whole-poll withholding: run before lifecycle changes, including releases and cancellations. */
export function assertJmaRights(report: JmaReport): void {
  office(report.publishingOffice);
  office(report.editorialOffice);
  if (reviewed.get(report) === report.nativeXml) return;
  const visit = (value: unknown, parent = "") => {
    if (typeof value === "string") {
      if (restricted.test(value))
        throw new Error("JMA: unreviewed embedded credit or restriction; poll withheld");
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, parent);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (parent === "Office") office(record["Name"]);
    for (const [key, child] of Object.entries(record)) {
      if (key === "?xml") continue;
      if (key === "PublishingOffice" || key === "EditorialOffice") office(child);
      if (!key.startsWith("@_") && key !== "#text" && !ELEMENTS.has(key))
        throw new Error("JMA: unreviewed native element/credit; poll withheld");
      if (key.startsWith("@_") && /rights|credit|copyright|licen[cs]e|source|author/i.test(key))
        throw new Error("JMA: unreviewed native rights attribute; poll withheld");
      visit(child, key);
    }
  };
  visit(parser.parse(report.nativeXml));
  reviewed.set(report, report.nativeXml);
}
