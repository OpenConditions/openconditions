import { createHash } from "node:crypto";
import type postgres from "postgres";
import { toIsoTimestamp, type Observation } from "@openconditions/core";
import { DOMAIN_REGISTRY } from "../domains.js";
import { upsertSourceStatus } from "./source-status.js";

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
 * Recursively sorts object keys (arrays keep their order) so `JSON.stringify`
 * is stable regardless of property insertion order — required so
 * {@link computeContentHash} never flips for the same logical content just
 * because a source re-serializes its fields in a different key order.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

interface ContentHashInput {
  id: string;
  type: string | null;
  subtype: string | null;
  category: string | null;
  severity: string | null;
  severity_source: string | null;
  headline: string | null;
  description: string | null;
  label: string | null;
  metric: string | null;
  value: number | null;
  level: string | null;
  unit: string | null;
  aggregation: string | null;
  status: string;
  geometry_json: string;
  subject: unknown;
  attributes: unknown;
  valid_from: string | null;
  valid_to: string | null;
  schedule: unknown;
  confidence: string | null;
  is_forecast: boolean;
  related_ids: unknown;
  data_updated_at: string;
  expires_at: string | null;
  // Commons content-bearing fields — hashed only WHEN PRESENT (see
  // computeContentHash). The derived/identity commons fields are intentionally
  // absent here: they never enter the hash.
  replaces: unknown;
  corroborations: unknown;
  fuzziness: string | null;
  severity_level: number | null;
  informed: unknown;
  source_uri: string | null;
  source_license: string | null;
  k_anonymity: number | null;
  dp_epsilon: number | null;
  dp_delta: number | null;
}

/**
 * Deterministic hash of everything that defines "the same observation
 * content". This is the diff key the swap upsert compares (`ON CONFLICT ...
 * WHERE content_hash IS DISTINCT FROM excluded.content_hash`) so an unchanged
 * row is never rewritten. Deliberately EXCLUDES provenance/freshness fields
 * that must never count as a content change on their own: source, domain,
 * origin, fetched_at, stale_after, is_stale. `expires_at` IS included: unlike
 * those, it is source-declared content (not derived at write time) and a hard
 * read filter + sweep-expiry boundary, so a source moving an observation's
 * expiry must count as a real change. Geometry is hashed as the GeoJSON
 * string (not the DB geom), so it stays independent of PostGIS's own
 * normalization.
 *
 * The commons content-bearing fields are folded in only WHEN PRESENT so an
 * observation carrying none of them hashes byte-identically to before those
 * columns existed — that absent-key omission is what keeps existing feeds from
 * mass-rewriting. The derived/identity commons fields (instance_id,
 * canonical_id, phenomenon_fingerprint, confidence_score, privacy_class) are
 * excluded entirely: they are derived from already-hashed content or trusted
 * writer config, so hashing them would force the same one-time full rewrite.
 */
function computeContentHash(row: ContentHashInput): string {
  const material: Record<string, unknown> = {
    id: row.id,
    type: row.type,
    subtype: row.subtype,
    category: row.category,
    severity: row.severity,
    severitySource: row.severity_source,
    headline: row.headline,
    description: row.description,
    label: row.label,
    metric: row.metric,
    value: row.value,
    level: row.level,
    unit: row.unit,
    aggregation: row.aggregation,
    status: row.status,
    geometry: row.geometry_json,
    subject: row.subject,
    attributes: row.attributes,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    schedule: row.schedule,
    confidence: row.confidence,
    isForecast: row.is_forecast,
    relatedIds: row.related_ids,
    dataUpdatedAt: row.data_updated_at,
    expiresAt: row.expires_at,
  };
  if (row.replaces != null) material.replaces = row.replaces;
  if (row.corroborations != null) material.corroborations = row.corroborations;
  if (row.fuzziness != null) material.fuzziness = row.fuzziness;
  if (row.severity_level != null) material.severityLevel = row.severity_level;
  if (row.informed != null) material.informed = row.informed;
  if (row.source_uri != null) material.sourceUri = row.source_uri;
  if (row.source_license != null) material.sourceLicense = row.source_license;
  if (row.k_anonymity != null) material.kAnonymity = row.k_anonymity;
  if (row.dp_epsilon != null) material.dpEpsilon = row.dp_epsilon;
  if (row.dp_delta != null) material.dpDelta = row.dp_delta;
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(material)))
    .digest("hex");
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
    severityLevel?: number;
  };
  // Measurement axis (e.g. RoadFlow) — populated when kind === "measurement".
  const measurement = obs as Observation & {
    metric?: string;
    value?: number;
    level?: string;
    unit?: string;
    aggregation?: string;
  };

  const row = {
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
    // Commons fields: pass-through only. `undefined` collapses to null (or the
    // column default for fuzziness/privacy_class); no derivation happens here.
    instance_id: obs.instanceId ?? null,
    canonical_id: obs.canonicalId ?? null,
    phenomenon_fingerprint: obs.phenomenonFingerprint ?? null,
    replaces: obs.replaces ?? null,
    corroborations: obs.corroborations ?? null,
    fuzziness: obs.fuzziness ?? null,
    confidence_score: obs.confidenceScore ?? null,
    severity_level: condEvent.severityLevel ?? null,
    privacy_class: obs.privacyClass ?? null,
    k_anonymity: obs.kAnonymity ?? null,
    dp_epsilon: obs.dpEpsilon ?? null,
    dp_delta: obs.dpDelta ?? null,
    informed: obs.informed ?? null,
    source_uri: obs.sourceUri ?? null,
    source_license: obs.sourceLicense ?? null,
  };

  return { ...row, content_hash: computeContentHash(row) };
}

