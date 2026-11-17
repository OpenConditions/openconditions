/**
 * Per-peer, per-kind federation rate limiting — a TRANSPORT control over what
 * peers ask of this instance.
 *
 * A pinned peer gets a tier-aware budget for how many entries it may push to
 * this instance's inbox and how many journal reads (backfill and outbox, under
 * the "backfill" kind) it may make here per minute. This instance's own pull
 * of a peer is never metered here: it fetches one page, lands it, then asks
 * for the next, and the peer meters those reads on its side. Overrun is
 * refused with a 429 + Retry-After, which tells the peer to wait until the
 * window ends. A peer that keeps asking in that window did not wait: a window
 * with a second refusal counts toward the downgrade, and such windows in
 * {@link RATE_DOWNGRADE_WINDOWS} consecutive windows trigger a TEMPORARY tier
 * downgrade: the peer's effective tier for rate/window purposes drops by one
 * for a cooldown, renewed only by another such window, then restores. A peer
 * that always waits is refused at most once a window and never downgraded.
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
 *
 * Besides pinned peers it meters anonymous outbox readers, one key per client
 * address ({@link anonymousRateKey}), so the keys are not a short fixed list:
 * the limiter forgets a window once it ended and a downgrade once it lapsed.
 */
import { isIPv4, isIPv6 } from "node:net";
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
  /** Over-limit rejections in this window. */
  refusals: number;
}

interface DowngradeState {
  /** When the most recent window with a repeated rejection started (epoch ms). */
  lastOverStart: number;
  /** Consecutive windows with a repeated rejection counted so far. */
  streak: number;
  /** Epoch-ms until which the peer's tier is downgraded (0 = none active). */
  effectiveTierUntil: number;
}

/** The in-memory limiter, which can also say how many entries it holds. */
export interface InMemoryRateLimiter extends RateLimiter {
  /** The window and downgrade entries held now, after the last sweep. */
  trackedEntries(): number;
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
export function createInMemoryRateLimiter(options: RateLimiterOptions = {}): InMemoryRateLimiter {
  const policyForTier = options.policyForTier ?? ratePolicyForTier;
  const downgradeWindows = options.downgradeWindows ?? RATE_DOWNGRADE_WINDOWS;
  const cooldownMs = (options.downgradeCooldownSec ?? RATE_DOWNGRADE_COOLDOWN_SEC) * 1000;
  const maxPageSize = options.maxPageSize ?? RATE_MAX_PAGE_SIZE;

  const windows = new Map<string, WindowState>();
  const downgrades = new Map<string, DowngradeState>();
  let lastSweep: number | undefined;

  // Forgets the windows that ended and the downgrades that lapsed, at most
  // once per window. A window keeps its own refusal count until it ends. A
  // downgrade entry is kept while it holds and while its streak can still go
  // on (a window starting now would follow the last counted one), so
  // forgetting it never shortens a downgrade or restarts a streak.
  function sweep(now: number): void {
    if (lastSweep !== undefined && now - lastSweep < RATE_WINDOW_MS) return;
    lastSweep = now;
    for (const [key, state] of windows) {
      if (now - state.windowStart >= RATE_WINDOW_MS) windows.delete(key);
    }
    for (const [peerId, state] of downgrades) {
      if (now >= state.effectiveTierUntil && now - state.lastOverStart >= 2 * RATE_WINDOW_MS) {
        downgrades.delete(peerId);
      }
    }
  }

  function effectiveTier(peerId: string, registeredTier: 0 | 1 | 2, now: number): 0 | 1 | 2 {
    const state = downgrades.get(peerId);
    if (state !== undefined && now < state.effectiveTierUntil) {
      return Math.max(0, registeredTier - 1) as 0 | 1 | 2;
    }
    return registeredTier;
  }

  // Records a genuine sustained-RATE overrun (a refusal in a window that ALREADY
  // had activity). The first refusal of a window only tells the peer to wait
  // for the window's end (its Retry-After); a window counts from its second
  // refusal on, as the peer did not wait. A counted window that starts within
  // one window's length of the last one's end continues the streak; a window
  // between them, clean or with a single refusal, or a quiet minute, restarts
  // it. Only a sustained-rate overrun ever reaches here — an oversized single
  // page never does — so a downgrade is never armed or re-armed by page size
  // alone.
  function noteOverLimit(peerId: string, window: WindowState, now: number): void {
    window.refusals += 1;
    if (window.refusals < 2) return;
    const state = downgrades.get(peerId) ?? {
      lastOverStart: -Infinity,
      streak: 0,
      effectiveTierUntil: 0,
    };
    if (window.refusals === 2) {
      // The peer asked again in the window it was told to wait out. A window
      // of the other kind that overlaps the last counted one adds nothing.
      const gap = window.windowStart - state.lastOverStart;
      if (gap > 0) {
        state.streak = gap < 2 * RATE_WINDOW_MS ? state.streak + 1 : 1;
        state.lastOverStart = window.windowStart;
      }
    }
    if (state.streak >= downgradeWindows) {
      state.effectiveTierUntil = now + cooldownMs;
    }
    downgrades.set(peerId, state);
  }

  return {
    trackedEntries: () => windows.size + downgrades.size,
    check(peerId, kind, registeredTier, count, now) {
      sweep(now);
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
        if (refusedForRate) noteOverLimit(peerId, current!, now);
        const retryAfterSec = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000));
        const tierAfter = effectiveTier(peerId, registeredTier, now);
        return {
          ok: false,
          retryAfterSec,
          effectiveTier: tierAfter,
          downgraded: tierAfter < registeredTier,
        };
      }

