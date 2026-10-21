import type { RecordDraft, SkipCounts } from "@openconditions/ingest-framework";
import { Bcp47, Iso8601 } from "@openconditions/model";
import {
  type CapPair,
  capCircle,
  capClassification,
  capGroupList,
  capPolygon,
  capReferences,
  hazardsCrosswalk,
  nwsVtec,
  VTEC_ENDING_ACTIONS,
  type Vtec,
} from "@openconditions/model-hazards";
import type { Geometry, Position } from "geojson";
import { pointInRing } from "../geometry.js";
import {
  freshness,
  type HazardsFeed,
  isRecord,
  provenance,
  situationId,
  UNLOCATED,
} from "../records.js";
import { capToken } from "./messages.js";
import type { CapAlert, CapArea, CapInfo } from "./types.js";

/** The reference table a supplied shape was drawn from, credited on the location as a TMC table is. */
export interface ShapeTable {
  ref: string;
  version: string;
  attribution: string;
  license: string;
}

/** A shape a format supplies for an area CAP names only by its codes (an NWS zone, a MeteoAlarm region). */
export interface DerivedShape {
  geometry: Geometry;
  origin: "derived";
  /** Set when the shape is a third party's rather than the alert publisher's, whose licence asks for credit. */
  table?: ShapeTable;
}

export interface CapSituationOptions {
  /** The warning the message belongs to, as `currentMessages` reads it. */
  groupId: string;
  /** When the poll read the message. */
  fetchedAt: string;
  /**
   * The shape of an area that has no polygon or circle of its own; undefined
   * when the format knows none. A format simplifies the shapes it supplies.
   */
  geometryOf?: (area: CapArea) => DerivedShape | undefined;
  /**
   * When a hazard stops being in force; its `expires` by default. NWS keeps
   * an alert active past `expires`, which for a long-fused product is the
   * next expected issuance, until the hazard `ends`.
   */
  endOf?: (info: CapInfo) => string | undefined;
  /** When a situation stops being current, from the end its hazard is in force until; that end itself by default. */
  expiresAt?: (end: string | undefined) => string | undefined;
  /** The country a message warns in, for a feed that spans several; the message's own OID and the feed's country otherwise. */
  countryOf?: (alert: CapAlert) => string | undefined;
}

/**
 * CAP geocode names → the registry's admin geocode schemes; the rest are not
 * areas. Irish FIPS 10-4 codes are told from others by their `EI` prefix.
 */
const GEOCODE_SCHEMES: Readonly<Record<string, string>> = {
  SAME: "same",
  UGC: "ugc",
  WARNCELLID: "warncellid",
  EMMA_ID: "emma_id",
  NUTS2: "nuts",
  NUTS3: "nuts",
  CISORP: "cisorp",
  "profile:CAP-CP:Location:0.3": "sgc",
  "layer:EC-MSC-SMC:1.0:CLC": "eccc_clc",
};

function geocodeScheme(g: CapPair): string | undefined {
  if (g.valueName === "FIPS") return /^EI\d/.test(g.value) ? "fips10_4" : undefined;
  return Object.hasOwn(GEOCODE_SCHEMES, g.valueName) ? GEOCODE_SCHEMES[g.valueName] : undefined;
}

/**
 * The ISO 3166 numeric code in a WMO register OID (`2.49.0.0.276.…` DWD,
 * `urn:oid:2.49.0.1.840.…` NWS), for the publishers whose messages name their
 * country so.
 */
const WMO_COUNTRIES: Readonly<Record<string, string>> = { "124": "CA", "276": "DE", "840": "US" };
const WMO_OID = /^(?:urn:oid:)?2\.49\.0\.[01]\.(\d{3})\./;

/** The country a message warns in: its WMO register OID, the Canadian profile, else the feed's. */
function countryOf(alert: CapAlert, feed: HazardsFeed): string | undefined {
  const numeric = WMO_OID.exec(alert.identifier)?.[1];
  if (numeric !== undefined && Object.hasOwn(WMO_COUNTRIES, numeric)) return WMO_COUNTRIES[numeric];
  if ((alert.code ?? []).some((c) => typeof c === "string" && c.startsWith("profile:CAP-CP:"))) {
    return "CA";
  }
  return feed.country;
}

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

/**
 * A CAP time as the model holds it: a date and time with its zone, as CAP
 * 1.2's `dateTime` requires. Undefined for anything else, which names no
 * instant (a time without a zone is local to nobody knows where).
 */
