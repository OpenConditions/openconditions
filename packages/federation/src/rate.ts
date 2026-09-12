/**
 * Per-peer, per-kind federation rate limiting — a TRANSPORT control.
 *
 * A pinned peer gets a tier-aware budget for how many events it may push to the
 * inbox and how many backfill reads it may make per minute. Overrun is refused
 * with a 429 + Retry-After; SUSTAINED overrun (an over-limit rejection in
 * {@link RATE_DOWNGRADE_WINDOWS} consecutive windows) triggers a TEMPORARY tier
 * downgrade: the peer's effective tier for rate/window purposes drops by one for
 * a cooldown, then restores.
 *
 * BINDING (ADR §8): PEER HEALTH IS SEPARATE FROM EVENT TRUTH. This limiter and
 * the downgrade it applies affect TRANSPORT ONLY — the rate at which a peer may
 * deliver, and its backfill window. They NEVER reject an already-accepted event,
 * NEVER judge an event's truth, and NEVER feed evidence, confidence, routing, or
 * reputation. A downgraded peer's events that were already ingested stay exactly
 * as trusted as before.
 *
 * The limiter is in-memory and per-instance — correct for a single replica. A
 * multi-replica deployment would back the windows with Redis (INCR + EXPIRE per
 * peer/kind/window); the interface is unchanged.
 */
import { OUTBOX_MAX_LIMIT } from "./outbox.js";

/** A peer's per-minute transport budget, derived from its trust tier. */
export interface PeerRatePolicy {
  inboxPerMin: number;
  backfillPerMin: number;
}

/** The fixed metering window, in milliseconds. */
export const RATE_WINDOW_MS = 60_000;

/** Consecutive over-limit windows that trigger a temporary tier downgrade. */
export const RATE_DOWNGRADE_WINDOWS = 3;

/** How long a triggered tier downgrade holds before the tier restores, seconds. */
export const RATE_DOWNGRADE_COOLDOWN_SEC = 300;

/**
 * The largest single page (event count) a FRESH window admits regardless of the
 * per-minute cap — mirrors {@link OUTBOX_MAX_LIMIT}, the max page a peer serves
 * or pushes. The limiter enforces sustained per-minute RATE, not per-page size,
 * so one legitimate page never 429-locks a peer (even a downgraded one); a page
 * beyond this ceiling is a malformed-size refusal that does NOT arm a downgrade.
 */
export const RATE_MAX_PAGE_SIZE = OUTBOX_MAX_LIMIT;

const TIER_POLICIES: Record<0 | 1 | 2, PeerRatePolicy> = {
  0: { inboxPerMin: 100, backfillPerMin: 100 },
  1: { inboxPerMin: 1000, backfillPerMin: 300 },
  2: { inboxPerMin: 2000, backfillPerMin: 600 },
};

/**
 * The per-minute transport budget for a trust tier. Tier-1 is the 1000/min
 * inbox default; Tier-0 keeps a 100/min backfill floor; Tier-2 is never tighter
 * than Tier-1.
 */
export function ratePolicyForTier(tier: 0 | 1 | 2): PeerRatePolicy {
  return TIER_POLICIES[tier];
}

/** The outcome of a single rate check. */
export interface RateCheckResult {
  /** Whether this request is admitted. */
  ok: boolean;
  /** Seconds until the peer may retry (set only when refused). */
  retryAfterSec?: number;
  /** The peer's EFFECTIVE tier after any active downgrade (transport only). */
  effectiveTier: 0 | 1 | 2;
  /** Whether the effective tier is currently below the peer's registered tier. */
  downgraded: boolean;
}

export interface RateLimiter {
  /**
   * Meters `count` requests of `kind` from `peerId` at `now` (epoch ms) against
   * the budget for the peer's `registeredTier` (or its temporarily-downgraded
   * effective tier). Refusal carries a Retry-After; every result reports the
   * peer's effective tier and whether a transport downgrade is active.
   */
  check(
    peerId: string,
    kind: "inbox" | "backfill",
    registeredTier: 0 | 1 | 2,
    count: number,
    now: number,
  ): RateCheckResult;
}

interface WindowState {
  windowStart: number;
  count: number;
}

interface DowngradeState {
  /** The window index of the most recent over-limit rejection. */
  lastOverWindow: number;
  /** Consecutive over-limit windows counted so far. */
  streak: number;
  /** Epoch-ms until which the peer's tier is downgraded (0 = none active). */
  effectiveTierUntil: number;
}

