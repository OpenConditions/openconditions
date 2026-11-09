import { XMLParser, XMLValidator } from "fast-xml-parser";
import { JMA_FAMILIES, type JmaFamily } from "./report.js";

const DATA =
  /^https:\/\/www\.data\.jma\.go\.jp\/developer\/xml\/data\/\d{14}_\d+_([A-Z]{4}\d{2})_\d{6}\.xml$/;
export function jmaDataUrl(url: string): { url: string; family: string } {
  const m = DATA.exec(url);
  if (!m) throw new Error("JMA: untrusted payload URL");
  return { url, family: m[1]! };
}
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
});
export function readJmaIndex(
  body: Buffer,
  families: readonly JmaFamily[],
): { updated: string; urls: string[] } {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("JMA: malformed Atom");
  const doc = parser.parse(xml) as Record<string, Record<string, unknown>>;
  const f = doc["feed"];
  if (
    !f ||
    f["@_xmlns"] !== "http://www.w3.org/2005/Atom" ||
    typeof f["updated"] !== "string" ||
    !Number.isFinite(Date.parse(f["updated"]))
  )
    throw new Error("JMA: invalid Atom feed");
  const entries =
    f["entry"] === undefined ? [] : Array.isArray(f["entry"]) ? f["entry"] : [f["entry"]];
  const urls = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") throw new Error("JMA: malformed entry");
    const e = raw as Record<string, unknown>;
    if (typeof e["id"] !== "string") throw new Error("JMA: entry missing id");
    const id = jmaDataUrl(e["id"]);
    if (
      !JMA_FAMILIES.includes(id.family as JmaFamily) ||
      !families.includes(id.family as JmaFamily)
    )
      continue;
    const links = Array.isArray(e["link"]) ? e["link"] : [e["link"]];
    if (
      !links.some(
        (l) => l && typeof l === "object" && (l as Record<string, unknown>)["@_href"] === id.url,
      )
    )
      throw new Error("JMA: entry link and identity differ");
    urls.add(id.url);
  }
  return { updated: f["updated"], urls: [...urls] };
}
