import { SaxesParser, type SaxesTagNS } from "saxes";
import type { RoadEvent } from "./model.js";
import { canonicalSnapshotValue, type RoadSnapshotReport } from "./snapshot.js";
import type { SourceDescriptor } from "./types.js";

const WFS = "http://www.opengis.net/wfs/2.0";
const GML = "http://www.opengis.net/gml/3.2";
const MS = "http://mapserver.gis.umn.edu/mapserver";
const MAX_MEMBERS = 100_000;
const OUT_OF_SCOPE = new Set([
  "244.1",
  "250",
  "251",
  "257-57",
  "260",
  "261",
  "263",
  "264",
  "266",
  "269",
]);
const integer = (v: string | undefined) =>
  v !== undefined && /^(0|[1-9]\d*)$/.test(v) && Number.isSafeInteger(Number(v))
    ? Number(v)
    : undefined;
const attr = (tag: SaxesTagNS, name: string) => tag.attributes[name]?.value;

/** A complete SEVAS WFS document, including dispositions for excluded or unplaced segments. */
export function parseSevasSnapshot(
  input: string | Buffer,
  src: SourceDescriptor,
): RoadSnapshotReport {
  const report: RoadSnapshotReport = { inputCount: 0, records: [], errors: [] };
  const stack: SaxesTagNS[] = [];
  let matched: number | undefined;
  let returned: number | undefined;
  let rootSeen = false;
  let member = false;
  let recordSeen = false;
  let p: Record<string, string> | undefined;
  let field: string | undefined;
  let value = "";
  let position = "";
  let crs: string | undefined;
  let dimension: string | undefined;
  let lineCount = 0;
  let posCount = 0;
  const now = new Date().toISOString();
  const fail = (message: string): never => {
    throw new Error(`sevas: ${message}`);
  };

  function finishRecord() {
    if (!p) return fail("member has no restriction segment");
    const local = integer(p["segment_id"]);
    if (local === undefined) return fail("missing or invalid segment_id");
    const id = `${src.id}:segment-${local}`;
    if (!/^\d{3}(?:[.-]\d{1,2})?$/.test(p["typ"] ?? "")) return fail(`invalid sign type for ${id}`);
    const base = {
      id,
      version: null,
      versionTime: null,
      fingerprint: canonicalSnapshotValue({
        properties: p,
        crs,
        dimension,
        position: position.trim().split(/\s+/).map(Number),
      }),
    };
    if (OUT_OF_SCOPE.has(p["typ"]!)) {
      report.records.push({ ...base, disposition: "terminal" });
      return;
    }
    const numbers = position.trim().split(/\s+/).map(Number);
    const coordinates: number[][] = [];
    const supported = crs === "urn:ogc:def:crs:EPSG::4326";
    if (
      supported &&
      dimension === "2" &&
      lineCount === 1 &&
      posCount === 1 &&
      numbers.length >= 4 &&
      numbers.length % 2 === 0
    ) {
      for (let i = 0; i < numbers.length; i += 2) coordinates.push([numbers[i + 1]!, numbers[i]!]);
    }
    if (
      coordinates.length < 2 ||
      coordinates.some(
        ([lon, lat]) =>
          !Number.isFinite(lon) ||
          !Number.isFinite(lat) ||
          Math.abs(lon!) > 180 ||
          Math.abs(lat!) > 90,
      ) ||
      !coordinates.some((c) => c[0] !== coordinates[0]![0] || c[1] !== coordinates[0]![1])
    ) {
      report.records.push({ ...base, disposition: "unlocatable" });
      return;
    }
    const sign = p["typ"];
    const classification =
      sign === "253"
        ? { kind: "restriction", type: "access", subtype: "truck_ban" }
        : sign === "262" || sign === "265"
          ? {
              kind: "restriction",
              type: "dimension",
              subtype: sign === "262" ? "weight" : "height",
            }
          : { kind: "restriction", type: "access" };
    const direction =
      p["fahrtri"] === "0"
        ? "both"
        : p["fahrtri"] === "1"
          ? "positive"
          : p["fahrtri"] === "2"
            ? "negative"
            : "unknown";
    const event: RoadEvent = {
      id,
      source: src.id,
      sourceFormat: "sevas",
      domain: "roads",
      kind: "event",
      type: "dimension_restriction",
      category: "conditions",
      isPlanned: false,
      severity: "unknown",
      severitySource: "derived",
      status: "active",
      geometry: { type: "LineString", coordinates },
      directionRef: { basis: "geometry", value: direction },
      headline: `SEVAS ${sign}${p["name"] ? `: ${p["name"]}` : ""}`,
      roads: p["name"] ? [{ name: p["name"] }] : [],
      situation: {
        classification,
        externalIds: ["restrkn_id", "osm_id", "osm_vers"].flatMap((key) =>
          p![key] ? [{ scheme: "provider", id: `${key}:${p![key]}`, authority: src.id }] : [],
        ),
      },
      sourceRaw: p,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: now,
      fetchedAt: now,
      isStale: false,
    };
    report.records.push({ ...base, disposition: "accepted", event });
  }

  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => fail("DOCTYPE is not supported"));
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    stack.push(tag);
    if (stack.length === 1) {
      if (rootSeen || tag.uri !== WFS || tag.local !== "FeatureCollection")
        fail("expected WFS FeatureCollection");
      rootSeen = true;
      matched = integer(attr(tag, "numberMatched"));
      returned = integer(attr(tag, "numberReturned"));
      if (
        matched === undefined ||
        returned === undefined ||
        matched > MAX_MEMBERS ||
        matched !== returned ||
        attr(tag, "next")
      )
        fail("incomplete or capped FeatureCollection");
    } else if (stack.length === 2 && tag.uri === WFS && tag.local === "member") {
      member = true;
      recordSeen = false;
      p = undefined;
      if (++report.inputCount > MAX_MEMBERS) fail("member limit exceeded");
    } else if (member && stack.length === 3) {
      if (recordSeen || tag.uri !== MS || tag.local !== "restriktionen_segmente")
        fail("unexpected WFS member");
      recordSeen = true;
      p = {};
      position = "";
      crs = undefined;
      dimension = undefined;
      lineCount = 0;
      posCount = 0;
    } else if (p && stack.length === 4 && tag.uri === MS && tag.local !== "msGeometry") {
      field = tag.local;
      if (Object.hasOwn(p, field) || Object.keys(p).length >= 100)
        fail("duplicate or excessive segment fields");
      value = "";
    } else if (field) fail("nested scalar field");
    if (
      p &&
      parent?.local === "msGeometry" &&
      parent.uri === MS &&
      tag.uri === GML &&
      tag.local === "LineString"
    ) {
      lineCount++;
      crs = attr(tag, "srsName");
    }
    if (
      p &&
      parent?.local === "LineString" &&
      parent.uri === GML &&
      tag.uri === GML &&
      tag.local === "posList"
    ) {
      posCount++;
      dimension = attr(tag, "srsDimension") ?? attr(parent, "srsDimension");
    }
  });
  const text = (s: string) => {
    if (field) {
      value += s;
      if (value.length > 4096) fail("scalar field limit exceeded");
    } else if (stack.at(-1)?.uri === GML && stack.at(-1)?.local === "posList" && p) position += s;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", (tag) => {
    if (field && stack.length === 4) {
      p![field] = value.trim();
      field = undefined;
    }
    if (member && stack.length === 3) finishRecord();
    if (stack.length === 2 && tag.uri === WFS && tag.local === "member") {
      if (!recordSeen) fail("empty WFS member");
      member = false;
      p = undefined;
    }
    stack.pop();
  });
  parser.write(input.toString()).close();
  if (!rootSeen || matched !== report.inputCount || returned !== report.records.length)
    fail("member count mismatch");
  return report;
}
