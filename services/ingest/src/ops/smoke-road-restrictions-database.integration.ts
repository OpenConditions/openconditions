import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { runMigrations } from "@openconditions/core/server";
import {
  FEED_SOURCES,
  hasRestrictionEvidence,
  isPublishedRoadRestrictionDetails,
  type OsmWay,
  type SpineSegment,
} from "@openconditions/roads";
import {
  eventsToExclusions,
  observationsToDatexSituations,
  observationsToGeoJSON,
  observationsToTraff,
} from "@openconditions/publishers";
import { readObservations } from "@openconditions/core";
import { activateRoadGraph } from "../pipeline/graph-state.js";
import { importOsmRoads } from "../pipeline/osm-import.js";
import { buildSegments } from "../pipeline/segment-build.js";
import { runSource, type DomainFeedSource } from "../pipeline/run.js";
import type { RunRestrictionSmokeOptions } from "./smoke-road-restrictions.js";

/**
 * Disposable-database smoke mode: one live guarded acquisition through the real
 * `runSource`, into a throwaway PostGIS created for this run only, against a
 * reviewed frozen road spine.
 *
 * It never touches an ambient `DATABASE_URL`, never starts a scheduler and
 * always tears the container down. The spine must be a reviewed capture: this
 * mode builds a graph, it does not acquire one.
 */

export interface RestrictionSmokeDatabaseReport {
  sourceId: string;
  mode: "disposable-database";
  checkedAt: string;
  published: number;
  bound: number;
  bindingStatuses: Record<string, number>;
  restrictionRecords: number;
  restrictionFacts: number;
  withheldConditional: number;
  notes: string[];
}

/** The bbox the region covers, derived from the spine's own coordinates. */
function bboxOf(segments: SpineSegment[]): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const segment of segments) {
    for (const [lon, lat] of segment.coords) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error("smoke: spine has no usable coordinates");
  }
  // A hair of slack so an event just outside the captured extent still lands
  // inside the configured region.
  return [west - 0.01, south - 0.01, east + 0.01, north + 0.01];
}

/**
 * Convert a reviewed directed spine into the `OsmWay` rows the importer takes.
 * `oneway` is false only where the capture also holds the paired backward
 * segment, so this never invents a bidirectional road.
 */
function spineToWays(segments: SpineSegment[]): OsmWay[] {
  const backward = new Set(
    segments.filter((segment) => segment.dir === "b").map((segment) => String(segment.wayId))
  );
  return segments
    .filter((segment) => segment.dir === "f")
    .map((segment) => ({
      wayId: segment.wayId,
      coords: segment.coords as [number, number][],
      highway: segment.highway,
      oneway: !backward.has(String(segment.wayId)),
      ...(segment.ref ? { ref: segment.ref } : {}),
    }));
}

