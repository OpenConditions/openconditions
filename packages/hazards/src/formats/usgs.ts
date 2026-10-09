import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { Point } from "geojson";
import { accountSituations } from "../accounting.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { pointGeometry } from "../geometry.js";
import {
  freshness,
  isRecord,
  pointLocation,
  provenance,
  situationId,
  utcInstant,
} from "../records.js";

/** The PAGER alert levels as the severity they declare. */
const PAGER: Readonly<Record<string, string>> = {
  green: "minor",
  yellow: "moderate",
  orange: "major",
  red: "critical",
};

interface Quake {
  id: string;
  /** Every network id the event is known by, this one included. */
  ids: string[];
  properties: Record<string, unknown>;
  point: Point;
  depthKm?: number;
  time: number;
  updated: number;
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** The features of a summary feed; anything but a GeoJSON feature collection fails the parse. */
function featuresOf(body: Buffer): unknown[] {
  const root: unknown = JSON.parse(body.toString("utf8"));
  const features = isRecord(root) ? root["features"] : undefined;
  if (!Array.isArray(features)) throw new Error("USGS answered no feature collection");
  return features;
}

/** A feature as an event: its own id, a position and an origin time, or null. */
function quakeOf(feature: unknown): Quake | null {
  if (!isRecord(feature)) return null;
  const properties = feature["properties"];
  const id = text(feature["id"]);
  if (id === undefined || !isRecord(properties)) return null;
  const geometry = feature["geometry"];
  const point = pointGeometry(geometry);
  const time = finite(properties["time"]);
  if (point === null || time === undefined || Number.isNaN(new Date(time).getTime())) return null;
  const depthKm = finite(
    isRecord(geometry) ? (geometry["coordinates"] as unknown[])[2] : undefined,
  );
  const listed = (text(properties["ids"]) ?? "").split(",").filter((part) => part !== "");
  return {
    id,
    ids: listed.includes(id) ? listed : [id, ...listed],
    properties,
    point,
    ...(depthKm === undefined ? {} : { depthKm }),
    time,
    updated: finite(properties["updated"]) ?? time,
  };
}

function toDraft(
  quake: Quake,
  ids: readonly string[],
  feed: HazardsCatalogFeed,
  fetchedAt: string,
): RecordDraft {
  const p = quake.properties;
  const time = utcInstant(new Date(quake.time));
  const alert = text(p["alert"])?.toLowerCase();
  const severity = alert === undefined ? undefined : PAGER[alert];
  const mag = finite(p["mag"]);
  const scale = text(p["magType"]);
  const place = text(p["place"]);
  const title = text(p["title"]);
  // Only a web page is a detail page: a `javascript:` or `data:` value is left out.
  const page = text(p["url"]);
  const url = page !== undefined && /^https?:\/\//.test(page) ? page : undefined;
  const felt = finite(p["felt"]);
  const mmi = finite(p["mmi"]);
  const status = text(p["status"]);
  return {
    id: situationId(feed, quake.id),
    class: "situation",
    kind: "natural_hazard",
    type: "earthquake",
    temporality: "live",
    externalIds: ids.map((id) => ({ scheme: "usgs:event", id })),
    location: pointLocation(quake.point.coordinates as [number, number]),
    provenance: provenance(feed, quake.id, utcInstant(new Date(quake.updated))),
    // An earthquake is read by the window its origin time falls in, so the record must
    // outlive any window a reader asks for: no expiry.
    freshness: freshness(fetchedAt),
    planned: false,
    certainty: "observed",
    severity:
      severity === undefined
        ? { label: "unknown" }
        : { label: severity, source: "declared", declaredRaw: alert },
    ...(title === undefined ? {} : { headline: [{ lang: "en", text: title }] }),
    validity: { status: "ended", start: time, end: time },
    effects: [],
    details: {
      kind: "natural_hazard",
      v: 1,
      ...(place === undefined ? {} : { name: [{ lang: "en", text: place }] }),
      ...(url === undefined ? {} : { detailUrl: url }),
      ...(mag === undefined || scale === undefined ? {} : { magnitude: { value: mag, scale } }),
      ...(quake.depthKm === undefined
        ? {}
        : { depth: { value: Math.round(quake.depthKm * 1e6) / 1e3, unit: "m" } }),
      ...(p["tsunami"] === 0 || p["tsunami"] === 1 ? { tsunamiFlag: p["tsunami"] === 1 } : {}),
      ...(felt === undefined || felt < 0 || !Number.isInteger(felt) ? {} : { feltReports: felt }),
      ...(mmi === undefined || mmi < 0 || mmi > 12 ? {} : { mmi }),
      ...(status === undefined ? {} : { reviewed: status === "reviewed" }),
    },
  };
}

/**
 * The `usgs` format: USGS's earthquake summary feeds as `natural_hazard`
 * situations of type `earthquake`. The `recent` role (the last day) is
 * fresher and the `window` role (the last month) catches late revisions and
 * deletions; their union is taken by event id, the larger `updated` winning.
 * The preferred id of an event can change when another network's solution
 * becomes preferred, so features that share an entry of their `ids` list are
 * one event, kept under the newer feature's id with every id listed as an
 * external id.
 *
 * Only `type: "earthquake"` is an earthquake: explosions, quarry blasts and
 * ice quakes are terminal. An earthquake has no extent in time, so its
 * validity starts and ends at the origin time and carries no expiry: it is
 * read by the time window it falls in. A null magnitude is left out, a depth
 * above sea level stays negative, and the tsunami flag is the publisher's
 * oceanic-region flag, not a warning. A feature with no id, position or
 * origin time is rejected and counted; a body that is no feature collection
 * fails the parse.
 */
export function parseUsgs(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const byId = new Map<string, Quake>();
  let inputCount = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const role of ["recent", "window"]) {
    for (const body of payloads[role] ?? []) {
      for (const feature of featuresOf(body)) {
        inputCount++;
        const quake = quakeOf(feature);
        if (quake === null) {
          rejected++;
          continue;
        }
        const held = byId.get(quake.id);
        if (held === undefined) {
          byId.set(quake.id, quake);
          continue;
        }
        duplicates++;
        if (quake.updated > held.updated) byId.set(quake.id, quake);
      }
    }
  }

  let terminal = 0;
  const events: Quake[] = [];
  for (const quake of byId.values()) {
    if (text(quake.properties["type"]) === "earthquake") events.push(quake);
    else terminal++;
  }

  // Features that share an id are one event: the newest of the group stands for it.
  const parent = events.map((_, i) => i);
  const root = (i: number): number => {
    let at = i;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]!]!;
      at = parent[at]!;
    }
    return at;
  };
  const owner = new Map<string, number>();
  events.forEach((quake, i) => {
    for (const id of quake.ids) {
      const first = owner.get(id);
      if (first === undefined) owner.set(id, i);
      else parent[root(i)] = root(first);
    }
  });
  const groups = new Map<number, Quake[]>();
  events.forEach((quake, i) => {
    const key = root(i);
    groups.set(key, [...(groups.get(key) ?? []), quake]);
  });

  const folded: Record<string, number> = {};
  for (const group of groups.values()) {
    const newest = group.reduce((a, b) => (b.updated > a.updated ? b : a));
    const draft = toDraft(
      newest,
      [...new Set(group.flatMap((quake) => quake.ids))],
      feed,
      ctx.fetchedAt,
    );
    out.situations.push(draft);
    folded[String(draft["id"])] = group.length;
  }

  accountSituations(out, { inputCount, duplicates, rejected, terminal, folded });
  return out;
}
