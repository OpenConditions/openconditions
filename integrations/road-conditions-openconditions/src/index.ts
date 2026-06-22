import { observationsByBbox } from "@openconditions/core";
import { featureCollectionToRoadConditionEvents } from "./toRoadConditionEvents.js";
import type { IntegrationContext, RoadConditionsProvider } from "./types.js";

// Attribution is wired in the monorepo via the manifest dataSources.

const PROVIDER_ID = "road-conditions-openconditions";

/**
 * Registers a `road-conditions` provider backed by the shared PostGIS
 * `conditions.observations` table that the OpenConditions ingest service writes.
 * The OpenMapX `road-conditions` orchestrator merges this with any other
 * providers (TomTom/HERE/…) and serves the result to the overlay + navigation.
 */
export function setup(ctx: IntegrationContext): void {
  const provider: RoadConditionsProvider = {
    id: PROVIDER_ID,
    async getEvents(bbox, opts) {
      const db = ctx.db;
      if (!db) return [];
      const fc = await observationsByBbox(db, {
        domain: "roads",
        bbox,
        types: opts?.types,
        minSeverity: opts?.minSeverity,
      });
      return featureCollectionToRoadConditionEvents(fc);
    },
  };

  ctx.registerRoadConditionsProvider(provider);
}
