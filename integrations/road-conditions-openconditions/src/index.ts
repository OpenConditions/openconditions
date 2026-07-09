import type { FeatureCollection } from "geojson";
import { observationsByBbox } from "@openconditions/core";
import { featureCollectionToRoadConditionEvents } from "./toRoadConditionEvents.js";
import { featureCollectionToRoadFlowSegments } from "./toRoadFlowSegments.js";
import type { IntegrationContext, RoadConditionsProvider } from "./types.js";

// Attribution is wired in the monorepo via the manifest dataSources.

const PROVIDER_ID = "road-conditions-openconditions";

// This integration's `requires:` service — resolved via platform
// service-discovery below; this fallback only applies when the host has not
// wired the requirement (e.g. tests / dev scripts).
const INGEST_SERVICE_ID = "openconditions-ingest";
const INGEST_FALLBACK_URL = "http://openconditions-ingest:4100";

/**
 * Registers a `road-conditions` provider backed by the shared PostGIS
 * `conditions.observations` table that the OpenConditions ingest service writes.
 * The OpenMapX `road-conditions` orchestrator merges this with any other
 * providers (TomTom/HERE/…) and serves the result to the overlay + navigation.
 */
export function setup(ctx: IntegrationContext): void {
  const ingestUrl = ctx.getRequiredService(INGEST_SERVICE_ID)?.url ?? INGEST_FALLBACK_URL;

  const provider: RoadConditionsProvider = {
    id: PROVIDER_ID,
    async getEvents(bbox, opts) {
      const db = ctx.db;
      if (!db) return [];
      const fc = await observationsByBbox(db, {
        domain: "roads",
        bbox,
        // Incidents only: the shared store also holds high-frequency traffic-flow
        // `measurement` rows (tens of thousands NL-wide). Derived congestion is
        // emitted as kind 'event', so it is still included.
        kind: "event",
        types: opts?.types,
        minSeverity: opts?.minSeverity,
      });
      return featureCollectionToRoadConditionEvents(fc);
    },
    async getFlow(bbox) {
      const fc = await ctx.http.get<FeatureCollection>(`${ingestUrl}/segments.geojson`, {
        params: { bbox: bbox.join(",") },
      });
      return featureCollectionToRoadFlowSegments(fc, PROVIDER_ID);
    },
  };

  ctx.registerRoadConditionsProvider(provider);
}
