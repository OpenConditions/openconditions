import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { localDateInZone, localTimeInZone, zonedWallClockToInstant } from "@openconditions/model";
import type { FuelGrade } from "../grades.js";
import {
  type FuelFeed,
  type ProductInput,
  placeable,
  priceDraft,
  stationDraft,
  utcInstant,
} from "../station.js";

const HEADERS = {
  registry:
    "idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine",
  prices: "idImpianto|descCarburante|prezzo|isSelf|dtComu",
};
const GRADES: Readonly<Record<string, FuelGrade>> = {
  Benzina: "petrol",
  Gasolio: "diesel",
  GPL: "lpg",
  Metano: "cng",
};
/** Local policy for a delayed daily bulletin, independent of polling liveness. */
export const MIMIT_MAX_SOURCE_AGE_SEC = 172800;

function csv(payloads: FeedPayloads, role: keyof typeof HEADERS) {
  const buffers = payloads[role];
  if (buffers?.length !== 1) throw new Error(`MIMIT: exactly one ${role} transfer required`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffers[0]);
  // Record framing is syntax only; neither this nor HTTP framing proves inventory completeness.
  if (!text.endsWith("\n")) throw new Error("MIMIT: unterminated transfer");
  const [preamble, header, ...body] = text.replaceAll("\r\n", "\n").split("\n");
  const date = /^Estrazione del (\d{4}-\d{2}-\d{2})$/.exec(preamble ?? "")?.[1];
  if (!date || header !== HEADERS[role]) throw new Error(`MIMIT: invalid ${role} preamble/header`);
  const rows = body.slice(0, -1).map((line) => {
    // The documented fields are unquoted pipe-delimited cells. Refuse ambiguous quoting
    // until a paired live capture qualifies it rather than silently changing field boundaries.
    const cells = line.split("|");
    if (
      line.includes('"') ||
      cells.length !== header.split("|").length ||
      !/^\d+$/.test(cells[0] ?? "")
    )
      throw new Error(`MIMIT: malformed ${role} row`);
    return cells;
  });
  return { date, rows };
}

function communication(raw: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59)
    throw new Error("MIMIT: invalid communication time");
  const wall = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`;
  const at = zonedWallClockToInstant("Europe/Rome", wall);
  const matches = (date: Date) =>
    `${localDateInZone(date, "Europe/Rome")}T${localTimeInZone(date, "Europe/Rome")}` === wall;
  // Rome folds repeat an hour. No provider policy authorizes choosing either instant.
  if (
    !at ||
    !matches(at) ||
    [-3600000, 3600000].some((delta) => matches(new Date(at.getTime() + delta)))
  )
    throw new Error("MIMIT: invalid or ambiguous communication time");
  return utcInstant(at);
}

/** The two daily files are one publication; no HTTP or relay access occurs here. */
export function parseMimit(feed: FuelFeed, payloads: FeedPayloads, ctx: ParseContext) {
  const registry = csv(payloads, "registry");
  const prices = csv(payloads, "prices");
  if (registry.date !== prices.date) throw new Error("MIMIT: mismatched extraction dates");
  const cutoff = zonedWallClockToInstant("Europe/Rome", `${registry.date}T08:00:00`);
  if (!cutoff) throw new Error("MIMIT: invalid extraction date");
  const age = Date.parse(ctx.fetchedAt) - cutoff.getTime();
  if (!(age >= 0 && age < MIMIT_MAX_SOURCE_AGE_SEC * 1000))
    throw new Error("MIMIT: future or obsolete extraction");
  const at = utcInstant(cutoff);
  // Delayed acquisition must not extend the global 24-hour fuel.price freshness window.
  const expiresAt = utcInstant(new Date(cutoff.getTime() + 86400 * 1000));
  const out = emptyParseOutput();
  const sites = new Map<string, string[]>();
  for (const row of registry.rows) {
    if (sites.has(row[0]!)) throw new Error("MIMIT: duplicate registry identity");
    sites.set(row[0]!, row);
  }
  const readings = new Map<
    string,
    { product: ProductInput; amount: string; communicated: string; raw: string }[]
  >();
  const seen = new Set<string>();
  for (const [id, label, amount, self, raw] of prices.rows) {
    if (!sites.has(id!)) throw new Error("MIMIT: price references absent registry identity");
    if (
      !/^\d+\.\d{3}$/.test(amount!) ||
      !(Number(amount) > 0 && Number(amount) < 1e21) ||
      !["0", "1"].includes(self!)
    )
      throw new Error("MIMIT: invalid price or service");
    const communicated = communication(raw!);
    if (Date.parse(communicated) > cutoff.getTime())
      throw new Error("MIMIT: communication after cutoff");
    const identity = `${id}|${label}|${self}`;
    if (seen.has(identity)) throw new Error("MIMIT: duplicate price identity");
    seen.add(identity);
    const grade = GRADES[label!];
    if (!grade) {
      recordSkipped(feed.id, "unknown_value");
      continue;
    }
    const service = self === "1" ? "self" : "served";
    const rows = readings.get(id!) ?? [];
    rows.push({
      product: { key: `${grade}:${service}`, grade, service },
      amount: amount!,
      communicated,
      raw: raw!,
    });
    readings.set(id!, rows);
  }
  for (const [id, row] of sites) {
    const [, operator, brand, , name, street, city, , latRaw, lonRaw] = row;
    const lat = Number(latRaw),
      lon = Number(lonRaw);
    if (!latRaw || !lonRaw || !placeable(lon, lat) || lat < 35 || lat > 48 || lon < 6 || lon > 19) {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    const rows = readings.get(id) ?? [];
    const station = stationDraft(feed, {
      stationId: id,
      lon,
      lat,
      fetchedAt: ctx.fetchedAt,
      products: rows.map((r) => r.product),
      productsComplete: false,
      ...(name ? { name: { lang: "it", text: name } } : {}),
      ...(operator ? { operator: { lang: "it", text: operator } } : {}),
      ...(brand ? { brand } : {}),
      address: { country: "IT", ...(street ? { street } : {}), ...(city ? { city } : {}) },
      admin: { country: "IT" },
    });
    station.provenance["sourceUpdatedAt"] = at;
    station["extras"] = { mimitExtraction: registry.date };
    out.features.push(station);
    for (const r of rows) {
      const draft = priceDraft(station, {
        componentKey: r.product.key,
        amount: r.amount,
        currency: "EUR",
        at,
      });
      draft["provenance"] = { ...station.provenance, sourceUpdatedAt: r.communicated };
      draft["freshness"] = { ...station.freshness, expiresAt };
      draft["extras"] = { mimitExtraction: registry.date, mimitCommunication: r.raw };
      out.observations.push(draft);
    }
  }
  const evidence = feed.snapshot?.roleEvidence;
  out.featureSnapshot = {
    at,
    complete: !out.rejected && !!evidence?.["registry"]?.trim(),
    statesComplete: !out.rejected && !!evidence?.["prices"]?.trim(),
  };
  return out;
}