      windows.set(key, {
        windowStart,
        count: priorCount + count,
        refusals: fresh ? 0 : current!.refusals,
      });
      const tierAfter = effectiveTier(peerId, registeredTier, now);
      return { ok: true, effectiveTier: tierAfter, downgraded: tierAfter < registeredTier };
    },
  };
}

/** The longest text an IPv6 address with a zone can be; anything longer is not one. */
const MAX_ADDRESS_LENGTH = 100;

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  if (address.length > MAX_ADDRESS_LENGTH) return undefined;
  const zone = address.indexOf("%");
  const plain = zone === -1 ? address : address.slice(0, zone);
  if (!isIPv6(plain)) return undefined;
  let text = plain.toLowerCase();
  // A dotted IPv4 tail (`::ffff:192.0.2.1`) stands for the last two groups.
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":") + 1;
    const [a = 0, b = 0, c = 0, d = 0] = text.slice(cut).split(".").map(Number);
    text = `${text.slice(0, cut)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = rest === undefined || rest === "" ? [] : rest.split(":");
  const zeros = rest === undefined ? [] : Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].map((group) => Number.parseInt(group, 16));
}

/**
 * What every anonymous reader's key starts with. The NUL keeps the keys apart
 * from the instance ids pinned peers are metered under, whatever a peers
 * configuration names an instance.
 */
const ANONYMOUS = "\u0000anonymous:";

/**
 * The rate-limiter key of an anonymous reader at `address`. An IPv4 address
 * counts as itself, an IPv4-mapped IPv6 address as the IPv4 address it maps,
 * and any other IPv6 address as its /64 prefix: one host is usually handed a
 * whole /64, and would otherwise read under a fresh key from every address in
 * it. Anything that is not an address shares one key, so a proxy that
 * forwards arbitrary text cannot mint a budget per string.
 */
export function anonymousRateKey(address: string): string {
  if (isIPv4(address)) return `${ANONYMOUS}${address}`;
  const groups = ipv6Groups(address);
  if (groups === undefined) return `${ANONYMOUS}unknown`;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return `${ANONYMOUS}${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${ANONYMOUS}${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}
