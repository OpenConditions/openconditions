import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runMigrations } from "@openconditions/core/server";
import { createTestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { expect, it } from "vitest";
import { activateRoadGraph } from "../pipeline/graph-state.js";
import { importOsmRoads, osmRegionImportProvenance } from "../pipeline/osm-import.js";
import { buildSegments } from "../pipeline/segment-build.js";

it("invalidates a populated legacy graph and requires reacquisition before activation", async () => {
  const db = await createTestDatabase({ empty: true });
  const sql = db.sql;
  const folder = new URL("../../../../packages/core/drizzle/", import.meta.url);
  const region = {
    id: "nl",
    bbox: [4.9, 51.9, 5.2, 52.1] as [number, number, number, number],
    tz: "Europe/Amsterdam",
  };
  const now = () => "2026-11-23T12:00:00Z";
  const env = { SEGMENT_REGIONS: JSON.stringify([region]) };
  try {
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", folder), "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
    await sql`CREATE SCHEMA conditions`;
    await sql`CREATE SCHEMA drizzle`;
    await sql`CREATE TABLE drizzle.__drizzle_migrations_oc (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
    await sql.begin(async (tx) => {
      for (const entry of journal.entries.filter((entry) => entry.idx <= 104)) {
        const migration = await readFile(new URL(`${entry.tag}.sql`, folder), "utf8");
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.unsafe(statement);
        }
        await tx`INSERT INTO drizzle.__drizzle_migrations_oc (hash,created_at)
          VALUES (${createHash("sha256").update(migration).digest("hex")}, ${entry.when})`;
      }
    });
    const legacy = { ...osmRegionImportProvenance(region) };
    delete legacy["way_direction_version"];
    const hash = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
    await sql`INSERT INTO conditions.osm_road (way_id,geom,highway,oneway,region,imported_at,import_config_hash,import_provenance)
      VALUES (9,ST_SetSRID(ST_MakeLine(ST_MakePoint(5,52),ST_MakePoint(5.1,52)),4326),'primary',true,'nl',${now()},${hash},${sql.json(legacy as postgres.JSONValue)})`;
    await sql`INSERT INTO conditions.road_graph_state
      (singleton,generation,status,regions,highway_classes,pbf_provenance,imported_at,activated_at)
      VALUES (true,'legacy','ready',${sql.json([region])},'[]','[]',${now()},${now()})`;
    await sql`INSERT INTO conditions.record_binding
      (record_class,record_id,effect_id,status,confidence,direction_mode,resolver_version,
       geom_hash,record_revision,graph_generation,bound_at)
      VALUES ('situation','legacy:binding','','exact',1,'single','legacy','legacy',1,'legacy',${now()})`;
    const before =
      await sql`SELECT way_id,ST_AsEWKB(geom) AS geom,oneway,import_config_hash,import_provenance FROM conditions.osm_road`;
    await runMigrations(db.url);
    expect(await sql`SELECT generation,status FROM conditions.road_graph_state`).toEqual([
      { generation: "legacy", status: "rebuilding" },
    ]);
    expect(await sql`SELECT status,graph_generation FROM conditions.record_binding`).toEqual([
      { status: "obsolete", graph_generation: "legacy" },
    ]);
    expect(
      await sql`SELECT way_id,ST_AsEWKB(geom) AS geom,oneway,import_config_hash,import_provenance FROM conditions.osm_road`,
    ).toEqual(before);
    expect(await sql`SELECT oneway_reversed FROM conditions.osm_road`).toEqual([
      { oneway_reversed: false },
    ]);
    await buildSegments(sql, now);
    await expect(activateRoadGraph(sql, { now, env })).rejects.toThrow(
      /missing current configured imports/,
    );
    await importOsmRoads(sql, {
      now,
      regions: [region],
      source: {
        fetchRegion: async () => [
          {
            wayId: 9,
            coords: [
              [5, 52],
              [5.1, 52],
            ],
            highway: "primary",
            oneway: true,
            onewayReversed: true,
          },
        ],
      },
    });
    await buildSegments(sql, now);
    await activateRoadGraph(sql, { now, env, generation: "corrected" });
    expect(await sql`SELECT segment_id FROM conditions.road_segment`).toEqual([
      { segment_id: "9:b" },
    ]);
    // Subsequent boots must not invalidate an already repaired generation.
    await runMigrations(db.url);
    expect(await sql`SELECT generation,status FROM conditions.road_graph_state`).toEqual([
      { generation: "corrected", status: "ready" },
    ]);
  } finally {
    await db.close();
  }
}, 120_000);
