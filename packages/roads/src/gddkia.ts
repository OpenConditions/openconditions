import { dedupeRoadEvents } from "./dedupe.js";
import type { RoadEvent, RoadEventType } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { getXmlChild, getXmlChildText, getXmlChildren, parseXmlDocument } from "./xml.js";

/**
 * Parser for Poland's GDDKiA `utrdane.xml` road-obstructions feed (CC0). A flat
 * `<utrudnienia><utr>…</utr></utrudnienia>` document, WGS84 points. The coarse
 * `typ` (U/I/W) is refined by the unambiguous boolean flags (`droga_zamknieta`,
 * `awaria_mostu`); records carry no id, so a stable one is derived from content.
 */

function bool(v: string | undefined): boolean {
  return v === "true" || v === "1" || v === "T";
}

function typeOf(it: { typ?: string; closed: boolean; bridge: boolean }): {
  type: RoadEventType;
  category: RoadEvent["category"];
  isPlanned: boolean;
} {
  if (it.closed) return { type: "road_closure", category: "incident", isPlanned: false };
  if (it.bridge) return { type: "hazard", category: "conditions", isPlanned: false };
  if (it.typ === "W") return { type: "accident", category: "incident", isPlanned: false };
  if (it.typ === "U") return { type: "roadworks", category: "planned", isPlanned: true };
  return { type: "other", category: "conditions", isPlanned: false };
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function parseGddkia(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      ignoreAttributes: true,
      isArray: (n: string) => n === "utr",
    });
  } catch {
    return [];
  }
  const root = getXmlChild(doc, "utrudnienia");
  if (!root) return [];

  const out: RoadEvent[] = [];
  for (const it of getXmlChildren(root, "utr")) {
    const lat = Number(getXmlChildText(it, "geo_lat"));
    const lng = Number(getXmlChildText(it, "geo_long"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const typ = getXmlChildText(it, "typ");
    const road = getXmlChildText(it, "nr_drogi");
    const section = getXmlChildText(it, "nazwa_odcinka");
    const text = getXmlChildText(it, "objazd");
    const { type, category, isPlanned } = typeOf({
      typ,
      closed: bool(getXmlChildText(it, "droga_zamknieta")),
      bridge: bool(getXmlChildText(it, "awaria_mostu")),
    });
    const localId = hash(`${road ?? ""}|${getXmlChildText(it, "km") ?? ""}|${lat}|${lng}`);

    out.push({
      id: `${src.id}:${localId}`,
      source: src.id,
      sourceFormat: "gddkia",
      domain: "roads",
      kind: "event",
      type,
      subtype: typ ?? undefined,
      category,
      isPlanned,
      severity: "unknown",
      severitySource: "derived",
      status: "active",
      geometry: { type: "Point", coordinates: [lng, lat] },
      direction: getXmlChildText(it, "kierunek") || undefined,
      roads: road ? [{ name: road, ref: road }] : [],
      headline: text || section || road || "Utrudnienie",
      description: text || undefined,
      validFrom: getXmlChildText(it, "data_powstania") ?? null,
      validTo: getXmlChildText(it, "data_likwidacji") ?? null,
      sourceRaw: it as Record<string, unknown>,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: getXmlChildText(it, "data_powstania") ?? new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      isStale: false,
    });
  }

  return dedupeRoadEvents(out);
}
