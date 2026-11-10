import { XMLParser, XMLValidator } from "fast-xml-parser";

export const SMN_INDEX = {
  ar: "https://ssl.smn.gob.ar/CAP/AR.php",
  acp: "https://ssl.smn.gob.ar/feeds/CAP/avisocortoplazo/rss_acpCAP.xml",
} as const;
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  isArray: (name) => name === "item",
});

/** Only SMN's two reviewed RSS products may cross the generic walk's directory boundary. */
export function smnLinks(body: Buffer, kind: keyof typeof SMN_INDEX, at: number): string[] {
  const text = body.toString("utf8");
  if (
    body.length > 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(text) ||
    XMLValidator.validate(text) !== true
  )
    throw new Error("SMN: invalid RSS XML");
  const root = parser.parse(text);
  const channel = root.rss?.channel;
  if (root.rss?.["@_version"] !== "2.0" || !channel || root.rss["@_xmlns"])
    throw new Error("SMN: expected unnamespaced RSS 2.0");
  const built = Date.parse(channel.lastBuildDate ?? "");
  // SMN regenerates both indexes regularly. A frozen response/304 is not fresh issuance evidence.
  if (!Number.isFinite(built) || built > at + 300000 || at - built > 36 * 3600000)
    throw new Error("SMN: stale RSS index");
  if (!String(channel.copyright).includes("Licencia CC BY 4.0"))
    throw new Error("SMN: RSS rights notice changed");
  const items = channel.item;
  if (!Array.isArray(items) || items.length === 0 || items.length > 256)
    throw new Error("SMN: missing or excessive RSS items");
  if (
    kind === "acp" &&
    items.length === 1 &&
    items[0].link === "https://www.smn.gob.ar/rss" &&
    items[0].description ===
      "No se han emitido Avisos Meteorologicos a corto plazo en la REPUBLICA ARGENTINA"
  )
    return [];
  const links = new Set<string>();
  for (const item of items) {
    if (typeof item.link !== "string") throw new Error("SMN: missing CAP link");
    const url = new URL(item.link);
    const path =
      kind === "ar"
        ? /^\/feeds\/CAP\/xml_generados\/CAP_[A-Za-z0-9_]+\.xml$/
        : /^\/feeds\/CAP\/avisocortoplazo\/[A-Za-z0-9_]+\.xml$/;
    if (
      url.origin !== "https://ssl.smn.gob.ar" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !path.test(url.pathname) ||
      url.href === SMN_INDEX.acp
    )
      throw new Error("SMN: unreviewed CAP link");
    links.add(url.href);
  }
  return [...links];
}
