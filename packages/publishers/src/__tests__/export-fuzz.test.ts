import {
  draftProblems,
  fuzzParameters,
  fuzzTimeout,
  type JsonValidator,
  jsonSchemaValidator,
  pinnedOrUnavailable,
  type SchemaFile,
  xmlCharProblems,
  xsdErrors,
} from "@openconditions/conformance";
import {
  DATEX2_V3,
  MESSAGE_CONTAINER_SCHEMA,
} from "@openconditions/conformance/standards/datex2-v3";
import { GEOJSON } from "@openconditions/conformance/standards/geojson";
import fc from "fast-check";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parquetReadObjects } from "hyparquet";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExportDiagnostic } from "../export-diagnostics.js";
import { featuresToGeoJSON, featuresToJsonLd } from "../feature-geojson.js";
import { type ArchivableRecord, publishedRecords, recordArchiveBuffer } from "../record-archive.js";
import { segmentConditionsToJson } from "../segment-conditions.js";
import { situationsToDatex } from "../situation-datex.js";
import { situationsToGeoJSON, situationsToJsonLd } from "../situation-geojson.js";
import { situationsToTraff } from "../situation-traff.js";
import { diffRecords, sseFrame } from "../sse.js";
import { segmentConditionsToExclusions } from "../valhalla.js";
import { rfc7946Violations } from "./rfc7946-checks.js";
import { segmentRow } from "./segment-rows.js";
import { situationArbitraries, wayGeometry } from "./situation-arbitrary.js";

type Rec = Record<string, unknown>;

/**
 * Random situations the model accepts, through every exporter: the output is
 * well formed, holds only characters its format can carry, and validates
 * against the standard's own schema where one is pinned. The situations come
 * from the registry's kinds, effects and published schemas
 * (`situation-arbitrary.ts`), with awkward text, language tags, times and
 * coordinates.
 */

const AT = new Date("2026-09-06T10:00:00Z");
const NOW = "2026-09-06T10:00:00Z";
const INFO = { timestamp: NOW, attribution: "OpenConditions" };
const arbitraries = situationArbitraries();
const { registry } = arbitraries;
/** A batch of situations per document: XSD validation costs per document, not per record. */
const batch = arbitraries.situations(8);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === "message" || name === "event",
});

/** What makes an emitted XML document unreadable: malformed text or characters XML 1.0 forbids. */
function xmlProblems(xml: string): string[] {
  const wellFormed = XMLValidator.validate(xml);
  return [
    ...(wellFormed === true ? [] : [`not well formed: ${JSON.stringify(wellFormed.err)}`]),
    ...xmlCharProblems(xml),
  ];
}

/** What is wrong with an export diagnostic: each names a code, a scope and a JSON pointer. */
const diagnosticProblems = (diagnostics: readonly ExportDiagnostic[]) =>
  diagnostics.flatMap((d) =>
    typeof d.code === "string" && typeof d.path === "string" && d.path.startsWith("/")
      ? []
      : [JSON.stringify(d)],
  );

describe("situationsToDatex over random situations", () => {
  let schemas: SchemaFile[] = [];
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DATEX2_V3);
    if ("files" in pinned) schemas = pinned.files;
    else unavailable = pinned.unavailable;
  }, 120_000);

  it(
    "writes well-formed XML the DATEX II v3 schemas accept",
    async ({ skip }) => {
      if (unavailable) skip(unavailable);
      await fc.assert(
        fc.asyncProperty(batch, async (situations) => {
          const xml = situationsToDatex(situations, AT, INFO, "de");
          expect(xmlProblems(xml)).toEqual([]);
          expect(await xsdErrors(xml, schemas, MESSAGE_CONTAINER_SCHEMA, "fuzz.xml")).toEqual([]);
        }),
        fuzzParameters(25),
      );
    },
    fuzzTimeout(20_000),
  );
});

/** TraFF 0.8 coordinates: signed decimal degrees, latitude then longitude. */
const TRAFF_COORDINATES = /^[+-]\d+(?:\.\d+)? [+-]\d+(?:\.\d+)?$/;
/** TraFF timestamps, to the second, in UTC. */
const TRAFF_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/** What a TraFF reader would reject in a feed's messages. */
function traffProblems(xml: string): string[] {
  const out: string[] = [];
  const feed = (xmlParser.parse(xml) as { feed?: { message?: Rec[] } | "" }).feed;
  const messages = typeof feed === "object" ? (feed.message ?? []) : [];
  for (const m of messages) {
    const id = String(m["@_id"]);
    for (const key of [
      "@_receive_time",
      "@_update_time",
      "@_start_time",
      "@_end_time",
      "@_expiration_time",
    ]) {
      const value = m[key];
      if (value !== undefined && !TRAFF_TIME.test(String(value)))
        out.push(`${id} ${key}: ${String(value)}`);
    }
    const location = m["location"] as Rec | undefined;
    for (const key of ["from", "at", "to"]) {
      const point = location?.[key];
      if (point === undefined) continue;
      const coordinates = typeof point === "string" ? point : String((point as Rec)["#text"]);
      if (!TRAFF_COORDINATES.test(coordinates)) out.push(`${id} ${key}: ${coordinates}`);
    }
    const events = ((m["events"] as Rec | undefined)?.["event"] as Rec[] | undefined) ?? [];
    if (events.length === 0) out.push(`${id}: no event`);
    for (const e of events) {
      for (const key of ["@_speed", "@_length"]) {
        const value = e[key];
        if (value !== undefined && !/^\d+$/.test(String(value)))
          out.push(`${id} ${key}: ${String(value)}`);
      }
      const duration = e["@_q_duration"];
      if (duration !== undefined && !/^\d+:[0-5]\d$/.test(String(duration))) {
        out.push(`${id} q_duration: ${String(duration)}`);
      }
    }
  }
  return out;
}

