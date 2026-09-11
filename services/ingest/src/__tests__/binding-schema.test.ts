import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { observationsByBbox, readObservations } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";

let sql: postgres.Sql;
let stop: () => Promise<unknown>;

beforeAll(async () => {
  const c = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  stop = () => c.stop();
  const url = `postgres://oc:oc@${c.getHost()}:${c.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 2 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
}, 30_000);

describe("binding tables", () => {
  it("creates observation_binding and observation_segment with the expected columns", async () => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name IN
        ('observation_binding','observation_segment','binding_queue','road_graph_state','osm_road')`;
    const names = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    for (const n of [
      "observation_binding.observation_id",
      "observation_binding.status",
      "observation_binding.confidence",
      "observation_binding.direction_mode",
      "observation_binding.candidate_count",
      "observation_binding.alternative_confidence",
      "observation_binding.reason",
      "observation_binding.resolver_version",
      "observation_binding.geom_hash",
      "observation_binding.bound_at",
      "observation_binding.observation_revision",
      "observation_binding.graph_generation",
      "observation_segment.observation_id",
      "observation_segment.seq",
      "observation_segment.segment_id",
      "observation_segment.way_id",
      "observation_segment.dir",
      "observation_segment.start_fraction",
      "observation_segment.end_fraction",
      "binding_queue.observation_id",
      "binding_queue.observation_revision",
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

  it("cascades from observations to both binding tables", async () => {
    await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, status, geom, origin, data_updated_at, fetched_at)
      VALUES ('t:1','t','native','roads','event','active', ST_SetSRID(ST_MakePoint(6.8,51.2),4326),
              '{"kind":"feed","attribution":{"provider":"t","license":"CC0"}}', now(), now())`;
    await sql`INSERT INTO conditions.observation_binding (observation_id, status, confidence, direction_mode, candidate_count, resolver_version, geom_hash, bound_at)
      VALUES ('t:1','exact',0.95,'single',3,'1.0.0','h',now())`;
    await sql`INSERT INTO conditions.observation_segment (observation_id, seq, segment_id, way_id, dir, start_fraction, end_fraction)
      VALUES ('t:1',0,'100:f',100,'f',0.2,1.0)`;
    await sql`DELETE FROM conditions.observations WHERE id = 't:1'`;
    const [b] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM conditions.observation_binding`;
    const [s] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM conditions.observation_segment`;
    expect(b!.n).toBe(0);
    expect(s!.n).toBe(0);
  }, 30_000);

  it("has NO foreign key from observation_segment to road_segment", async () => {
    const fks = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.table_constraints
      WHERE table_schema='conditions' AND table_name='observation_segment' AND constraint_type='FOREIGN KEY'`;
    expect(fks[0]!.n).toBe(1);
  }, 30_000);
});

describe("binding on the read path", () => {
  // Adapt postgres-js to the QueryRunner interface the readers expect.
  const db = {
    async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
      return (p ? await sql.unsafe(q, p as never[]) : await sql.unsafe(q)) as T;
    },
  };
  const bbox: [number, number, number, number] = [6, 51, 7, 52];

  beforeAll(async () => {
    await sql`INSERT INTO conditions.observations (id, source, source_format, domain, kind, type, severity, headline, status, geom, origin, data_updated_at, fetched_at, content_hash)
      VALUES ('b:1','t','native','roads','event','road_closure','high','Closed','active', ST_SetSRID(ST_MakePoint(6.8,51.2),4326),
              '{"kind":"feed","attribution":{"provider":"t","license":"CC0-1.0"}}', now(), now(), 'rev-b1'),
             ('b:2','t','native','roads','event','roadworks','low','Works','active', ST_SetSRID(ST_MakePoint(6.9,51.3),4326),
              '{"kind":"feed","attribution":{"provider":"t","license":"CC0-1.0"}}', now(), now(), 'rev-b2')`;
    await sql`INSERT INTO conditions.road_graph_state
      (singleton,generation,regions,highway_classes,pbf_provenance,imported_at,activated_at)
      VALUES (true,'graph-binding-schema','[]','[]','[]',now(),now())`;
    await sql`INSERT INTO conditions.observation_binding (observation_id, status, confidence, direction_mode, candidate_count, resolver_version, geom_hash, observation_revision, graph_generation, bound_at)
      VALUES ('b:1','exact',0.95,'single',1,'1.0.0','h','rev-b1','graph-binding-schema',now())`;
    await sql`INSERT INTO conditions.observation_segment (observation_id, seq, segment_id, way_id, dir, start_fraction, end_fraction)
      VALUES ('b:1',1,'101:f',101,'f',0,0.5), ('b:1',0,'100:f',100,'f',0.2,1.0)`;
  }, 30_000);

  afterAll(async () => {
    await sql`DELETE FROM conditions.observations WHERE id IN ('b:1','b:2')`;
  }, 30_000);

  it("reads the binding header and the seq-ordered segment path", async () => {
    const obs = await readObservations(db, { domain: "roads", bbox, includeBindings: true });
    const bound = obs.find((o) => o.id === "b:1");
    expect(bound?.binding).toEqual({ status: "exact", confidence: 0.95, directionMode: "single" });
    expect(bound?.segments).toEqual([
      { segmentId: "100:f", wayId: 100, dir: "f", startFraction: 0.2, endFraction: 1 },
      { segmentId: "101:f", wayId: 101, dir: "f", startFraction: 0, endFraction: 0.5 },
    ]);
    // An unbound observation is still returned, just without the binding fields.
    const unbound = obs.find((o) => o.id === "b:2");
    expect(unbound?.binding).toBeUndefined();
    expect(unbound?.segments).toBeUndefined();
  }, 30_000);

  it("projects the binding onto the GeoJSON feature properties", async () => {
    const fc = await observationsByBbox(db, { domain: "roads", bbox, includeBindings: true });
    const feature = fc.features.find((f) => f.properties?.id === "b:1");
    expect(feature?.properties?.binding).toEqual({
      status: "exact",
      confidence: 0.95,
      directionMode: "single",
    });
    expect(feature?.properties?.segments).toHaveLength(2);
  }, 30_000);

  it("omits the binding fields entirely when includeBindings is not set", async () => {
    const obs = await readObservations(db, { domain: "roads", bbox });
    expect(obs.find((o) => o.id === "b:1")?.binding).toBeUndefined();
    const fc = await observationsByBbox(db, { domain: "roads", bbox });
    const feature = fc.features.find((f) => f.properties?.id === "b:1");
    expect(feature?.properties && "binding" in feature.properties).toBe(false);
    expect(feature?.properties && "segments" in feature.properties).toBe(false);
  }, 30_000);
});
