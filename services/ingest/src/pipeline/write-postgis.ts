import type postgres from "postgres";
import type { Observation } from "@openconditions/core";
import { DOMAIN_REGISTRY } from "../domains.js";

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = any;

const CHUNK_SIZE = 500;

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
function toRow(obs: Observation) {
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
    metric: null as string | null,
    value: null as number | null,
    level: null as string | null,
    unit: null as string | null,
    aggregation: null as string | null,
    status: obs.status,
    geometry_json: JSON.stringify(obs.geometry),
    subject: obs.subject ? obs.subject : null,
    attributes: attributes,
    valid_from: obs.validFrom ?? null,
    valid_to: obs.validTo ?? null,
    schedule: obs.schedule ? obs.schedule : null,
    confidence: obs.confidence ?? null,
    is_forecast: obs.isForecast ?? false,
    related_ids: obs.relatedIds ? obs.relatedIds : null,
    origin: obs.origin,
    data_updated_at: obs.dataUpdatedAt,
    fetched_at: obs.fetchedAt,
    expires_at: obs.expiresAt ?? null,
    is_stale: obs.isStale ?? false,
  };
}

/**
 * Inserts a batch of observations into `conditions.observations` using an
 * explicit column list. Geometry is written via
 * `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)`.
 */
export async function insertRows(tx: TransactionSql, batch: Observation[]): Promise<void> {
  for (const obs of batch) {
    const r = toRow(obs);
    await tx`
      INSERT INTO conditions.observations (
        id, source, source_format, domain, kind,
        type, subtype, category, severity, severity_source,
        headline, description,
        metric, value, level, unit, aggregation,
        status, geom,
        subject, attributes,
        valid_from, valid_to, schedule,
        confidence, is_forecast, related_ids,
        origin, data_updated_at, fetched_at, expires_at, is_stale
      ) VALUES (
        ${r.id}, ${r.source}, ${r.source_format}, ${r.domain}, ${r.kind},
        ${r.type}, ${r.subtype}, ${r.category}, ${r.severity}, ${r.severity_source},
        ${r.headline}, ${r.description},
        ${r.metric}, ${r.value}, ${r.level}, ${r.unit}, ${r.aggregation},
        ${r.status}, ST_SetSRID(ST_GeomFromGeoJSON(${r.geometry_json}), 4326),
        ${r.subject ? tx.json(r.subject as AnyJson) : null}, ${r.attributes ? tx.json(r.attributes as AnyJson) : null},
        ${r.valid_from}, ${r.valid_to}, ${r.schedule ? tx.json(r.schedule as AnyJson) : null},
        ${r.confidence}, ${r.is_forecast}, ${r.related_ids ? tx.json(r.related_ids as AnyJson) : null},
        ${tx.json(r.origin as AnyJson)}, ${r.data_updated_at}, ${r.fetched_at}, ${r.expires_at}, ${r.is_stale}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

/**
 * Atomically replaces all observations for a given source: deletes the
 * existing rows for that source then bulk-inserts the fresh set in one
 * transaction. Either the full swap completes or nothing changes.
 */
export async function atomicSwap(sql: Sql, sourceId: string, fresh: Observation[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM conditions.observations WHERE source = ${sourceId}`;
    for (const batch of chunk(fresh, CHUNK_SIZE)) {
      await insertRows(tx, batch);
    }
  });
}
