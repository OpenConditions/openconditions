import type { RecordDraft } from "@openconditions/ingest-framework";
import {
  type CapPair,
  capCircle,
  capClassification,
  capPolygon,
  capReferences,
  hazardsCrosswalk,
} from "@openconditions/model-hazards";
import type { Geometry, Position } from "geojson";
import { pointInRing } from "../geometry.js";
import { freshness, type HazardsFeed, provenance, situationId, UNLOCATED } from "../records.js";
import { capToken } from "./messages.js";
import type { CapAlert, CapArea, CapInfo } from "./types.js";

/** A shape a format supplies for an area CAP names only by its codes (an NWS zone, a MeteoAlarm region). */
export interface DerivedShape {
  geometry: Geometry;
  origin: "derived";
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
    return value === undefined ? [] : [{ lang: string(i.language) ?? "en-US", text: value }];
  });
  return parts.length > 0 ? parts : undefined;
}

const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });

/**
 * An info block's areas as one geometry. Polygons are the source's; DWD
 * sends the islands and lakes a district's outline does not cover as
 * `EXCLUDE_POLYGON` geocodes, which become holes of the polygon they lie in.
 * A circle, a polygon split at the antimeridian and a shape the format
 * supplies for a code-only area are derived; an area with only codes and no
 * supplied shape has no geometry. Undefined when a shape CAP gives does not
 * read (a position out of range, an open ring): the record is rejected.
 */
function capGeometry(
  areas: readonly CapArea[],
  geometryOf: CapSituationOptions["geometryOf"],
): { geometry: Geometry | null; derived: boolean } | undefined {
  const polygons: Position[][][] = [];
  const shapes: Geometry[] = [];
  let derived = false;
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
  return { geometry, derived };
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
  return {
    geometry: shape.geometry,
    extent: "area",
    geometryOrigin: shape.geometry === null ? "none" : shape.derived ? "derived" : "source",
    fuzziness: "exact",
    ...(country === undefined
      ? {}
      : { admin: geocodes.length > 0 ? { country, geocodes } : { country } }),
    ...optional("areaDescription", description),
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
    list(i.area).map((a) => [a.polygon, a.circle, a.geocode]),
  ]);

/** When a hazard stops being in force: the format's end if it states one, the message's `expires` otherwise. */
export function capEnd(
  info: CapInfo,
  endOf: CapSituationOptions["endOf"] | undefined,
): string | undefined {
  return string(endOf === undefined ? info.expires : endOf(info));
}

/**
 * A warning is in force from when its message takes effect (`effective`,
 * which CAP defaults to `sent`) until its end (`capEnd`). The event it
 * warns of may begin later, even after the message expires (an NWS watch is
 * reissued before its hazard starts), so `onset` stays in the details. A
 * message that ends before it takes effect is in force for no time.
 */
function capValidity(alert: CapAlert, info: CapInfo, allClear: boolean, end: string | undefined) {
  let start = string(info.effective) ?? string(alert.sent)!;
  if (end !== undefined && Date.parse(start) > Date.parse(end)) start = end;
  const status = capToken(alert.msgType) === "Cancel" ? "cancelled" : allClear ? "ended" : "active";
  return {
    status,
    start,
    ...optional("end", end),
    ...(status === "cancelled"
      ? { endedReason: "cancelled" }
      : status === "ended"
        ? { endedReason: "source_ended" }
        : {}),
  };
}

/** The relation a message's references have to the messages they name. */
const RELATION_OF: Readonly<Record<string, string>> = {
  Update: "update_of",
  Cancel: "cancels",
  Ack: "related",
  Error: "related",
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
 * A message's situations, and how many of its hazards could not be read
 * (a vocabulary token the registry does not know, a shape out of range):
 * each is rejected, never the message's other hazards.
 */
export function capDrafts(
  alert: CapAlert,
  feed: HazardsFeed,
  opts: CapSituationOptions,
): { drafts: RecordDraft[]; rejected: number } {
  const groups = new Map<string, CapInfo[]>();
  for (const info of list(alert.info)) {
    const key = signature(info);
    groups.set(key, [...(groups.get(key) ?? []), info]);
  }
  const references = typeof alert.references === "string" ? capReferences(alert.references) : [];
  const msgType = capToken(alert.msgType);
  const relation = Object.hasOwn(RELATION_OF, msgType) ? RELATION_OF[msgType]! : "related";
  const country = opts.countryOf?.(alert) ?? countryOf(alert, feed);
  const sent = string(alert.sent)!;
  const drafts: RecordDraft[] = [];
  let rejected = 0;
  [...groups.values()].forEach((infos, n) => {
    const info = infos[0]!;
    const category = list(info.category).map((x) => value("cap_category", x));
    const responseType = list(info.responseType).map((r) => value("cap_response_type", r));
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
      category.includes(undefined) ||
      responseType.includes(undefined) ||
      event === undefined ||
      label === undefined ||
      certainty === undefined ||
      location === undefined
    ) {
      rejected++;
      return;
    }
    // The first hazard keeps the message's id, so a reference to the message names a record.
    const localId = n === 0 ? alert.identifier : `${alert.identifier}#${n + 1}`;
    const c = capClassification(pairs(info.eventCode), pairs(info.parameter)) ?? {
      kind: "alert",
      type: "other",
    };
    const end = capEnd(info, opts.endOf);
    const validity = capValidity(alert, info, responseType.includes("all_clear"), end);
    const onset = string(info.onset);
    const expiresAt = opts.expiresAt === undefined ? end : opts.expiresAt(end);
    const eventCodes = pairs(info.eventCode);
    const parameters = pairs(info.parameter);
    const headline = text(infos, (i) => i.headline);
    const description = text(infos, (i) => i.description);
    const instruction = text(infos, (i) => i.instruction);
    const audience = text(infos, (i) => i.audience);
    const senderName = text(infos, (i) => i.senderName);
    const contact = text(infos, (i) => i.contact);
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
      groupId: opts.groupId,
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
          ...(references.length > 0 ? { references } : {}),
          ...(list(alert.code).length === 0 ? {} : { codes: list(alert.code) }),
          category,
          event,
          ...(eventCodes.length === 0 ? {} : { eventCodes }),
          ...(responseType.length > 0 ? { responseType } : {}),
          urgency: cap.urgency,
          severity: cap.severity,
          certainty: cap.certainty,
          ...optional("audience", audience),
          ...optional("effective", string(info.effective)),
          ...optional("onset", onset),
          ...optional("expires", string(info.expires)),
          ...(parameters.length === 0 ? {} : { parameters }),
          ...optional("web", webOf(info.web)),
          ...optional("senderName", senderName),
          ...optional("contact", contact),
        },
      },
    });
  });
  return { drafts, rejected };
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
