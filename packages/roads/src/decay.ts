/**
 * Per-type decay-TTL policy and expiry derivation.
 *
 * Decay is the PRIMARY trust mechanism for crowd data and the primary GDPR
 * data-minimisation mitigant for federation: an observation that is not
 * refreshed or corroborated stops being live after a bounded, per-type TTL.
 * The values in {@link DEFAULT_DECAY_TTLS} are policy (fixed); this module is
 * just the table plus three pure lookups — no I/O, no clocks, no randomness.
 *
 * Crowd TTLs are always shorter than feed TTLs (crowd data is trusted less and
 * ages out faster). Feed fallback TTLs exist only for the rare official row
 * that carries no validity window: official rows NORMALLY carry their own
 * validTo/expiry from the feed, and an explicit trusted validTo always wins AT
 * THE CALLER — these functions only supply the derivation when none exists.
 *
 * {@link DecayEntry.maxLifetimeSec} is the corroboration-extension ceiling
 * consumed by `evaluateEvidence`'s `policy.maxLifetimeSec`
 * (@openconditions/core evidence.ts): corroboration may push an observation's
 * expiry out but never past `firstReport + maxLifetimeSec`, and a
 * cancellation/negation ends it early. That evidence logic is already
 * implemented and tested in core and is NOT re-implemented here.
 */

export type DecayOrigin = "feed" | "crowd";

export interface DecayEntry {
  crowdTtlSec: number;
  feedTtlSec: number;
  maxLifetimeSec: number;
}

/** Recursively freeze the policy table so a caller cannot mutate shared TTLs. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const name of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[name]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Default decay policy keyed by canonical road/transit event type. `crowd` <
 * `feed` <= `maxLifetime` holds for every row (asserted in the test suite).
 * Deep-frozen (entries too) so this shared policy cannot be mutated at runtime.
 */
export const DEFAULT_DECAY_TTLS: Record<string, DecayEntry> = deepFreeze({
  congestion: { crowdTtlSec: 300, feedTtlSec: 600, maxLifetimeSec: 3600 },
  hazard: { crowdTtlSec: 900, feedTtlSec: 1800, maxLifetimeSec: 7200 },
  accident: { crowdTtlSec: 1800, feedTtlSec: 3600, maxLifetimeSec: 14400 },
  road_closure: { crowdTtlSec: 14400, feedTtlSec: 28800, maxLifetimeSec: 86400 },
  lane_closure: { crowdTtlSec: 14400, feedTtlSec: 28800, maxLifetimeSec: 86400 },
  roadworks: { crowdTtlSec: 604800, feedTtlSec: 1209600, maxLifetimeSec: 2592000 },
  transit_disruption: { crowdTtlSec: 1800, feedTtlSec: 3600, maxLifetimeSec: 14400 },
  accessibility: { crowdTtlSec: 7200, feedTtlSec: 14400, maxLifetimeSec: 43200 },
  // Canonical alias of the accessibility bucket: broken elevators/escalators
  // report as type "equipment_fault", so the intended accessibility TTLs must
  // be reachable under that key too.
  equipment_fault: { crowdTtlSec: 7200, feedTtlSec: 14400, maxLifetimeSec: 43200 },
});

/** Decay policy for an event type not present in {@link DEFAULT_DECAY_TTLS}. */
export const FALLBACK_DECAY: DecayEntry = deepFreeze({
  crowdTtlSec: 900,
  feedTtlSec: 1800,
  maxLifetimeSec: 7200,
});

const ENTRY_FIELDS = ["crowdTtlSec", "feedTtlSec", "maxLifetimeSec"] as const;

function assertOrigin(origin: DecayOrigin): void {
  if (origin !== "feed" && origin !== "crowd") {
    throw new TypeError(`decay origin must be "feed" or "crowd", got: ${String(origin)}`);
  }
}

