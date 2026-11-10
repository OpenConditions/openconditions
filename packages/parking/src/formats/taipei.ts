import {
  isXmlObject,
  parseXmlDocument,
  type XmlObject,
  xmlNodeToArray,
} from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { type AreaInput, availableDraft, siteDraft } from "../site.js";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The publisher's CST is Taiwan standard time, never the host's timezone. */
export function taipeiTime(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("taipei: missing source clock");
  const m =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) CST (\d{4})$/.exec(
      raw,
    );
  if (!m) throw new Error("taipei: invalid source clock");
  const month = months.indexOf(m[2]!);
  const iso = `${m[7]}-${String(month + 1).padStart(2, "0")}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  const t = Date.parse(iso);
  const local = new Date(t + 8 * 3600000);
  if (
    month < 0 ||
    !Number.isFinite(t) ||
    local.getUTCDate() !== Number(m[3]) ||
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getUTCDay()] !== m[1]
  )
    throw new Error("taipei: invalid source calendar date");
  return new Date(t).toISOString();
}

/** Inverse transverse Mercator, GRS80, TM2 121 (EPSG:3826). */
export function twd97ToWgs84(x: number, y: number): [number, number] {
  const a = 6378137,
    f = 1 / 298.257222101,
    e2 = f * (2 - f),
    ep = e2 / (1 - e2),
    k = 0.9999;
  const mu = y / k / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const n = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2),
    r = (a * (1 - e2)) / (1 - e2 * Math.sin(p) ** 2) ** 1.5;
  const t = Math.tan(p) ** 2,
    c = ep * Math.cos(p) ** 2,
    d = (x - 250000) / (n * k);
  const lat =
    p -
    ((n * Math.tan(p)) / r) *
      ((d * d) / 2 -
        ((5 + 3 * t + 10 * c - 4 * c * c - 9 * ep) * d ** 4) / 24 +
        ((61 + 90 * t + 298 * c + 45 * t * t - 252 * ep - 3 * c * c) * d ** 6) / 720);
  const lon =
    (d -
      ((1 + 2 * t + c) * d ** 3) / 6 +
      ((5 - 2 * c + 28 * t - 3 * c * c + 8 * ep + 24 * t * t) * d ** 5) / 120) /
    Math.cos(p);
  return [121 + (lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
const object = (raw: unknown): XmlObject => {
  if (!isXmlObject(raw)) throw new Error("taipei: expected element");
  const entries = Object.entries(raw).map(([k, v]) => [k.toUpperCase(), v]);
  if (new Set(entries.map(([k]) => k)).size !== entries.length)
    throw new Error("taipei: ambiguous element case");
  return Object.fromEntries(entries);
};
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const count = (v: unknown): number | undefined => {
  const s = text(v);
  if (s === undefined || !/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
};
const number = (v: unknown): number => (text(v) === undefined ? Number.NaN : Number(v));
const inTaipei = ([lon, lat]: readonly number[]): boolean =>
  Number.isFinite(lon) &&
  Number.isFinite(lat) &&
  lon! > 121.2 &&
  lon! < 121.8 &&
  lat! > 24.8 &&
  lat! < 25.3;
function document(
  payloads: FeedPayloads,
  role: string,
): { at: string; rows: Map<string, XmlObject> } {
  const bodies = payloads[role];
  if (bodies?.length !== 1) throw new Error(`taipei: requires one ${role} document`);
  const doc = object(parseXmlDocument(bodies[0]!));
  const root = object(doc["DATA"]);
  const at = taipeiTime(root["UPDATETIME"]);
  const rows = new Map<string, XmlObject>();
  for (const raw of xmlNodeToArray(root["PARK"])) {
    const row = object(raw),
      id = text(row["ID"]);
    if (!id || rows.has(id)) throw new Error(`taipei: missing or duplicate ${role} ID`);
    rows.set(id, row);
  }
  if (!rows.size)
    throw new Error(`taipei: empty ${role} document is not qualified withdrawal evidence`);
  return { at, rows };
}
const categories: readonly {
  total: string;
  available: string;
  vehicleType: AreaInput["vehicleType"];
  userGroup: AreaInput["userGroup"];
}[] = [
  { total: "TOTALCAR", available: "AVAILABLECAR", vehicleType: "car", userGroup: "any" },
  { total: "TOTALMOTOR", available: "AVAILABLEMOTOR", vehicleType: "motorcycle", userGroup: "any" },
  { total: "TOTALBUS", available: "AVAILABLEBUS", vehicleType: "bus", userGroup: "any" },
  {
    total: "HANDICAP_FIRST",
    available: "AVAILABLEHANDICAP",
    vehicleType: "any",
    userGroup: "disabled",
  },
  {
    total: "PREGNANCY_FIRST",
    available: "AVAILABLEPREGNANCY",
    vehicleType: "any",
    userGroup: "family",
  },
];
/** Pure XML join. Reserved categories overlap vehicle totals; heavy motorcycles remain raw only. */
export function parseTaipei(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const sites = document(payloads, "sites"),
    status = document(payloads, "status");
  const age = Date.parse(ctx.fetchedAt) - Date.parse(status.at);
  if (!Number.isFinite(age) || age < 0 || age >= feed.freshnessWindowSec * 1000)
    throw new Error("taipei: stale or future status publication");
  if (
    Date.parse(sites.at) > Date.parse(ctx.fetchedAt) ||
    Date.parse(ctx.fetchedAt) - Date.parse(sites.at) > 172800000
  )
    throw new Error("taipei: stale or future inventory publication");
  for (const id of status.rows.keys())
    if (!sites.rows.has(id)) throw new Error(`taipei: unmatched status ID ${id}`);
  const out = emptyParseOutput();
  const qualified = feed.taipei?.qualifiedSnapshot === true;
  out.publication = {
    featuresComplete: qualified,
    offersComplete: false,
    statesComplete: qualified,
    sourcePublishedAt: status.at,
  };
  for (const [id, row] of sites.rows) {
    const point = twd97ToWgs84(number(row["TW97X"]), number(row["TW97Y"]));
    if (!inTaipei(point)) throw new Error(`taipei: invalid site coordinate ${id}`);
    const live = status.rows.get(id);
    const areas: AreaInput[] = categories.flatMap((c) => {
      const capacity = count(row[c.total]);
      return capacity === undefined && count(live?.[c.available]) === undefined
        ? []
        : [
            {
              vehicleType: c.vehicleType,
              userGroup: c.userGroup,
              ...(capacity === undefined ? {} : { capacity }),
            },
          ];
    });
    const entrances: NonNullable<Parameters<typeof siteDraft>[1]["entrances"]> = [];
    if (isXmlObject(row["ENTRANCECOORD"])) {
      for (const raw of xmlNodeToArray(object(row["ENTRANCECOORD"])["ENTRANCECOORDINFO"])) {
        const entry = object(raw),
          p: [number, number] = [number(entry["YCOD"]), number(entry["XCOD"])];
        if (inTaipei(p)) entrances.push({ point: p, kind: "vehicle_entrance" });
      }
    }
    const draft = siteDraft(
      feed,
      {
        stationId: id,
        point,
        lang: "zh-Hant",
        name: text(row["NAME"]),
        address: { text: text(row["ADDRESS"]), city: "臺北市", country: "TW" },
        tariffText: text(row["PAYEX"]),
        openingHoursText: text(row["SERVICETIME"]),
        notes: `TYPE=${text(row["TYPE"]) ?? "unknown"}; ${text(row["SUMMARY"]) ?? ""}`,
        areas,
        entrances,
      },
      ctx.fetchedAt,
    );
    draft["provenance"] = { ...(draft["provenance"] as object), sourceUpdatedAt: sites.at };
    out.features.push(draft);
    for (const c of categories) {
      const value = count(live?.[c.available]);
      if (value === undefined) {
        const raw = text(live?.[c.available]);
        if (raw !== undefined && raw !== "-9") recordSkipped(feed.id, "unknown_value");
        continue;
      }
      const reading = availableDraft(
        feed,
        {
          stationId: id,
          point,
          area: { vehicleType: c.vehicleType, userGroup: c.userGroup },
          at: status.at,
          count: value,
          capacity: count(row[c.total]),
        },
        ctx,
      );
      if (!reading) {
        recordSkipped(feed.id, "unknown_value");
        continue;
      }
      // Root publication time is a snapshot, not an individual measurement.
      reading["provenance"] = { ...(reading["provenance"] as object), sourceUpdatedAt: status.at };
      reading["freshness"] = {
        fetchedAt: ctx.fetchedAt,
        expiresAt: new Date(Date.parse(status.at) + feed.freshnessWindowSec * 1000).toISOString(),
      };
      out.observations.push(reading);
    }
  }
  return out;
}
