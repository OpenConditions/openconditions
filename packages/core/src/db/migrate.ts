/**
 * Idempotent DDL for the generic conditions.observations store.
 * Defined as a TypeScript string constant so it survives bundling (tsup).
 * Apply this once on service boot before any reads or writes.
 */
export const MIGRATION_SQL = `
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS conditions;
-- ONE table for every domain (roads/transit/places/crowd). Common columns are typed + indexed;
-- domain-specifics (roads/lanes/roadState, occupancy, …) live in attributes JSONB.
CREATE TABLE IF NOT EXISTS conditions.observations (
  id              TEXT PRIMARY KEY,            -- "<source>:<localId>"
  source          TEXT NOT NULL,
  source_format   TEXT NOT NULL,
  domain          TEXT NOT NULL,               -- 'roads' | 'transit' | 'places' | ...
  kind            TEXT NOT NULL,               -- 'event' | 'measurement'
  -- event axis (ConditionEvent) — nullable for measurements
  type            TEXT,
  subtype         TEXT,
  category        TEXT,
  severity        TEXT,
  severity_source TEXT,
  headline        TEXT,
  description     TEXT,
  -- measurement axis (Measurement) — nullable for events
  metric          TEXT,
  value           DOUBLE PRECISION,
  level           TEXT,
  unit            TEXT,
  aggregation     TEXT,                         -- 'live' | 'typical' | 'forecast'
  -- common
  status          TEXT NOT NULL DEFAULT 'active',
  geom            geometry(Geometry, 4326) NOT NULL,
  subject         JSONB,                        -- SubjectRef[] (geo/osm/gtfs/place/segment)
  attributes      JSONB,                        -- domain-specific payload (roads: roads/lanes/roadState/speedLimitKph/restrictions/direction/externalRefs/detour/isPlanned)
  valid_from      TIMESTAMPTZ,
  valid_to        TIMESTAMPTZ,
  schedule        JSONB,
  confidence      TEXT,
  is_forecast     BOOLEAN NOT NULL DEFAULT FALSE,
  related_ids     JSONB,
  origin          JSONB NOT NULL,               -- Provenance: {kind:'feed',attribution} | {kind:'crowd',attribution,reporter}
  data_updated_at TIMESTAMPTZ NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ,
  is_stale        BOOLEAN NOT NULL DEFAULT FALSE,
  -- fetched_at + the source's freshness window: when last-good data goes
  -- stale. Derived at read time as now() greater than stale_after, NULL = never.
  stale_after     TIMESTAMPTZ
);
ALTER TABLE conditions.observations ADD COLUMN IF NOT EXISTS stale_after TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_conditions_obs_geom     ON conditions.observations USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_conditions_obs_domain   ON conditions.observations (domain);
CREATE INDEX IF NOT EXISTS idx_conditions_obs_dom_type ON conditions.observations (domain, type);
CREATE INDEX IF NOT EXISTS idx_conditions_obs_severity ON conditions.observations (severity);
CREATE INDEX IF NOT EXISTS idx_conditions_obs_metric   ON conditions.observations (metric);
CREATE INDEX IF NOT EXISTS idx_conditions_obs_valid_to ON conditions.observations (valid_to);
CREATE INDEX IF NOT EXISTS idx_conditions_obs_expires  ON conditions.observations (expires_at);
CREATE INDEX IF NOT EXISTS idx_conditions_obs_subject  ON conditions.observations USING GIN (subject);
CREATE INDEX IF NOT EXISTS idx_conditions_obs_source   ON conditions.observations (source);
`;