export async function runRestrictionSmokeWithDatabase(
  options: RunRestrictionSmokeOptions
): Promise<RestrictionSmokeDatabaseReport> {
  if (options.sourceId !== "fi-digitraffic") {
    throw new Error(`smoke: disposable mode does not support ${options.sourceId} yet`);
  }
  if (!options.spineFile) throw new Error("smoke: --spine is required in disposable mode");
  const descriptor = FEED_SOURCES.find((candidate) => candidate.id === options.sourceId);
  if (!descriptor) throw new Error(`smoke: no feed descriptor for ${options.sourceId}`);
  const feed: DomainFeedSource = { ...descriptor, domain: "roads" };

  const spine = JSON.parse(await readFile(options.spineFile, "utf8")) as {
    segments?: SpineSegment[];
  };
  if (!Array.isArray(spine.segments) || spine.segments.length === 0) {
    throw new Error("smoke: spine file has no segments");
  }
  const bbox = bboxOf(spine.segments);
  const region = { id: "smoke-restriction-region", bbox, tz: "Europe/Helsinki" };
  const env = { SEGMENT_REGIONS: JSON.stringify([region]), BIND_ENABLED: "true" };
  const checkedAt = new Date().toISOString();

  await mkdir(options.outputDir, { recursive: true });

  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_smoke",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  // Its own newly created container only: an ambient DATABASE_URL is ignored.
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_smoke`;
  const sql = postgres(url, { max: 3 });

  try {
    await runMigrations(url);
    await importOsmRoads(sql, {
      source: { fetchRegion: async () => spineToWays(spine.segments!) },
      now: () => checkedAt,
      regions: [region],
    });
    await buildSegments(sql, () => checkedAt, { region: region.id });
    await activateRoadGraph(sql, {
      now: () => checkedAt,
      env,
      generation: `smoke-${checkedAt}`,
    });

    // `runSource` binds internally from `process.env`, so the region this run
    // just built has to be visible there too. Without it that pass would write
    // `no_coverage` for every record and the explicit pass below would then
    // skip them all as unchanged. Restored in the `finally` of this block.
    const previousEnv = {
      SEGMENT_REGIONS: process.env["SEGMENT_REGIONS"],
      BIND_ENABLED: process.env["BIND_ENABLED"],
    };
    let ids: { id: string }[];
    try {
      process.env["SEGMENT_REGIONS"] = env.SEGMENT_REGIONS;
      process.env["BIND_ENABLED"] = env.BIND_ENABLED;
      // One requested smoke is one complete live acquisition. `runSource` binds
      // the changed rows itself, so no second binding pass is issued — a
      // redundant pass would report every record as unchanged and hide the
      // result of the real one.
      const run = await runSource(feed, {
        sql,
        fetch: (await import("undici")).fetch as unknown as typeof fetch,
        now: () => checkedAt,
      });
      if (run.error) throw new Error(`smoke run: ${run.error}`);

      ids = await sql<{ id: string }[]>`
        SELECT id FROM conditions.observations WHERE source = ${feed.id}`;
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // What the database actually holds, rather than what a second pass would
    // report about rows it has nothing left to do for.
    const bindingRows = await sql<{ status: string; count: string }[]>`
      SELECT b.status, COUNT(*)::text AS count
      FROM conditions.observation_binding b
      JOIN conditions.observations o ON o.id = b.observation_id
      WHERE o.source = ${feed.id}
      GROUP BY b.status`;
    const bindingStatuses = Object.fromEntries(
      bindingRows.map((row) => [row.status, Number(row.count)])
    );
    const routableBindings = (bindingStatuses["exact"] ?? 0) + (bindingStatuses["likely"] ?? 0);

    const rows = await readObservations(
      {
        async execute<T>(query: string, params?: unknown[]): Promise<T> {
          return (await sql.unsafe(query, params as never)) as T;
        },
      },
      { domain: "roads", bbox: [19, 59, 32, 71], dedupe: false, includeBindings: true }
    );
    const display = observationsToGeoJSON(rows, {}, { at: new Date(checkedAt) });
    const events = rows.filter((row) => row.kind === "event");
    const conditional = events.filter((row) => hasRestrictionEvidence(row));

    // The same publication-safety assertions the fixtures make, now against
    // rows that actually round-tripped through the database.
    const datex = observationsToDatexSituations(events as never, {}, feed.country ?? "other");
    const traff = observationsToTraff(events as never);
    for (const record of conditional) {
      if (datex.includes(record.id) || traff.includes(record.id)) {
        throw new Error(`smoke publication safety: conditional record exported: ${record.id}`);
      }
    }
    const exclusions = eventsToExclusions(conditional, {
      activeAt: new Date(checkedAt),
      evaluatedAt: new Date(checkedAt),
    });
    if (exclusions.exclude_locations.length > 0 || exclusions.exclude_polygons.length > 0) {
      throw new Error("smoke publication safety: a conditional record produced exclusions");
    }

    const views = display.features
      .map((feature) => feature.properties?.["restrictionDetails"])
      .filter(isPublishedRoadRestrictionDetails);
    const report: RestrictionSmokeDatabaseReport = {
      sourceId: feed.id,
      mode: "disposable-database",
      checkedAt,
      published: ids.length,
      bound: routableBindings,
      bindingStatuses,
      restrictionRecords: views.length,
      restrictionFacts: views.reduce((sum, view) => sum + view.facts.length, 0),
      withheldConditional: conditional.length,
      notes: [
        "most national records fall outside the small frozen graph and are expected to be unbound",
        "a restriction kind absent from this snapshot is not observed, not a failure",
        "this disposable database is destroyed when the run ends",
      ],
    };
    await writeFile(
      join(options.outputDir, "database-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    return report;
  } finally {
    try {
      await sql.end();
    } finally {
      await container.stop();
    }
  }
}