export function capInstant(raw: unknown): string | undefined {
  const s = string(raw);
  return s !== undefined && Iso8601.safeParse(s).success && Number.isFinite(Date.parse(s))
    ? s
    : undefined;
}

/** The times of an info block that are written but name no instant. */
const unreadTimes = (info: CapInfo) =>
  [info.effective, info.onset, info.expires, info.ends].filter(
    (t) => string(t) !== undefined && capInstant(t) === undefined,
  ).length;

/**
 * An info block's language as a tag the model holds; CAP's default `en-US`
 * when it names none, and `und` when it names one that is no such tag
 * (CAP's `xs:language` also allows `i-` and `x-` tags).
 */
const languageOf = (info: CapInfo): string => {
  const tag = string(info.language) ?? "en-US";
  return Bcp47.safeParse(tag).success ? tag : "und";
};

const unreadLanguage = (info: CapInfo) =>
  string(info.language) !== undefined && languageOf(info) === "und" ? 1 : 0;

const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

/** A CAP pair list with every entry the model can hold: a name, and a string value. */
const pairs = (value: CapPair[] | undefined): CapPair[] =>
  list(value).flatMap((p) => {
    const name = string(p?.valueName);
    return name === undefined
      ? []
      : [{ valueName: name, value: typeof p.value === "string" ? p.value : "" }];
  });

/** A text in every language the info blocks carry it; an empty element is no text. */
function text(infos: readonly CapInfo[], pick: (i: CapInfo) => unknown) {
  const parts = infos.flatMap((i) => {
    const value = string(pick(i));
    return value === undefined ? [] : [{ lang: languageOf(i), text: value }];
  });
  return parts.length > 0 ? parts : undefined;
}

const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });

/**
 * An info block's areas as one geometry. Polygons are the source's; DWD
 * sends the islands and lakes a district's outline does not cover as
 * `EXCLUDE_POLYGON` geocodes, which become holes of the polygon they lie in.
 * A circle, a polygon split at the antimeridian and a shape the format
 * supplies for a code-only area are derived, and a supplied shape from a
 * third party's table brings that table's credit; an area with only codes and no
 * supplied shape has no geometry. Undefined when a shape CAP gives does not
 * read (a position out of range, an open ring): the hazard is skipped.
 */
function capGeometry(
  areas: readonly CapArea[],
  geometryOf: CapSituationOptions["geometryOf"],
): { geometry: Geometry | null; derived: boolean; table?: ShapeTable } | undefined {
  const polygons: Position[][][] = [];
  const shapes: Geometry[] = [];
  let derived = false;
  let table: ShapeTable | undefined;
  for (const a of areas) {
    const holes: Position[][] = [];
    for (const g of pairs(a.geocode)) {
      // A blank exclusion names no hole, as a blank polygon names no area.
      const exclusion = g.valueName === "EXCLUDE_POLYGON" ? string(g.value) : undefined;
      if (exclusion === undefined) continue;
      const rings = capPolygon(exclusion);
      if (rings === null) return undefined;
      holes.push(...rings);
    }
    const own = list(a.polygon).flatMap((p) => string(p) ?? []);
    const circles = list(a.circle).flatMap((c) => string(c) ?? []);
    for (const p of own) {
      const rings = capPolygon(p);
      if (rings === null) return undefined;
      if (rings.length > 1) derived = true;
      for (const ring of rings) {
        polygons.push([ring, ...holes.filter((h) => pointInRing(h[0]!, ring))]);
      }
    }
    for (const c of circles) {
      const shape = capCircle(c);
      if (shape === null) return undefined;
      derived = true;
      if (shape.type === "Polygon") polygons.push(shape.coordinates);
      else if (shape.type === "MultiPolygon") polygons.push(...shape.coordinates);
      else shapes.push(shape);
    }
    if (own.length > 0 || circles.length > 0) continue;
    const supplied = geometryOf?.(a);
    if (supplied === undefined) continue;
    derived = true;
    // A location credits one table; no format draws an area from two.
    table ??= supplied.table;
    const g = supplied.geometry;
    if (g.type === "Polygon") polygons.push(g.coordinates);
    else if (g.type === "MultiPolygon") polygons.push(...g.coordinates);
    else shapes.push(g);
  }
  const all: Geometry[] = [
    ...(polygons.length === 1 ? [{ type: "Polygon", coordinates: polygons[0]! } as const] : []),
    ...(polygons.length > 1 ? [{ type: "MultiPolygon", coordinates: polygons } as const] : []),
    ...shapes,
  ];
  const geometry =
    all.length === 0
      ? null
      : all.length === 1
        ? all[0]!
        : { type: "GeometryCollection" as const, geometries: all };
  return { geometry, derived, ...optional("table", table) };
}

