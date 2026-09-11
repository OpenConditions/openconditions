import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { loadHighwayClasses } from "./highway-classes.js";
import { loadOsmRegions, osmRegionImportFingerprint } from "./osm-import.js";

type Sql = postgres.Sql;

/** Makes old bindings ineligible before any mutable graph table changes. */
export async function beginRoadGraphRebuild(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE conditions.road_graph_state SET status='rebuilding' WHERE singleton`;
    await tx`UPDATE conditions.observation_binding SET status='obsolete'`;
    await tx`
      INSERT INTO conditions.binding_queue
        (observation_id, observation_revision, attempts, next_attempt_at, updated_at)
      SELECT o.id, COALESCE(o.content_hash, md5(o.id || ':' || o.data_updated_at::text)), 0, now(), now()
      FROM conditions.observations o
      WHERE o.kind='event' AND o.domain='roads' AND o.status='active'
      ON CONFLICT (observation_id) DO UPDATE SET
        observation_revision=excluded.observation_revision, attempts=0,
        next_attempt_at=excluded.next_attempt_at, last_error=NULL, updated_at=excluded.updated_at`;
  });
}

/** Records the identity and exact configured provenance of a completed spine build. */
export async function activateRoadGraph(
  sql: Sql,
  deps: { now: () => string; env?: NodeJS.ProcessEnv; generation?: string }
): Promise<string> {
  const regions = loadOsmRegions(deps.env ?? process.env);
  if (regions.length === 0)
    throw new Error("road graph preflight: SEGMENT_REGIONS is not configured");
  const expectedImports = regions.map((region) => ({
    id: region.id,
    config_hash: osmRegionImportFingerprint(region, deps.env ?? process.env),
  }));
  const missing = await sql<{ id: string }[]>`
    SELECT configured.id
    FROM jsonb_to_recordset(${sql.json(expectedImports)}::jsonb) AS configured(id text, config_hash text)
    WHERE NOT EXISTS (
      SELECT 1 FROM conditions.osm_road road
      WHERE road.region = configured.id AND road.import_config_hash = configured.config_hash
    )`;
  if (missing.length > 0) {
    throw new Error(
      `road graph preflight: missing current configured imports: ${missing.map((r) => r.id).join(", ")}`
    );
  }
  const [{ imported_at }] = await sql<{ imported_at: Date | string | null }[]>`
    SELECT max(imported_at) AS imported_at FROM conditions.osm_road`;
  if (imported_at == null) throw new Error("road graph preflight: no successful OSM import");

  const highwayClasses = [
    ...new Set(
      regions.flatMap(
        (region) => region.highwayClasses ?? loadHighwayClasses(deps.env ?? process.env)
      )
    ),
  ];
  const pbfProvenance = regions.flatMap((region) =>
    (region.pbfUrls ?? []).map((url) => ({ region_id: region.id, url }))
  );
  const generation = deps.generation ?? randomUUID();
  const activatedAt = deps.now();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO conditions.road_graph_state
        (singleton, generation, status, regions, highway_classes, pbf_provenance, imported_at, activated_at)
      VALUES (true, ${generation}, 'ready', ${tx.json(regions as unknown as postgres.JSONValue)}, ${tx.json(highwayClasses)},
              ${tx.json(pbfProvenance)}, ${imported_at}, ${activatedAt})
      ON CONFLICT (singleton) DO UPDATE SET
        generation = excluded.generation, status = 'ready',
        regions = excluded.regions,
        highway_classes = excluded.highway_classes,
        pbf_provenance = excluded.pbf_provenance,
        imported_at = excluded.imported_at,
        activated_at = excluded.activated_at`;
    await tx`
      UPDATE conditions.observation_binding
      SET status = 'obsolete'
      WHERE graph_generation IS DISTINCT FROM ${generation}`;
    await tx`
      INSERT INTO conditions.binding_queue (observation_id, observation_revision, attempts, next_attempt_at, updated_at)
      SELECT o.id, COALESCE(o.content_hash, md5(o.id || ':' || o.data_updated_at::text)), 0, now(), now()
      FROM conditions.observations o
      WHERE o.kind = 'event' AND o.domain = 'roads' AND o.status = 'active'
      ON CONFLICT (observation_id) DO UPDATE SET
        observation_revision = excluded.observation_revision,
        attempts = 0,
        next_attempt_at = excluded.next_attempt_at,
        last_error = NULL,
        updated_at = excluded.updated_at`;
  });
  return generation;
}
