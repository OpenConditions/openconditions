import { createHash } from "node:crypto";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { observationId } from "@openconditions/model";
import type { RoadFeed } from "./feed-schema.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const text = (v: unknown): string =>
  typeof v === "string" && v.trim() !== "Not Reported" ? v.trim() : "";
const clock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
/** Accept only a single matching instant: gaps and folds carry no inferred instant. */
export function cmsTime(date: unknown, time: unknown): string | undefined {
  const wall = `${text(date)}T${text(time)}`;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(wall) || Number(wall.slice(0, 4)) <= 1970)
    return undefined;
  const base = Date.parse(`${wall}Z`);
  if (!Number.isFinite(base)) return undefined;
  const matches = [7, 8]
    .map((h) => new Date(base + h * 3600000))
    .filter((d) => clock.format(d).replace(" ", "T") === wall);
  return matches.length === 1 ? matches[0]?.toISOString() : undefined;
}

/** Agency CMS only; district is configuration, never the unreliable wire district. */
export function parseCaltransCms(
  feed: RoadFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  if (
    !Number.isInteger(feed.caltransDistrict) ||
    feed.caltransDistrict! < 1 ||
    feed.caltransDistrict! > 12
  )
    throw new Error("caltrans-cms requires configured district 1..12");
  const bodies = payloads["main"] ?? [];
  if (bodies.length !== 1) throw new Error("caltrans-cms requires exactly one district payload");
  const doc = obj(JSON.parse(bodies[0]!.toString("utf8")));
  if (!Array.isArray(doc["data"])) throw new Error("caltrans-cms data must be an array");
  const out = emptyParseOutput();
  out.featuresComplete = feed.caltransSnapshotQualified === true;
  const seen = new Set<string>();
  const freshness = {
    fetchedAt: ctx.fetchedAt,
    expiresAt: new Date(
      Date.parse(ctx.fetchedAt) + (feed.freshnessWindowSec ?? 900) * 1000,
    ).toISOString(),
  };
  for (const row of doc["data"]) {
    const raw = obj(obj(row)["cms"]),
      loc = obj(raw["location"]),
      message = obj(raw["message"]);
    const name = text(loc["locationName"]),
      index = text(raw["index"]);
    if (!name) {
      out.featuresComplete = false;
      recordSkipped(feed.id, "malformed");
      continue;
    }
    // Road position disambiguates repeated names; coordinates/index are correctable diagnostics.
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          feed.caltransDistrict,
          name,
          ...[
            "county",
            "route",
            "routeSuffix",
            "direction",
            "postmilePrefix",
            "postmile",
            "alignment",
          ].map((k) => text(loc[k])),
        ]),
      )
      .digest("hex");
    if (seen.has(key)) throw new Error("ambiguous Caltrans CMS identity");
    seen.add(key);
    if (!index) {
      out.featuresComplete = false;
      recordSkipped(feed.id, "malformed");
      continue;
    }
    const lon = Number(text(loc["longitude"])),
      lat = Number(text(loc["latitude"]));
    if (
      !text(loc["longitude"]) ||
      !text(loc["latitude"]) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      lon < -125 ||
      lon > -114 ||
      lat < 32 ||
      lat > 42.1
    ) {
      out.featuresComplete = false;
      recordSkipped(feed.id, "no_geometry");
      continue;
    }
    const id = `oc:feature:${feed.id}:${key}`;
    const location = {
      geometry: { type: "Point", coordinates: [lon, lat] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
    };
    const provenance = {
      origin: "feed",
      sourceId: feed.id,
      sourceFormat: feed.format,
      accessMode: feed.accessMode ?? "bulk",
      recordId: key,
      attribution: {
        provider: feed.attribution,
        license: feed.license,
        licenseUrl: feed.licenseUrl,
      },
      privacy: { class: "authoritative" },
    };
    const record = obj(raw["recordTimestamp"]),
      change = obj(message["messageTimestamp"]);
    const modified = cmsTime(record["recordDate"], record["recordTime"]);
    const changed = cmsTime(change["messageDate"], change["messageTime"]);
    const extras = {
      caltransCms: {
        district: feed.caltransDistrict,
        index,
        recordTimestamp: record,
        messageTimestamp: change,
        ...(modified ? { recordModifiedAt: modified } : {}),
        ...(changed ? { messageChangedAt: changed } : {}),
        displayTime: message["displayTime"],
        phase1Font: obj(message["phase1"])["phase1Font"],
        phase2Font: obj(message["phase2"])["phase2Font"],
      },
    };
    out.features.push({
      id,
      class: "feature",
      kind: "vms",
      type: "other",
      temporality: "static",
      lifecycle: "operational",
      location,
      provenance,
      freshness,
      name: [{ lang: "en", text: name }],
      components: [
        { key: "0", kind: "sign_face", details: { kind: "sign_face", v: 1, vmsIndex: 0 } },
      ],
      details: { kind: "vms", v: 1 },
      extras,
    });
    const service = text(raw["inService"]).toLowerCase(),
      mode = text(message["display"]);
    let status =
      service === "false"
        ? "out_of_service"
        : service === "true" && mode === "Blank"
          ? "blank"
          : service === "true" &&
              ["1 Page (Normal)", "1 Page (Flashing)", "2 Pages (Extended)"].includes(mode)
            ? "in_service"
            : "unknown";
    const pages = [];
    if (status === "in_service")
      for (let p = 1; p <= (mode === "2 Pages (Extended)" ? 2 : 1); p++) {
        const phase = obj(message[`phase${p}`]);
        const lines = [1, 2, 3].map((n) => phase[`phase${p}Line${n}`]);
        if (lines.some((l) => typeof l !== "string" || l.trim() === "Not Reported")) {
          status = "unknown";
          break;
        }
        pages.push({
          page: p,
          lines: lines.map((l) => [{ lang: "en", text: text(l) || " " }]),
        });
      }
    const draft = {
      class: "observation",
      kind: "observation",
      property: "vms.display",
      temporality: "live",
      location,
      provenance,
      freshness,
      subject: { kind: "feature", featureId: id, componentKey: "0" },
      result: {
        type: "structured",
        schema: "vms_display",
        v: 1,
        value: {
          v: 1,
          workingStatus: status,
          messages:
            status === "in_service"
              ? [{ index: 0, text: pages, flashing: mode === "1 Page (Flashing)" }]
              : [],
        },
      },
      phenomenonTime: { instant: ctx.fetchedAt },
      aggregation: "instantaneous",
      extras,
    };
    out.observations.push({ id: observationId(feed.id, draft as never), ...draft });
  }
  return out;
}