function capLocation(
  infos: readonly CapInfo[],
  country: string | undefined,
  geometryOf: CapSituationOptions["geometryOf"],
): Record<string, unknown> | undefined {
  const areas = list(infos[0]!.area);
  if (areas.length === 0) return { ...UNLOCATED };
  const shape = capGeometry(areas, geometryOf);
  if (shape === undefined) return undefined;
  const seen = new Set<string>();
  const geocodes = areas.flatMap((a) =>
    pairs(a.geocode).flatMap((g) => {
      const scheme = geocodeScheme(g);
      const code = g.value.trim();
      const key = `${scheme}\u0000${code}`;
      if (scheme === undefined || code === "" || seen.has(key)) return [];
      seen.add(key);
      return [{ scheme, code }];
    }),
  );
  const description = text(infos, (i) =>
    list(i.area)
      .map((a) => string(a.areaDesc))
      .filter((d) => d !== undefined)
      .join("; "),
  );
  // A zone's type is part of its name: fire and forecast zones share ids.
  const external = [...new Set(areas.flatMap((a) => list(a.zones)))].flatMap((zone) => {
    const [type, id] = zone.split("/");
    return type && id ? [{ system: `nws:${type}`, code: id }] : [];
  });
  return {
    geometry: shape.geometry,
    extent: "area",
    geometryOrigin: shape.geometry === null ? "none" : shape.derived ? "derived" : "source",
    fuzziness: "exact",
    ...(country === undefined
      ? {}
      : { admin: geocodes.length > 0 ? { country, geocodes } : { country } }),
    ...optional("areaDescription", description),
    ...optional("locationTable", shape.table),
    ...(external.length > 0 ? { external } : {}),
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
    capClassification(pairs(i.eventCode), pairs(i.parameter)),
    i.category,
    pairs(i.eventCode).filter((e) => e.valueName !== "LICENSE"),
    i.responseType,
    i.urgency,
    i.severity,
    i.certainty,
    i.effective,
    i.onset,
    i.expires,
    list(i.area).map((a) =>
      isRecord(a) ? [a.polygon, a.circle, a.geocode, decimal(a.altitude), decimal(a.ceiling)] : a,
    ),
  ]);

/**
 * When a hazard stops being in force: the format's end if it states one, the
 * message's `expires` otherwise; undefined when that names no instant.
 */
export function capEnd(
  info: CapInfo,
  endOf: CapSituationOptions["endOf"] | undefined,
): string | undefined {
  return capInstant(endOf === undefined ? info.expires : endOf(info));
}

/** Why a warning a message still describes is no longer in force. */
type Ending = "cancelled" | "superseded" | "source_ended";

/**
 * A warning is in force from when its message takes effect (`effective`,
 * which CAP defaults to `sent`) until its end (`capEnd`). The event it
 * warns of may begin later, even after the message expires (an NWS watch is
 * reissued before its hazard starts), so `onset` stays in the details. A
 * message that ends before it takes effect is in force for no time. A
 * `Cancel` is cancelled whatever else it says.
 */
function capValidity(
  alert: CapAlert,
  info: CapInfo,
  ending: Ending | undefined,
  end: string | undefined,
) {
  let start = capInstant(info.effective) ?? string(alert.sent)!;
  if (end !== undefined && Date.parse(start) > Date.parse(end)) start = end;
  const reason = capToken(alert.msgType) === "Cancel" ? "cancelled" : ending;
  return {
    status: reason === undefined ? "active" : reason === "cancelled" ? "cancelled" : "ended",
    start,
    ...optional("end", end),
    ...optional("endedReason", reason),
  };
}

/**
 * The NWS events of an info block's `VTEC` parameters, and how many of them
 * do not read: no P-VTEC string, or an action or significance NWS Directive
 * 10-1703 does not define.
 */
export function vtecEvents(parameters: readonly CapPair[]): { events: Vtec[]; unread: number } {
  const events: Vtec[] = [];
  let unread = 0;
  for (const p of parameters) {
    if (p.valueName !== "VTEC") continue;
    const v = nwsVtec(p.value);
    if (v === null || v === "unknown") unread++;
    else events.push(v);
  }
  return { events, unread };
}

