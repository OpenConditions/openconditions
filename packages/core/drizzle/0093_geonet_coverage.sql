CREATE TABLE conditions.geonet_coverage (
  source_id text PRIMARY KEY,
  covered_from timestamptz NOT NULL,
  covered_until timestamptz NOT NULL,
  CONSTRAINT geonet_coverage_order CHECK (covered_from < covered_until)
);
