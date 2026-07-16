/**
 * Feed-arrives-later periodic cross-match: closes the one A1 gap
 * {@link crossValidateAgainstFeeds} cannot cover on its own. A1 fires only at
 * crowd-landing and matches a feed that is ALREADY present; a crowd report that
 * lands BEFORE its confirming official feed is therefore never validated by the
 * landing hook. This sweep re-runs the existing, already-Fable-reviewed A1
 * function over the still-unresolved crowd reports so a feed arriving later
 * retroactively routes them.
 *
 * It only ENUMERATES candidates and delegates every routing decision to
 * {@link crossValidateAgainstFeeds} — so all of A1's guarantees carry unchanged:
 * routing happens exclusively on a genuine `origin.kind === "feed"` match
 * (crowd↔crowd never routes), flagged reports are skipped, reputation is trained
 * only by `applyExternalResolution` on a real feed match, and the whole thing is
 * idempotent (a re-scan of an already-routed report is a no-op — and such a
 * report is excluded from the candidate set anyway once `routing_eligible` flips).
 *
 * There is no long transaction: the sweep holds only the candidate-id read, and
 * each per-id A1 call opens its own transaction. The batch is bounded so a single
 * cycle can never scan unboundedly; any overflow is logged with its size (never
 * silently dropped) and picked up on a later cycle.
 */
import type postgres from "postgres";
import { crossValidateAgainstFeeds as defaultCrossValidate } from "./crossValidate.js";

type Sql = postgres.Sql;

/** Default per-cycle candidate cap. */
export const DEFAULT_SWEEP_MAX_BATCH = 500;

/** Injection seams (defaults to the real A1 function + a no-op logger). */
export interface SweepCrossValidateDeps {
  crossValidateAgainstFeeds?: typeof defaultCrossValidate;
  /** Maximum candidates scanned in one cycle (per each sweep's own ordering). */
  maxBatch?: number;
  log?: (msg: string) => void;
}

export interface SweepResult {
  /** Candidates actually visited this cycle (≤ maxBatch). */
  scanned: number;
  /** Candidates the A1 function routed (non-null match). */
  routed: number;
}

/**
 * Enumerate still-unresolved crowd-event candidates and re-run
 * {@link crossValidateAgainstFeeds} against each, counting scanned vs routed.
 *
 * A candidate is an ACTIVE, non-routing crowd EVENT with a phenomenon
 * fingerprint that has not expired — exactly the reports a later feed could now
 * validate. Flagged reports still appear here (the query does not special-case
 * them); A1 skips them internally, so they are scanned but never routed.
 *
 * Best-effort per id: a throw on one candidate is logged and does not abort the
 * remaining candidates.
 */
export async function sweepCrossValidate(
  sql: Sql,
  now: string,
  deps: SweepCrossValidateDeps = {}
): Promise<SweepResult> {
  const crossValidate = deps.crossValidateAgainstFeeds ?? defaultCrossValidate;
  const maxBatch = deps.maxBatch ?? DEFAULT_SWEEP_MAX_BATCH;
  const log = deps.log ?? (() => {});

  // Read one extra row over the cap so an overflow is detectable (and loggable)
  // without a COUNT on the common no-overflow path. Oldest-first keeps the scan
  // fair across cycles.
  //
  // The `origin->'reporter'->>'keyId' IS NOT NULL` clause excludes rows A1 can
  // never route: a federation-ingested REMOTE crowd row keeps origin.kind='crowd'
  // but has its reporter (and keyId) stripped on export, so crossValidateAgainstFeeds
  // always rejects it (routing requires a reporter keyId). Without this filter such
  // rows never drain and, being oldest, would sit at the head of every cycle and
  // starve real feed-arrives-later candidates until they expire.
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.observations
    WHERE status = 'active'
      AND routing_eligible = false
      AND kind = 'event'
      AND origin->>'kind' = 'crowd'
      AND origin->'reporter'->>'keyId' IS NOT NULL
      AND phenomenon_fingerprint IS NOT NULL
      AND (expires_at IS NULL OR expires_at > ${now})
    ORDER BY valid_from ASC
    LIMIT ${maxBatch + 1}
  `;

  const overflow = rows.length > maxBatch;
  const batch = overflow ? rows.slice(0, maxBatch) : rows;
  if (overflow) {
    // Overflow is off the hot path: pay for an exact deferred count so the log
    // carries the backlog size, not just "≥1 deferred".
    const [{ n: total } = { n: batch.length }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.observations
      WHERE status = 'active'
        AND routing_eligible = false
        AND kind = 'event'
        AND origin->>'kind' = 'crowd'
        AND origin->'reporter'->>'keyId' IS NOT NULL
        AND phenomenon_fingerprint IS NOT NULL
        AND (expires_at IS NULL OR expires_at > ${now})
    `;
    log(
      `[cross-validate-sweep] candidate batch capped at ${maxBatch}; ` +
        `deferring ${total - maxBatch} candidate(s) to a later cycle`
    );
  }

  let scanned = 0;
  let routed = 0;
  for (const { id } of batch) {
    scanned += 1;
    try {
      const matched = await crossValidate(sql, id, now);
      if (matched !== null) routed += 1;
    } catch (err) {
      log(`[cross-validate-sweep] candidate ${id} failed: ${String(err)}`);
    }
  }

  return { scanned, routed };
}