export interface UpsertCounts {
  inserted: number;
  updated: number;
}

/**
 * Upserts a batch of observations into `conditions.observations` in a single
 * statement. The whole batch is passed as one JSONB parameter and expanded
 * server-side with `jsonb_to_recordset`; geometry is converted per row via
 * `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)`. This keeps a large flow feed
 * (~20k rows/cycle) to one round-trip per chunk instead of one per row.
 *
 * `ON CONFLICT (id) DO UPDATE ... WHERE content_hash IS DISTINCT FROM
 * excluded.content_hash` is the diff-upsert: a row whose content is
 * byte-for-byte unchanged since the last swap is left untouched entirely (its
 * `fetched_at`/`stale_after` keep their prior values) — only a row that is new
 * or genuinely changed gets rewritten, which is what makes it safe to derive
 * per-row freshness from `stale_after` no longer (see source_status) while
 * still refreshing it for rows that really were re-observed. `RETURNING
 * (xmax = 0) AS inserted` distinguishes a fresh INSERT from an UPDATE so the
 * caller gets honest per-batch counts; a row skipped by the WHERE clause
 * (unchanged) returns nothing and counts as neither.
 */
export async function upsertRows(
  tx: TransactionSql,
  batch: Observation[],
  freshnessWindowSec?: number
): Promise<UpsertCounts> {
  if (batch.length === 0) return { inserted: 0, updated: 0 };

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

  const touched = await tx<{ inserted: boolean }[]>`
    INSERT INTO conditions.observations (
      id, source, source_format, domain, kind,
      type, subtype, category, severity, severity_source,
      headline, description, label,
      metric, value, level, unit, aggregation,
      status, geom,
      subject, attributes,
      valid_from, valid_to, schedule,
      confidence, is_forecast, related_ids,
      origin, data_updated_at, fetched_at, expires_at, is_stale, stale_after, content_hash,
      instance_id, canonical_id, phenomenon_fingerprint, replaces, corroborations,
      fuzziness, confidence_score, severity_level, privacy_class, k_anonymity,
      dp_epsilon, dp_delta, informed, source_uri, source_license
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
      origin, data_updated_at, fetched_at, expires_at, is_stale, stale_after, content_hash,
      instance_id, canonical_id, phenomenon_fingerprint, replaces, corroborations,
      COALESCE(fuzziness, 'exact'), confidence_score, severity_level,
      COALESCE(privacy_class, 'unknown'), k_anonymity,
      dp_epsilon, dp_delta, informed, source_uri, source_license
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
      expires_at timestamptz, is_stale boolean, stale_after timestamptz, content_hash text,
      instance_id text, canonical_id text, phenomenon_fingerprint text,
      replaces jsonb, corroborations jsonb,
      fuzziness text, confidence_score double precision, severity_level smallint,
      privacy_class text, k_anonymity integer,
      dp_epsilon double precision, dp_delta double precision, informed jsonb,
      source_uri text, source_license text
    )
    ON CONFLICT (id) DO UPDATE SET
      source = excluded.source,
      source_format = excluded.source_format,
      domain = excluded.domain,
      kind = excluded.kind,
      type = excluded.type,
      subtype = excluded.subtype,
      category = excluded.category,
      severity = excluded.severity,
      severity_source = excluded.severity_source,
      headline = excluded.headline,
      description = excluded.description,
      label = excluded.label,
      metric = excluded.metric,
      value = excluded.value,
      level = excluded.level,
      unit = excluded.unit,
      aggregation = excluded.aggregation,
      status = excluded.status,
      geom = excluded.geom,
      subject = excluded.subject,
      attributes = excluded.attributes,
      valid_from = excluded.valid_from,
      valid_to = excluded.valid_to,
      schedule = excluded.schedule,
      confidence = excluded.confidence,
      is_forecast = excluded.is_forecast,
      related_ids = excluded.related_ids,
      origin = excluded.origin,
      data_updated_at = excluded.data_updated_at,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at,
      is_stale = excluded.is_stale,
      stale_after = excluded.stale_after,
      content_hash = excluded.content_hash,
      instance_id = excluded.instance_id,
      canonical_id = excluded.canonical_id,
      phenomenon_fingerprint = excluded.phenomenon_fingerprint,
      replaces = excluded.replaces,
      corroborations = excluded.corroborations,
      fuzziness = excluded.fuzziness,
      confidence_score = excluded.confidence_score,
      severity_level = excluded.severity_level,
      privacy_class = excluded.privacy_class,
      k_anonymity = excluded.k_anonymity,
      dp_epsilon = excluded.dp_epsilon,
      dp_delta = excluded.dp_delta,
      informed = excluded.informed,
      source_uri = excluded.source_uri,
      source_license = excluded.source_license
    WHERE conditions.observations.content_hash IS DISTINCT FROM excluded.content_hash
    RETURNING (xmax = 0) AS inserted
  `;

  let inserted = 0;
  let updated = 0;
  for (const row of touched) {
    if (row.inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}

/** Hard ceiling on rows written for a single source per swap. */
export const MAX_ROWS_PER_SOURCE = 100_000;

/**
 * Caps a source's fresh row set. Pure + synchronous so it unit-tests without a
 * database; a truncation is logged so an upstream that starts returning an
 * absurd row count is visible in the ingest logs.
 */
export function capRows<T>(fresh: T[], max: number = MAX_ROWS_PER_SOURCE): T[] {
  if (fresh.length <= max) return fresh;
  console.warn(`[ingest] row cap hit: truncating ${fresh.length} to ${max} rows for one source`);
  return fresh.slice(0, max);
}

export interface SwapCounts {
  inserted: number;
  updated: number;
  deleted: number;
}

/**
 * Reconciles `conditions.observations` for a given source with a fresh set,
 * as a diff (upsert changed/new rows, delete rows no longer present) instead
 * of the old delete-all-then-reinsert: an unchanged row (same `content_hash`)
 * is left completely alone, so a feed with a mostly-static row set no longer
 * generates a full delete+insert of dead tuples every cycle. Runs inside one
 * transaction — either the whole reconciliation completes or nothing changes.
 *
 * `pg_advisory_xact_lock` is taken first as a DB-level belt-and-suspenders
 * against two swaps for the same source racing each other (the scheduler's
 * own single-flight guard already prevents this in practice; this covers a
 * manual re-run overlapping a scheduled one, or a future caller that doesn't
 * go through the scheduler). The lock is released automatically at the end of
 * the transaction (`_xact` variant), whether it commits or rolls back.
 */
export async function atomicSwap(
  sql: Sql,
  sourceId: string,
  fresh: Observation[],
  freshnessWindowSec?: number
): Promise<SwapCounts> {
  // Last-wins de-dup by id before capping/chunking: two rows sharing an id
  // within one `fresh` set (parsers do no cross-document id dedup — e.g. the
  // streaming SAX measuredData.ts, or a `${src.id}:${externalId}` id scheme)
  // would otherwise land in the same upsert batch and the `ON CONFLICT (id)
  // DO UPDATE` throws "command cannot affect row a second time", rolling back
  // the whole source's swap. A `Map` keyed by id keeps insertion order and the
  // last entry written for a given id wins, matching "most recent occurrence
  // in the fresh set" semantics.
  const deduped = [...new Map(fresh.map((obs) => [obs.id, obs] as const)).values()];
  const capped = capRows(deduped);
  const keptIds = capped.map((obs) => obs.id);

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))`;

    let inserted = 0;
    let updated = 0;
    for (const batch of chunk(capped, CHUNK_SIZE)) {
      const counts = await upsertRows(tx, batch, freshnessWindowSec);
      inserted += counts.inserted;
      updated += counts.updated;
    }

    // Delete-missing: rows for this source that are no longer in the fresh
    // set (an empty fresh set — genuinely no data this cycle — deletes every
    // remaining row for the source, same as the old delete-all behavior).
    const removed = await tx<{ id: string }[]>`
      DELETE FROM conditions.observations o
      WHERE o.source = ${sourceId}
        AND NOT EXISTS (
          SELECT 1 FROM unnest(${tx.array(keptIds)}::text[]) AS f(id) WHERE f.id = o.id
        )
      RETURNING o.id
    `;

    // Write the success source_status row in this SAME transaction, not as a
    // separate call after atomicSwap returns: a brand-new source's rows are
    // visible to the 5-min orphan sweep (sweep.ts) the instant this
    // transaction commits, and the sweep treats a source with no
    // source_status row as orphaned. A status write landing after a separate
    // later commit left a window where the sweep could see the new rows with
    // no matching source_status row yet and delete them right back out.
    // Skipped when freshnessWindowSec is omitted — callers exercising
    // atomicSwap directly without a feed's status semantics (unit tests).
    if (freshnessWindowSec != null) {
      await upsertSourceStatus(tx, sourceId, {
        freshnessWindowSec,
        outcome: "success",
        rowCount: fresh.length,
      });
    }

    return { inserted, updated, deleted: removed.length };
  });
}