/** Whether every NWS event a message acts on ends with it: upgraded, cancelled or expired. */
export const vtecEnds = (events: readonly Vtec[]) =>
  events.length > 0 && events.every((e) => VTEC_ENDING_ACTIONS.has(e.action));

/**
 * How the NWS events of a message end with it, once every one does:
 * cancelled when each is, superseded when one was upgraded to another
 * hazard. An expiring event stays in force until its end.
 */
function vtecEnding(events: readonly Vtec[]): Ending | undefined {
  if (events.length === 0 || !events.every((e) => e.action === "CAN" || e.action === "UPG")) {
    return undefined;
  }
  return events.every((e) => e.action === "CAN") ? "cancelled" : "superseded";
}

/**
 * The warning a message with VTEC belongs to: its event's office,
 * phenomenon, significance and tracking number, which NWS keeps for the
 * event's life, and the year the number counts in (the event's begin, or the
 * message's for one under way). The first event still in force names it.
 * NWS sends a continuation as a fresh `Alert` without references, so its
 * references cannot tie it to the warning.
 */
function vtecGroup(events: readonly Vtec[], sent: string): string | undefined {
  const e = events.find((v) => !VTEC_ENDING_ACTIONS.has(v.action)) ?? events[0];
  if (e === undefined) return undefined;
  const year = new Date(Date.parse(e.begin ?? sent)).getUTCFullYear();
  return `VTEC:${e.office}.${e.phenomenon}.${e.significance}.${String(e.eventNumber).padStart(4, "0")}:${year}`;
}

/** The relation a message's references have to the messages they name; an alert's are only related. */
const RELATION_OF: Readonly<Record<string, string>> = {
  Update: "update_of",
  Cancel: "cancels",
};

const value = (vocabulary: string, token: unknown) => {
  const t = string(token);
  return t === undefined ? undefined : hazardsCrosswalk.value(vocabulary, "cap", t);
};

/** A URL the model can hold; anything else is dropped. */
const webOf = (raw: unknown) => {
  const url = string(raw);
  return url !== undefined && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)
    ? url
    : undefined;
};

/**
 * Each language's link where the languages link to different pages (ECCC's
 * English and French sites); undefined when they share one, which `web`
 * already holds.
 */
function localizedWeb(infos: readonly CapInfo[]) {
  const byLanguage = new Map<string, string>();
  for (const i of infos) {
    const url = webOf(i.web);
    const lang = languageOf(i);
    if (url !== undefined && !byLanguage.has(lang)) byLanguage.set(lang, url);
  }
  return new Set(byLanguage.values()).size > 1
    ? [...byLanguage].map(([lang, url]) => ({ lang, url }))
    : undefined;
}