export interface RateLimiterOptions {
  policyForTier?: (tier: 0 | 1 | 2) => PeerRatePolicy;
  downgradeWindows?: number;
  downgradeCooldownSec?: number;
  /** Fresh-window single-page ceiling; defaults to {@link RATE_MAX_PAGE_SIZE}. */
  maxPageSize?: number;
}

/**
 * An in-memory {@link RateLimiter} with per-peer/per-kind fixed windows and the
 * sustained-overrun tier downgrade. Single-instance; swap the window store for
 * Redis to scale across replicas.
 */
export function createInMemoryRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const policyForTier = options.policyForTier ?? ratePolicyForTier;
  const downgradeWindows = options.downgradeWindows ?? RATE_DOWNGRADE_WINDOWS;
  const cooldownMs = (options.downgradeCooldownSec ?? RATE_DOWNGRADE_COOLDOWN_SEC) * 1000;
  const maxPageSize = options.maxPageSize ?? RATE_MAX_PAGE_SIZE;

  const windows = new Map<string, WindowState>();
  const downgrades = new Map<string, DowngradeState>();

  function effectiveTier(peerId: string, registeredTier: 0 | 1 | 2, now: number): 0 | 1 | 2 {
    const state = downgrades.get(peerId);
    if (state !== undefined && now < state.effectiveTierUntil) {
      return Math.max(0, registeredTier - 1) as 0 | 1 | 2;
    }
    return registeredTier;
  }

  // Records a genuine sustained-RATE overrun (a refusal in a window that ALREADY
  // had activity). Consecutive over-limit windows accumulate a streak; a clean
  // window between overruns restarts it (the window-index gap). Only a
  // sustained-rate overrun ever reaches here — an oversized single page never
  // does — so a downgrade is never armed or re-armed by page size alone.
  function noteOverLimit(peerId: string, now: number): void {
    const windowIndex = Math.floor(now / RATE_WINDOW_MS);
    const state = downgrades.get(peerId) ?? {
      lastOverWindow: -Infinity,
      streak: 0,
      effectiveTierUntil: 0,
    };
    if (windowIndex === state.lastOverWindow) {
      // Another rejection in a window already counted — no new window.
    } else if (windowIndex === state.lastOverWindow + 1) {
      state.streak += 1;
    } else {
      state.streak = 1;
    }
    state.lastOverWindow = windowIndex;
    if (state.streak >= downgradeWindows) {
      state.effectiveTierUntil = now + cooldownMs;
    }
    downgrades.set(peerId, state);
  }

  return {
    check(peerId, kind, registeredTier, count, now) {
      const tier = effectiveTier(peerId, registeredTier, now);
      const policy = policyForTier(tier);
      const cap = kind === "inbox" ? policy.inboxPerMin : policy.backfillPerMin;

      const key = `${peerId}\u0000${kind}`;
      const current = windows.get(key);
      const fresh = current === undefined || now - current.windowStart >= RATE_WINDOW_MS;
      const windowStart = fresh ? now : current!.windowStart;
      const priorCount = fresh ? 0 : current!.count;

      // A window that ALREADY saw traffic refuses on the per-minute cap — that
      // is a genuine sustained-RATE overrun (arms the downgrade). A FRESH window
      // (no prior activity) admits a single page up to the page-size ceiling
      // regardless of the cap, so one legitimate page never 429-locks a peer
      // (even a downgraded one); a page beyond the ceiling is a malformed-SIZE
      // refusal that does NOT arm the downgrade.
      const refusedForRate = priorCount > 0 && priorCount + count > cap;
      const refusedForSize = priorCount === 0 && count > maxPageSize;

      if (refusedForRate || refusedForSize) {
        if (refusedForRate) noteOverLimit(peerId, now);
        const retryAfterSec = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000));
        const tierAfter = effectiveTier(peerId, registeredTier, now);
        return {
          ok: false,
          retryAfterSec,
          effectiveTier: tierAfter,
          downgraded: tierAfter < registeredTier,
        };
      }

      windows.set(key, { windowStart, count: priorCount + count });
      const tierAfter = effectiveTier(peerId, registeredTier, now);
      return { ok: true, effectiveTier: tierAfter, downgraded: tierAfter < registeredTier };
    },
  };
}
