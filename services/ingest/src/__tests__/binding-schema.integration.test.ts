import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("binding tables", () => {
  it("creates the record binding tables and the graph state with the expected columns", async () => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name IN
        ('record_binding','record_segment','binding_queue','road_graph_state','osm_road')`;
    const names = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    for (const n of [
      "record_binding.record_class",
      "record_binding.record_id",
      "record_binding.effect_id",
      "record_binding.status",
      "record_binding.confidence",
      "record_binding.direction_mode",
      "record_binding.candidate_count",
      "record_binding.alternative_confidence",
      "record_binding.reason",
      "record_binding.resolver_version",
      "record_binding.geom_hash",
      "record_binding.record_revision",
      "record_binding.graph_generation",
      "record_binding.bound_at",
      "record_segment.record_class",
      "record_segment.record_id",
      "record_segment.effect_id",
      "record_segment.seq",
      "record_segment.segment_id",
      "record_segment.way_id",
      "record_segment.dir",
      "record_segment.start_fraction",
      "record_segment.end_fraction",
      "binding_queue.record_class",
      "binding_queue.record_id",
      "binding_queue.effect_id",
      "binding_queue.record_revision",
      "binding_queue.attempts",
      "binding_queue.next_attempt_at",
      "road_graph_state.singleton",
      "road_graph_state.generation",
      "road_graph_state.status",
      "road_graph_state.regions",
      "road_graph_state.highway_classes",
      "road_graph_state.pbf_provenance",
      "road_graph_state.imported_at",
      "road_graph_state.activated_at",
      "osm_road.import_config_hash",
      "osm_road.import_provenance",
    ])
      expect(names, n).toContain(n);
  }, 30_000);

  it("keeps no table of observation bindings", async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'conditions'
        AND table_name IN ('observation_binding', 'observation_segment')`;
    expect(tables).toEqual([]);
  }, 30_000);

  it("has NO foreign key from the binding tables to a record or to road_segment", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.table_constraints
      WHERE table_schema = 'conditions' AND constraint_type = 'FOREIGN KEY'
        AND table_name IN ('record_binding', 'record_segment', 'binding_queue')`;
    expect(n).toBe(0);
  }, 30_000);

  it("refuses a binding of something that is not a record class", async () => {
    await expect(
      sql`INSERT INTO conditions.record_binding
            (record_class, record_id, status, direction_mode, resolver_version, geom_hash,
             record_revision, bound_at)
          VALUES ('event', 'x', 'exact', 'single', 'v', 'h', 1, now())`,
    ).rejects.toThrow(/record_binding_record_class_enum/);
  }, 30_000);
});
