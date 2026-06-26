import type postgres from "postgres";
import { toIsoTimestamp, type Observation } from "@openconditions/core";
import { DOMAIN_REGISTRY } from "../domains.js";

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = any;

// Rows per bulk INSERT. Each chunk is one round-trip (a single
// jsonb_to_recordset INSERT), so a large flow feed of ~20k rows is ~20 statements
// rather than ~20k. Bounded so the JSON parameter for one statement stays small.
const CHUNK_SIZE = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Maps a single Observation to the flat row object that the INSERT expects.
 * Geometry is handled inline via `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)`.
 * The domain attributes mapper is looked up via the registry.
 */
export function toRow(obs: Observation) {
  const plugin = DOMAIN_REGISTRY[obs.domain];
  const attributes = plugin ? plugin.attributes(obs) : {};

  const condEvent = obs as Observation & {
    type?: string;
    subtype?: string;
    category?: string;
    severity?: string;
    severitySource?: string;
    headline?: string;
    description?: string;
  };
  // Measurement axis (e.g. RoadFlow) — populated when kind === "measurement".
  const measurement = obs as Observation & {
    metric?: string;
    value?: number;
    level?: string;
    unit?: string;
    aggregation?: string;
  };

  return {
    id: obs.id,
    source: obs.source,
    source_format: obs.sourceFormat,
    domain: obs.domain,
    kind: obs.kind,
    type: condEvent.type ?? null,
    subtype: condEvent.subtype ?? null,
    category: condEvent.category ?? null,
    severity: condEvent.severity ?? null,
    severity_source: condEvent.severitySource ?? null,
    headline: condEvent.headline ?? null,
    description: condEvent.description ?? null,
    label: obs.label ?? null,
    metric: measurement.metric ?? null,
    value: measurement.value ?? null,
    level: measurement.level ?? null,
    unit: measurement.unit ?? null,
    aggregation: measurement.aggregation ?? null,
    status: obs.status,
    geometry_json: JSON.stringify(obs.geometry),
    subject: obs.subject ? obs.subject : null,
    attributes: attributes,
    valid_from: toIsoTimestamp(obs.validFrom) ?? null,
    valid_to: toIsoTimestamp(obs.validTo) ?? null,
    schedule: obs.schedule ? obs.schedule : null,
    confidence: obs.confidence ?? null,
    is_forecast: obs.isForecast ?? false,
    related_ids: obs.relatedIds ? obs.relatedIds : null,
    origin: obs.origin,
    // data_updated_at / fetched_at are NOT NULL: coerce, falling back so a
    // malformed source timestamp degrades to a valid value instead of aborting
    // the whole batch insert.
    data_updated_at:
      toIsoTimestamp(obs.dataUpdatedAt) ??
      toIsoTimestamp(obs.fetchedAt) ??
      new Date().toISOString(),
    fetched_at: toIsoTimestamp(obs.fetchedAt) ?? new Date().toISOString(),
    expires_at: toIsoTimestamp(obs.expiresAt) ?? null,
    is_stale: obs.isStale ?? false,
  };
}

/**
 * Bulk-inserts a batch of observations into `conditions.observations` in a single
 * statement. The whole batch is passed as one JSONB parameter and expanded
 * server-side with `jsonb_to_recordset`; geometry is converted per row via
 * `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)`. This keeps a large flow feed
 * (~20k rows/cycle) to one round-trip per chunk instead of one per row.
 */
export async function insertRows(
  tx: TransactionSql,
  batch: Observation[],
  freshnessWindowSec?: number
): Promise<void> {
  if (batch.length === 0) return;

  const rows = batch.map((obs) => {
    const r = toRow(obs);
    // The moment this last-good row becomes stale: when it was fetched plus the
    // source's freshness window. Derived at read; NULL when no window is given.
    const staleAfter =
      freshnessWindowSec != null
        ? new Date(Date.parse(r.fetched_at) + freshnessWindowSec * 1000).toISOString()
        : null;
    return { ...r, stale_after: staleAfter };
  });

  await tx`
    INSERT INTO conditions.observations (
      id, source, source_format, domain, kind,
      type, subtype, category, severity, severity_source,
      headline, description, label,
      metric, value, level, unit, aggregation,
      status, geom,
      subject, attributes,
      valid_from, valid_to, schedule,
      confidence, is_forecast, related_ids,
      origin, data_updated_at, fetched_at, expires_at, is_stale, stale_after
    )
    SELECT
      id, source, source_format, domain, kind,
      type, subtype, category, severity, severity_source,
      headline, description, label,
      metric, value, level, unit, aggregation,
      status, ST_SetSRID(ST_GeomFromGeoJSON(geometry_json), 4326),
      subject, attributes,
      valid_from, valid_to, schedule,
      confidence, is_forecast, related_ids,
      origin, data_updated_at, fetched_at, expires_at, is_stale, stale_after
    FROM jsonb_to_recordset(${tx.json(rows as AnyJson)}::jsonb) AS t(
      id text, source text, source_format text, domain text, kind text,
      type text, subtype text, category text, severity text, severity_source text,
      headline text, description text, label text,
      metric text, value double precision, level text, unit text, aggregation text,
      status text, geometry_json text,
      subject jsonb, attributes jsonb,
      valid_from timestamptz, valid_to timestamptz, schedule jsonb,
      confidence text, is_forecast boolean, related_ids jsonb,
      origin jsonb, data_updated_at timestamptz, fetched_at timestamptz,
      expires_at timestamptz, is_stale boolean, stale_after timestamptz
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Atomically replaces all observations for a given source: deletes the
 * existing rows for that source then bulk-inserts the fresh set in one
 * transaction. Either the full swap completes or nothing changes.
 */
export async function atomicSwap(
  sql: Sql,
  sourceId: string,
  fresh: Observation[],
  freshnessWindowSec?: number
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM conditions.observations WHERE source = ${sourceId}`;
    for (const batch of chunk(fresh, CHUNK_SIZE)) {
      await insertRows(tx, batch, freshnessWindowSec);
    }
  });
}