/**
 * Resolve the effective decay entry for a type: the table default (or
 * {@link FALLBACK_DECAY}) with the operator's partial per-type override merged
 * on top. Only known {@link DecayEntry} fields are read from the override;
 * unknown override keys (and override entries for other types) are ignored.
 *
 * @throws TypeError when an applied override value is not a finite number >= 0.
 */
function resolveEntry(type: string, overrides?: Record<string, Partial<DecayEntry>>): DecayEntry {
  const base = DEFAULT_DECAY_TTLS[type] ?? FALLBACK_DECAY;
  const override = overrides?.[type];
  if (override === undefined) {
    return base;
  }
  const merged: DecayEntry = { ...base };
  for (const field of ENTRY_FIELDS) {
    const value = override[field];
    if (value === undefined) {
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(
        `decay override ${type}.${field} must be a finite number >= 0, got: ${String(value)}`
      );
    }
    merged[field] = value;
  }
  return merged;
}

/** The decay TTL in seconds for a (type, origin), honouring operator overrides. */
export function decayTtlSec(
  type: string,
  origin: DecayOrigin,
  overrides?: Record<string, Partial<DecayEntry>>
): number {
  assertOrigin(origin);
  const entry = resolveEntry(type, overrides);
  return origin === "crowd" ? entry.crowdTtlSec : entry.feedTtlSec;
}

/** The corroboration-extension ceiling in seconds for a type (see module JSDoc). */
export function decayMaxLifetimeSec(
  type: string,
  overrides?: Record<string, Partial<DecayEntry>>
): number {
  return resolveEntry(type, overrides).maxLifetimeSec;
}

const HAS_ZONE_DESIGNATOR = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

// The string must start with the ISO calendar-date shape, optionally followed
// by a `T` time part — the same gate as core's `timeBucket`. This rejects
// locale/legacy formats ("07/10/2026", "Fri Jul 10 2026", "July 10, 2026")
// and expanded ±YYYYYY years before they reach V8's lenient,
// timezone-dependent legacy Date.parse path.
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

/**
 * Parse an ISO instant to epoch ms, with the same ISO-calendar-shape gate and
 * UTC pinning of offset-less datetimes as core's `timeBucket`. Replicated
 * locally (rather than importing) because core exposes no epoch-ms parse
 * helper, only the bucket-quantising `timeBucket`; keeping it here avoids a
 * fragile dependency on that function's internals.
 *
 * @throws TypeError when `value` is not a string, is not ISO-calendar-shaped,
 *   or does not parse to a finite instant.
 */
function parseInstantMs(value: string): number {
  if (typeof value !== "string") {
    throw new TypeError(`expiresAtFor requires an ISO dataUpdatedAt string, got: ${String(value)}`);
  }
  if (!ISO_CALENDAR_DATE.test(value)) {
    throw new TypeError(
      `expiresAtFor requires an ISO calendar date (YYYY-MM-DD, optionally with a T time part): ${value}`
    );
  }
  const pinned = value.includes("T") && !HAS_ZONE_DESIGNATOR.test(value) ? `${value}Z` : value;
  const epochMs = Date.parse(pinned);
  if (!Number.isFinite(epochMs)) {
    throw new TypeError(`expiresAtFor got an invalid dataUpdatedAt: ${value}`);
  }
  return epochMs;
}

/**
 * Derive the ISO expiry instant for an observation: `dataUpdatedAt` plus the
 * (type, origin) decay TTL. This is the pure fallback derivation only — a
 * feed's own explicit, trusted validTo should win at the caller.
 *
 * @throws TypeError on an unknown origin, a bad override value, or an
 *   unparseable `dataUpdatedAt`.
 */
export function expiresAtFor(
  dataUpdatedAt: string,
  type: string,
  origin: DecayOrigin,
  overrides?: Record<string, Partial<DecayEntry>>
): string {
  const ttlSec = decayTtlSec(type, origin, overrides);
  const startMs = parseInstantMs(dataUpdatedAt);
  return new Date(startMs + ttlSec * 1000).toISOString();
}
