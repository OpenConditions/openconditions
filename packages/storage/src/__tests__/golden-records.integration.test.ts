import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { seriesKeyOf } from "@openconditions/core";
import { readLatestObservation, readRecord } from "@openconditions/core/server";
import { buildRegistry, extendVocabulary } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureObservationPartitions, retentionClasses } from "../observation-partitions.js";
import { rowOf } from "../record-rows.js";
import { type SnapshotDrafts, type WriteContext, writeSnapshot } from "../write-records.js";
import { createTestDatabase } from "./database.integration.js";

type Rec = Record<string, unknown>;

/**
 * Every sealed record of the roads golden files (each event and flow format's
 * parser output) and of the facilities fit check (charging, parking and fuel
 * sites, their readings and offers, real published records) goes through the
 * writer and is read back as it was sealed.
 */
const PACKAGES = path.resolve(import.meta.dirname, "../../..");
const ROADS_GOLDEN = path.join(PACKAGES, "roads/src/__tests__/golden");
const FACILITIES_GOLDEN = path.join(
  PACKAGES,
  "model-registry/src/__tests__/golden/facilities.json",
);

// The facilities fit check registers the formats OpenConditions does not parse yet.
const registry = buildRegistry([
  ...productionModules,
  {
    name: "facilities-fit",
    entries: [
      extendVocabulary({
        vocabulary: "source_format",
        values: [
          "ocpi",
          "parkapi",
          "datex2-parking",
          "autobahn-parking",
          "minetur",
          "mimit",
          "econtrol",
        ],
      }),
    ],
  },
]);
const NOW = "2026-09-22T12:00:00.000Z";
const ctx: WriteContext = { registry, instanceId: "test.local", now: NOW, complete: true };

function goldenRecords(): Rec[] {
  const roads = readdirSync(ROADS_GOLDEN)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const doc = JSON.parse(readFileSync(path.join(ROADS_GOLDEN, f), "utf8"));
      if (Array.isArray(doc)) return doc as Rec[];
      // A flow golden file groups its records by class; a summary file holds none.
      return ["situations", "features", "observations"].flatMap((k) =>
        Array.isArray(doc[k]) ? (doc[k] as Rec[]) : [],
      );
    });
  const facilities = JSON.parse(readFileSync(FACILITIES_GOLDEN, "utf8")) as Rec[];
  return [...roads, ...facilities];
}

/** The draft a record was sealed from: sealing adds only these fields. */
function draftOf(sealed: Rec): Rec {
  const {
    canonicalId: _canonical,
    domain: _domain,
    revision: _revision,
    recordedAt: _recorded,
    contentHash: _hash,
    ...draft
  } = sealed;
  const { instanceId: _instance, ...provenance } = draft["provenance"] as Rec;
  return { ...draft, provenance };
}

/** The record as this instance stores it: its own instance id and write time. */
const asStored = (sealed: Rec): Rec => ({
  ...sealed,
  recordedAt: NOW,
  provenance: { ...(sealed["provenance"] as Rec), instanceId: "test.local" },
});

const KEY = { situation: "situations", feature: "features", offer: "offers" } as const;
const records = goldenRecords();
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
  const bySource = new Map<string, Required<SnapshotDrafts>>();
  for (const record of records) {
    const sourceId = (record["provenance"] as Rec)["sourceId"] as string;
    let drafts = bySource.get(sourceId);
    if (drafts === undefined) {
      drafts = { situations: [], features: [], offers: [], observations: [] };
      bySource.set(sourceId, drafts);
    }
    const cls = record["class"] as keyof typeof KEY | "observation";
    (drafts[cls === "observation" ? "observations" : KEY[cls]] as Rec[]).push(draftOf(record));
  }
  for (const [sourceId, drafts] of bySource) {
    const summary = await writeSnapshot(sql, sourceId, drafts, ctx);
    expect(summary.rejected, sourceId).toEqual([]);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("golden records through the tables", () => {
  it("are many, of every class", () => {
    const classes = new Set(records.map((r) => r["class"]));
    expect([...classes].sort()).toEqual(["feature", "observation", "offer", "situation"]);
    expect(records.length).toBeGreaterThan(200);
  });

  it("read back as they were sealed", async () => {
    for (const record of records.filter((r) => r["class"] !== "observation")) {
      const cls = record["class"] as keyof typeof KEY;
      const stored = await readRecord(sql, cls, record["id"] as string);
      expect(stored, record["id"] as string).toEqual(asStored(record));
    }
  });

  it("hold in their promoted columns exactly what each record says", async () => {
    for (const cls of ["situation", "feature", "offer"] as const) {
      const rows = await sql.unsafe(`SELECT * FROM conditions.${cls}`);
      expect(rows.length).toBe(records.filter((r) => r["class"] === cls).length);
      for (const row of rows) {
        const expected = rowOf(cls, row["record"] as Rec);
        for (const [column, value] of Object.entries(expected)) {
          if (column === "geom") continue;
          const stored = row[column];
          const actual =
            stored instanceof Date
              ? stored.toISOString()
              : column.endsWith("_price") && stored !== null
                ? Number(stored)
                : stored;
          const want =
            typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)
              ? new Date(value).toISOString()
              : column.endsWith("_price") && value !== null
                ? Number(value)
                : value;
          expect(actual, `${cls} ${row["id"]} ${column}`).toEqual(want);
        }
      }
    }
  });

  it("keep every geometry, as the record has it", async () => {
    const rows = await sql<{ id: string; record: Rec; geom: Rec | null }[]>`
      SELECT id, record, ST_AsGeoJSON(geom)::jsonb AS geom FROM conditions.situation
      UNION ALL SELECT id, record, ST_AsGeoJSON(geom)::jsonb FROM conditions.feature`;
    for (const row of rows) {
      const geometry = (row.record["location"] as Rec | undefined)?.["geometry"] ?? null;
      expect(row.geom === null, row.id).toBe(geometry === null);
      if (geometry !== null) expect(row.geom!["type"], row.id).toBe((geometry as Rec)["type"]);
    }
  });

  it("start a series per reading, its latest row the reading as sealed", async () => {
    const readings = records.filter((r) => r["class"] === "observation");
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM conditions.observation_latest`;
    expect(count).toBe(readings.length);
    for (const reading of readings) {
      const latest = await readLatestObservation(sql, seriesKeyOf(reading));
      const { sinceAt: _since, ...stored } = latest ?? {};
      expect(stored, reading["id"] as string).toEqual(asStored(reading));
    }
  });
});