/** A CAP decimal, which MeteoAlarm's JSON writes as a number; undefined when it does not read. */
function decimal(raw: unknown): number | undefined {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The vertical extent of an info block's areas in feet: the lowest
 * `altitude` and the highest `ceiling`. An area without an altitude has no
 * lower limit, so the extent has one only when every area states it; CAP
 * allows a ceiling only beside an altitude, and the same holds for it.
 */
function verticalExtent(areas: readonly CapArea[]) {
  const altitudes = areas.map((a) => decimal(a.altitude));
  const ceilings = areas.map((a) => decimal(a.ceiling));
  const stated = (values: (number | undefined)[]) =>
    values.length > 0 && values.every((v) => v !== undefined) ? (values as number[]) : undefined;
  const low = stated(altitudes);
  const high = low === undefined ? undefined : stated(ceilings);
  return {
    ...(low === undefined ? {} : { altitudeFt: Math.min(...low) }),
    ...(high === undefined ? {} : { ceilingFt: Math.max(...high) }),
  };
}

/**
 * The files the info blocks point to, each once: one with a link by its
 * link, one without by its description. A resource without the description
 * and MIME type CAP requires is left out, and content CAP embeds
 * (`derefUri`) is not kept.
 */
function resourcesOf(infos: readonly CapInfo[]) {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of infos.flatMap((i) => list(i.resource))) {
    const description = string(r?.resourceDesc);
    const mimeType = string(r?.mimeType);
    if (description === undefined || mimeType === undefined) continue;
    const uri = webOf(r.uri);
    const key = uri ?? `${mimeType}\u0000${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const size = decimal(r.size);
    out.push({
      description,
      mimeType,
      ...(size !== undefined && Number.isInteger(size) && size >= 0 ? { size } : {}),
      ...optional("uri", uri),
      ...optional("digest", string(r.digest)),
    });
  }
  return out;
}

/** The known tokens of a repeatable CAP field as the vocabulary's values, and how many it does not know. */
function tokens(vocabulary: string, raw: unknown): { values: string[]; unknown: number } {
  const values: string[] = [];
  let unknown = 0;
  for (const token of list(raw as unknown[] | undefined)) {
    const v = value(vocabulary, token);
    if (v === undefined) unknown++;
    else values.push(v);
  }
  return { values, unknown };
}

/**
 * A message's situations, and why any of its hazards, or any value of one,
 * went unread. A hazard is skipped as `malformed` when a field CAP requires
 * does not read: a header, urgency, severity or certainty token CAP 1.2 does
 * not define, no category it defines, no event, a shape out of range, or an
 * info block or area that is no element; the message's other hazards are
 * kept. A category or response type CAP does not define, a time that names
 * no instant and a language that is no tag are left out of a hazard that is
 * kept, as `unknown_value`.
 */
export function capDrafts(
  alert: CapAlert,
  feed: HazardsFeed,
  opts: CapSituationOptions,
): { drafts: RecordDraft[]; skipped: SkipCounts } {
  const drafts: RecordDraft[] = [];
  const skipped: { malformed?: number; unknown_value?: number } = {};
  // An info block or area that is no element (an empty `<info/>`, a JSON
  // null) describes no hazard or place: that hazard does not read.
  const infos = list(alert.info).filter((info) => {
    if (isRecord(info) && list(info.area).every(isRecord)) return true;
    skipped.malformed = (skipped.malformed ?? 0) + 1;
    return false;
  });
  const groups = new Map<string, CapInfo[]>();
  for (const info of infos) {
    const key = signature(info);
    groups.set(key, [...(groups.get(key) ?? []), info]);
  }
  const references = typeof alert.references === "string" ? capReferences(alert.references) : [];
  // A reference still names the message it relates to when its time does not
  // read, but only one sent at an instant is kept among the details.
  const timedReferences = references.filter((r) => capInstant(r.sent) !== undefined);
  const untimedReferences = references.length - timedReferences.length;
  // MeteoAlarm's hub writes each message's type into `incidents`; that names no incident.
  const incidents = (
    typeof alert.incidents === "string" ? capGroupList(alert.incidents) : []
  ).filter((name) => name !== capToken(alert.msgType));
  const msgType = capToken(alert.msgType);
  const relation = Object.hasOwn(RELATION_OF, msgType) ? RELATION_OF[msgType]! : "related";
  const country = opts.countryOf?.(alert) ?? countryOf(alert, feed);
  const sent = string(alert.sent)!;
  // An empty `<code/>` names no profile.
  const codes = list(alert.code).flatMap((c) => string(c) ?? []);
  // Every hazard of a message is one warning: the first VTEC event of any of them names it.
  const groupId =
    vtecGroup(
      infos.flatMap((i) => vtecEvents(pairs(i.parameter)).events),
      sent,
    ) ?? opts.groupId;
  [...groups.values()].forEach((infos, n) => {
    const info = infos[0]!;
    const categories = tokens("cap_category", info.category);
    const responses = tokens("cap_response_type", info.responseType);
    const category = categories.values;
    const responseType = responses.values;
    const event = text(infos, (i) => i.event);
    const cap = {
      status: value("cap_status", alert.status),
      msgType: value("cap_msg_type", alert.msgType),
      scope: value("cap_scope", alert.scope),
      urgency: value("cap_urgency", info.urgency),
      severity: value("cap_severity", info.severity),
      certainty: value("cap_certainty", info.certainty),
    };
    const label = value("severity", info.severity);
    const certainty = value("certainty", info.certainty);
    const location = capLocation(infos, country, opts.geometryOf);
    if (
      Object.values(cap).includes(undefined) ||
      category.length === 0 ||
      event === undefined ||
      label === undefined ||
      certainty === undefined ||
      location === undefined
    ) {
      skipped.malformed = (skipped.malformed ?? 0) + 1;
      return;
    }
    const parameters = pairs(info.parameter);
    const vtec = vtecEvents(parameters);
    // A time or language that does not read is left out, the hazard kept.
    const unknown =
      categories.unknown +
      responses.unknown +
      vtec.unread +
      untimedReferences +
      unreadTimes(info) +
      infos.reduce((sum, i) => sum + unreadLanguage(i), 0);
    if (unknown > 0) skipped.unknown_value = (skipped.unknown_value ?? 0) + unknown;
    // The first hazard keeps the message's id, so a reference to the message names a record.
    const localId = n === 0 ? alert.identifier : `${alert.identifier}#${n + 1}`;
    const c = capClassification(pairs(info.eventCode), pairs(info.parameter)) ?? {
      kind: "alert",
      type: "other",
    };
    const end = capEnd(info, opts.endOf);
    const ending =
      vtecEnding(vtec.events) ?? (responseType.includes("all_clear") ? "source_ended" : undefined);
    const validity = capValidity(alert, info, ending, end);
    const onset = capInstant(info.onset);
    const expiresAt = opts.expiresAt === undefined ? end : opts.expiresAt(end);
    const eventCodes = pairs(info.eventCode);
    const headline = text(infos, (i) => i.headline);
    const description = text(infos, (i) => i.description);
    const instruction = text(infos, (i) => i.instruction);
    const audience = text(infos, (i) => i.audience);
    const senderName = text(infos, (i) => i.senderName);
    const contact = text(infos, (i) => i.contact);
    const resources = resourcesOf(infos);
    drafts.push({
      id: situationId(feed, localId),
      class: "situation",
      kind: c.kind,
      type: c.type,
      ...optional("subtype", c.subtype),
      // A warning of an event that has not begun when it is sent is a forecast.
      temporality:
        onset !== undefined && Date.parse(onset) > Date.parse(sent) ? "forecast" : "live",
      externalIds: [{ scheme: "cap", id: alert.identifier, authority: alert.sender }],
      location,
      ...(references.length > 0
        ? {
            relations: references.map((r) => ({
              relation,
              ref: { class: "situation", id: situationId(feed, r.identifier) },
            })),
          }
        : {}),
      provenance: provenance(feed, alert.identifier, sent),
      freshness: freshness(opts.fetchedAt, expiresAt),
      planned: false,
      certainty,
      severity:
        label === "unknown"
          ? { label, declaredRaw: info.severity }
          : { label, source: "declared", declaredRaw: info.severity },
      ...optional("headline", headline),
      ...optional("description", description),
      ...optional("instruction", instruction),
      validity,
      effects: [],
      groupId,
      details: {
        kind: "alert",
        v: 1,
        cap: {
          identifier: alert.identifier,
          sender: alert.sender,
          sent,
          status: cap.status,
          msgType: cap.msgType,
          scope: cap.scope,
          ...(timedReferences.length > 0 ? { references: timedReferences } : {}),
          ...(codes.length === 0 ? {} : { codes }),
          category,
          event,
          ...(eventCodes.length === 0 ? {} : { eventCodes }),
          ...(responseType.length > 0 ? { responseType } : {}),
          urgency: cap.urgency,
          severity: cap.severity,
          certainty: cap.certainty,
          ...optional("audience", audience),
          ...optional("effective", capInstant(info.effective)),
          ...optional("onset", onset),
          ...optional("expires", capInstant(info.expires)),
          ...optional("ends", capInstant(info.ends)),
          ...(parameters.length === 0 ? {} : { parameters }),
          ...(vtec.events.length === 0 ? {} : { vtec: vtec.events }),
          ...optional("web", webOf(info.web)),
          ...optional("localizedWeb", localizedWeb(infos)),
          ...optional("senderName", senderName),
          ...optional("contact", contact),
          ...optional("source", string(alert.source)),
          ...optional("note", string(alert.note)),
          ...(incidents.length > 0 ? { incidents } : {}),
          ...verticalExtent(list(info.area)),
          ...(resources.length > 0 ? { resources } : {}),
        },
      },
    });
  });
  return { drafts, skipped };
}

/**
 * One CAP message as `alert` situations: one per hazard it warns of, with
 * every language of it. Ids `oc:situation:<feed>:<identifier>`, `#<n>` for
 * the second and later hazards; `Update` relates `update_of` the messages it
 * references, `Cancel` `cancels` them and is itself `cancelled`, an
 * `AllClear` response ends the warning. A hazard whose CAP does not read is
 * left out.
 */
export function capSituations(
  alert: CapAlert,
  feed: HazardsFeed,
  opts: CapSituationOptions,
): RecordDraft[] {
  return capDrafts(alert, feed, opts).drafts;
}