describe("situationsToTraff over random situations", () => {
  it(
    "writes well-formed XML whose times, coordinates and quantifiers TraFF can read",
    () => {
      fc.assert(
        fc.property(batch, (situations) => {
          const diagnostics: ExportDiagnostic[] = [];
          const xml = situationsToTraff(registry, situations, AT, (d) => diagnostics.push(d));
          expect(xmlProblems(xml)).toEqual([]);
          expect(traffProblems(xml)).toEqual([]);
          expect(diagnosticProblems(diagnostics)).toEqual([]);
        }),
        fuzzParameters(150),
      );
    },
    fuzzTimeout(5_000),
  );
});

describe("GeoJSON emitters over random situations", () => {
  let validators: Map<string, JsonValidator> | undefined;
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(GEOJSON);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    validators = new Map(
      pinned.files.map((f) => [
        f.fileName.replace(/\.json$/, ""),
        jsonSchemaValidator(JSON.parse(f.contents) as Rec),
      ]),
    );
  }, 120_000);

  it(
    "write valid RFC 7946 collections that survive JSON",
    ({ skip }) => {
      if (unavailable) skip(unavailable);
      const valid = validators!.get("FeatureCollection")!;
      fc.assert(
        fc.property(batch, (situations) => {
          for (const doc of [
            situationsToGeoJSON(situations, INFO, { at: AT }),
            situationsToJsonLd(situations, INFO, { at: AT }),
            featuresToGeoJSON(situations, INFO),
            featuresToJsonLd(situations, INFO),
          ]) {
            // Nothing JSON cannot carry (a function, a non-finite number),
            // no time that is not an instant and no invalid geometry.
            expect(draftProblems([doc])).toEqual([]);
            const json = JSON.parse(JSON.stringify(doc)) as Rec;
            expect(valid(json)).toEqual([]);
            expect(rfc7946Violations(json)).toEqual([]);
            expect((json["features"] as unknown[]).length).toBe(situations.length);
          }
        }),
        fuzzParameters(150),
      );
    },
    fuzzTimeout(5_000),
  );
});

describe("routing emitters over the effects of random situations", () => {
  it(
    "list bound effects with valid spans and turn them into Valhalla exclusions",
    () => {
      const rows = fc.tuple(batch, fc.array(wayGeometry, { minLength: 1, maxLength: 3 }));
      fc.assert(
        fc.property(rows, ([situations, geometries]) => {
          const bound = situations.flatMap((s) =>
            (s["effects"] as Rec[]).map((effect) =>
              segmentRow({
                record_id: String(s["id"]),
                effect_id: String(effect["id"]),
                kind: String(s["kind"]),
                type: String(s["type"]),
                subtype: (s["subtype"] as string | undefined) ?? null,
                validity: s["validity"] as never,
                effect: effect as never,
                segments: geometries.map((geometry, i) => ({
                  segmentId: `${i}:f`,
                  wayId: i,
                  dir: i % 2 === 0 ? "f" : "b",
                  startFraction: 0,
                  endFraction: 1,
                  geometry: geometry as never,
                })),
              }),
            ),
          );
          const json = segmentConditionsToJson(bound, AT, { resolverVersion: "2.0.0" });
          expect(draftProblems([json])).toEqual([]);
          const out = segmentConditionsToExclusions(json.conditions, { activeAt: AT });
          expect(draftProblems([out])).toEqual([]);
          for (const { lon, lat } of out.exclude_locations) {
            expect(Math.abs(lon) <= 180 && Math.abs(lat) <= 90, `${lon},${lat}`).toBe(true);
          }
        }),
        fuzzParameters(150),
      );
    },
    fuzzTimeout(5_000),
  );
});

describe("stream and archive emitters over random situations", () => {
  it(
    "frame each record as one Server-Sent Event and diff the set by id",
    () => {
      fc.assert(
        fc.property(batch, (situations) => {
          const { changed, removed, next } = diffRecords(new Map(), situations);
          expect(changed).toHaveLength(situations.length);
          expect(removed).toEqual([]);
          expect(diffRecords(next, situations).changed).toEqual([]);
          for (const record of situations) {
            const frame = sseFrame({ event: "situation", id: String(record["id"]), data: record });
            // One frame, its fields on lines of their own: no line break inside a value.
            expect(frame.endsWith("\n\n")).toBe(true);
            expect(
              frame
                .slice(0, -2)
                .split("\n")
                .every((l) => /^(id|event|data): /.test(l)),
            ).toBe(true);
          }
        }),
        fuzzParameters(100),
      );
    },
    fuzzTimeout(5_000),
  );

  it(
    "write a GeoParquet archive that reads back to the published records",
    async () => {
      await fc.assert(
        fc.asyncProperty(batch, async (situations) => {
          const records = situations as unknown as ArchivableRecord[];
          const buffer = recordArchiveBuffer("situation", records, NOW);
          const file = buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
          ) as ArrayBuffer;
          const rows = await parquetReadObjects({ file, utf8: true });
          expect(rows.map((row) => row["id"])).toEqual(
            publishedRecords("situation", records, NOW).map((r) => r.id),
          );
          for (const row of rows) {
            expect(JSON.parse(row["record"] as string)["id"]).toBe(row["id"]);
          }
        }),
        fuzzParameters(30),
      );
    },
    fuzzTimeout(10_000),
  );
});