/**
 * The STARVATION-SAFE sibling of {@link sweepCrossValidate} for genuinely-
 * FEDERATED crowd rows. The local T2 sweep deliberately EXCLUDES keyId-less rows
 * (a federation-stripped remote crowd row): they can never route under its strict
 * keyId guard, and being oldest they would sit at the head of every oldest-first
 * cycle and starve real candidates until they expire. That leaves the
 * feed-arrives-later case UNCOVERED for federated crowd rows — a local feed that
 * lands AFTER a federated crowd row never retroactively routes it.
 *
 * This sweep closes that gap over EXACTLY the federated crowd rows the T2 sweep
 * skips, and is starvation-safe by construction rather than by exclusion:
 *
 *  - `expires_at > now` bounds the candidate set to still-relevant rows AND
 *    excludes NULL-expiry rows (`NULL > now` evaluates to NULL → filtered out), so
 *    a never-expiring row can NEVER clog the set forever. Crowd TTLs are short
 *    (minutes-to-a-day), so the set self-clears via expiry.
 *  - `ORDER BY expires_at ASC` visits the SOONEST-to-expire rows first — each row
 *    gets its cross-validation attempts BEFORE it expires (its last chance), so a
 *    real feed-arrives-later candidate near expiry is never deferred behind rows
 *    with ample time.
 *  - The batch cap bounds per-cycle work; at extreme volume some rows expire
 *    un-attempted — acceptable (best-effort densification; the sensor/feed base
 *    stands). The deferred overflow is logged, never silently dropped.
 *
 * The candidate predicate is the INVERSE of the T2 sweep's keyId filter, narrowed
 * to genuinely-federated rows (keyId-less crowd WITH a non-empty originChain — a
 * keyId-less crowd row WITHOUT one is a local anomaly, not federated). Every
 * routing decision is delegated to {@link crossValidateAgainstFeeds} with
 * `allowFederatedTarget: true`, which relaxes ONLY the keyId guard for a real
 * federated crowd target: the local-feed-only candidate guard (crowd↔crowd never
 * routes; a federated FEED is never a routable target) is unchanged, and in the
 * federated-only case the route TRAINS NOBODY (a NULL-keyed originator resolves to
 * no affected keys). Idempotent: a routed row flips `routing_eligible` and drops
 * out of the candidate set. Best-effort per id.
 */
export async function sweepFederatedCrossValidate(
  sql: Sql,
  now: string,
  deps: SweepCrossValidateDeps = {}
): Promise<SweepResult> {
  const crossValidate = deps.crossValidateAgainstFeeds ?? defaultCrossValidate;
  const maxBatch = deps.maxBatch ?? DEFAULT_SWEEP_MAX_BATCH;
  const log = deps.log ?? (() => {});

  // Read one extra row over the cap so an overflow is detectable (and loggable)
  // without a COUNT on the common no-overflow path.
  //
  // `origin->'reporter'->>'keyId' IS NULL` is the INVERSE of the T2 sweep's filter
  // — this sweep owns exactly the federated crowd rows the T2 sweep skips. The
  // originChain clauses narrow to GENUINELY federated rows (a keyId-less crowd row
  // without an originChain is a local anomaly, never routed). `expires_at > now`
  // (NOT the T2 sweep's `expires_at IS NULL OR ...`) is the anti-starvation bound:
  // it excludes NULL-expiry rows so a never-expiring row can never clog the head,
  // and `ORDER BY expires_at ASC` gives each row its attempts before it expires.
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.observations
    WHERE status = 'active'
      AND routing_eligible = false
      AND kind = 'event'
      AND origin->>'kind' = 'crowd'
      AND origin->'reporter'->>'keyId' IS NULL
      AND jsonb_typeof(origin->'originChain') = 'array'
      AND jsonb_array_length(origin->'originChain') > 0
      AND phenomenon_fingerprint IS NOT NULL
      AND expires_at > ${now}
    ORDER BY expires_at ASC
    LIMIT ${maxBatch + 1}
  `;

  const overflow = rows.length > maxBatch;
  const batch = overflow ? rows.slice(0, maxBatch) : rows;
  if (overflow) {
    const [{ n: total } = { n: batch.length }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.observations
      WHERE status = 'active'
        AND routing_eligible = false
        AND kind = 'event'
        AND origin->>'kind' = 'crowd'
        AND origin->'reporter'->>'keyId' IS NULL
        AND jsonb_typeof(origin->'originChain') = 'array'
        AND jsonb_array_length(origin->'originChain') > 0
        AND phenomenon_fingerprint IS NOT NULL
        AND expires_at > ${now}
    `;
    log(
      `[federated-cross-validate-sweep] candidate batch capped at ${maxBatch}; ` +
        `deferring ${total - maxBatch} candidate(s) to a later cycle`
    );
  }

  let scanned = 0;
  let routed = 0;
  for (const { id } of batch) {
    scanned += 1;
    try {
      const matched = await crossValidate(sql, id, now, { allowFederatedTarget: true });
      if (matched !== null) routed += 1;
    } catch (err) {
      log(`[federated-cross-validate-sweep] candidate ${id} failed: ${String(err)}`);
    }
  }

  return { scanned, routed };
}

/**
 * Whether the periodic sweep should be scheduled. Off-by-sentinel: any value
 * other than the explicit `"off"` opt-out leaves it enabled (the default).
 */
export function isCrossValidateSweepEnabled(env: Record<string, string | undefined>): boolean {
  return env["OPENCONDITIONS_CROSS_VALIDATE_SWEEP"] !== "off";
}

/**
 * Wrap a tick body in a single-flight guard: while a run is in flight, an
 * overlapping tick returns immediately without invoking `run`, so a slow sweep
 * can never overlap itself. Extracted from the main.ts scheduler so the guard
 * (and the opt-out) are unit-testable without a real timer.
 */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } finally {
      running = false;
    }
  };
}
