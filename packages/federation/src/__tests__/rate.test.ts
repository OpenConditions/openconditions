import { describe, expect, it } from "vitest";
import {
  anonymousRateKey,
  createInMemoryRateLimiter,
  RATE_DOWNGRADE_COOLDOWN_SEC,
  RATE_DOWNGRADE_WINDOWS,
  RATE_MAX_PAGE_SIZE,
  ratePolicyForTier,
} from "../rate.js";

const MIN = 60_000;

/** Drives one genuine sustained-RATE overrun in the window at `now`: fills the
 *  window to its cap with admitted pages, then one more page tips over it. */
function burstOverCap(
  limiter: ReturnType<typeof createInMemoryRateLimiter>,
  peerId: string,
  tier: 0 | 1 | 2,
  cap: number,
  now: number,
): void {
  const page = Math.min(200, cap);
  let admitted = 0;
  while (admitted + page <= cap) {
    limiter.check(peerId, "inbox", tier, page, now);
    admitted += page;
  }
  const over = limiter.check(peerId, "inbox", tier, page, now);
  if (over.ok) throw new Error("expected the overrun page to be refused");
}

describe("ratePolicyForTier", () => {
  it("gives Tier-1 the 1000/min inbox default", () => {
    expect(ratePolicyForTier(1).inboxPerMin).toBe(1000);
  });

  it("gives Tier-0 a 100/min backfill budget", () => {
    expect(ratePolicyForTier(0).backfillPerMin).toBe(100);
  });

  it("never gives Tier-2 a tighter budget than Tier-1", () => {
    const t1 = ratePolicyForTier(1);
    const t2 = ratePolicyForTier(2);
    expect(t2.inboxPerMin).toBeGreaterThanOrEqual(t1.inboxPerMin);
    expect(t2.backfillPerMin).toBeGreaterThanOrEqual(t1.backfillPerMin);
  });
});

describe("createInMemoryRateLimiter", () => {
  it("admits up to the tier cap and refuses the overflow with a Retry-After", () => {
    const limiter = createInMemoryRateLimiter();
    const cap = ratePolicyForTier(1).inboxPerMin;
    let now = 0;
    for (let i = 0; i < cap; i++) {
      expect(limiter.check("peer-a", "inbox", 1, 1, now).ok).toBe(true);
    }
    const over = limiter.check("peer-a", "inbox", 1, 1, now);
    expect(over.ok).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
    expect(over.retryAfterSec).toBeLessThanOrEqual(60);

    // A fresh window restores the budget.
    now += MIN;
    expect(limiter.check("peer-a", "inbox", 1, 1, now).ok).toBe(true);
  });

  it("meters each peer and each kind independently", () => {
    const limiter = createInMemoryRateLimiter();
    const backfillCap = ratePolicyForTier(0).backfillPerMin;
    for (let i = 0; i < backfillCap; i++) {
      expect(limiter.check("peer-a", "backfill", 0, 1, 0).ok).toBe(true);
    }
    // Peer-a's backfill is spent but its inbox and peer-b are untouched.
    expect(limiter.check("peer-a", "backfill", 0, 1, 0).ok).toBe(false);
    expect(limiter.check("peer-a", "inbox", 0, 1, 0).ok).toBe(true);
    expect(limiter.check("peer-b", "backfill", 0, 1, 0).ok).toBe(true);
  });

  it("temporarily downgrades the effective tier after sustained overrun, then restores", () => {
    const limiter = createInMemoryRateLimiter();
    const cap = ratePolicyForTier(1).inboxPerMin;
    let now = 0;

    // A GENUINE sustained-rate overrun in each of RATE_DOWNGRADE_WINDOWS
    // consecutive windows (each window fills to cap, then tips over).
    for (let w = 0; w < RATE_DOWNGRADE_WINDOWS; w++) {
      burstOverCap(limiter, "noisy", 1, cap, now);
      now += MIN;
    }

    // The peer is now downgraded: its effective tier drops below its registered tier.
    const during = limiter.check("noisy", "backfill", 1, 1, now);
    expect(during.effectiveTier).toBe(0);
    expect(during.downgraded).toBe(true);

    // The downgrade is transport-only and lifts after the cooldown.
    now += RATE_DOWNGRADE_COOLDOWN_SEC * 1000 + MIN;
    const after = limiter.check("noisy", "backfill", 1, 1, now);
    expect(after.effectiveTier).toBe(1);
    expect(after.downgraded).toBe(false);
  });

  it("does not downgrade a peer that stays within its budget", () => {
    const limiter = createInMemoryRateLimiter();
    let now = 0;
    for (let w = 0; w < RATE_DOWNGRADE_WINDOWS + 2; w++) {
      const res = limiter.check("polite", "inbox", 1, 10, now);
      expect(res.ok).toBe(true);
      expect(res.downgraded).toBe(false);
      expect(res.effectiveTier).toBe(1);
      now += MIN;
    }
  });

  it("admits one oversized page per FRESH window even over the cap (no per-page 429-lock)", () => {
    const limiter = createInMemoryRateLimiter();
    // A Tier-0 peer (inbox cap 100) sends a single 400-item page in a fresh
    // window: it exceeds the per-minute cap but is under the page-size ceiling,
    // so the limiter admits it — the cap governs sustained RATE, not page size.
    const big = ratePolicyForTier(0).inboxPerMin + 300;
    expect(big).toBeLessThanOrEqual(RATE_MAX_PAGE_SIZE);
    const res = limiter.check("bulk", "inbox", 0, big, 0);
    expect(res.ok).toBe(true);
  });

  it("does not lock out or keep re-arming a DOWNGRADED honest peer sending one large page per window", () => {
    const limiter = createInMemoryRateLimiter();
    const cap = ratePolicyForTier(1).inboxPerMin;
    let now = 0;

    // Drive the peer into a downgrade via a genuine sustained burst.
    for (let w = 0; w < RATE_DOWNGRADE_WINDOWS; w++) {
      burstOverCap(limiter, "honest", 1, cap, now);
      now += MIN;
    }
    expect(limiter.check("honest", "backfill", 1, 1, now).downgraded).toBe(true);

    // Now it behaves: ONE large page (over the downgraded eff cap of 100, but
    // under the page ceiling) per fresh window. Each is admitted, and because no
    // refusal occurs the downgrade is never re-armed — it lifts after cooldown.
    const largePage = 300;
    expect(largePage).toBeLessThanOrEqual(RATE_MAX_PAGE_SIZE);
    for (let w = 0; w < RATE_DOWNGRADE_WINDOWS + 2; w++) {
      const res = limiter.check("honest", "inbox", 1, largePage, now);
      expect(res.ok).toBe(true);
      now += MIN;
    }

    // Cooldown elapsed with no re-arming → the tier restored.
    now += RATE_DOWNGRADE_COOLDOWN_SEC * 1000;
    const restored = limiter.check("honest", "backfill", 1, 1, now);
    expect(restored.downgraded).toBe(false);
    expect(restored.effectiveTier).toBe(1);
  });

  it("still 429s a genuine sustained burst within a single window", () => {
    const limiter = createInMemoryRateLimiter();
    const cap = ratePolicyForTier(0).backfillPerMin;
    // Fill a fresh window to its cap, then a further page in the SAME window is
    // a genuine rate overrun → refused with a Retry-After.
    for (let i = 0; i < cap; i++) {
      expect(limiter.check("greedy", "backfill", 0, 1, 0).ok).toBe(true);
    }
    const over = limiter.check("greedy", "backfill", 0, 1, 0);
    expect(over.ok).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("forgetting quiet keys", () => {
  it("forgets a key whose window ended, once per window", () => {
    const limiter = createInMemoryRateLimiter();
    limiter.check("anonymous:192.0.2.1", "backfill", 0, 1, 0);
    limiter.check("anonymous:192.0.2.2", "backfill", 0, 1, 10_000);
    expect(limiter.trackedEntries()).toBe(2);
    // The sweep of this window already ran at 0: nothing is forgotten yet.
    limiter.check("anonymous:192.0.2.3", "backfill", 0, 1, MIN - 1);
    expect(limiter.trackedEntries()).toBe(3);
    // The next sweep forgets the window that ended; the others still run.
    limiter.check("anonymous:192.0.2.3", "backfill", 0, 1, MIN);
    expect(limiter.trackedEntries()).toBe(2);
    limiter.check("anonymous:192.0.2.4", "backfill", 0, 1, 3 * MIN);
    expect(limiter.trackedEntries()).toBe(1);
  });

  it("keeps a downgrade while it holds, and forgets it once it lapsed", () => {
    const limiter = createInMemoryRateLimiter();
    const cap = ratePolicyForTier(1).inboxPerMin;
    let now = 0;
    for (let w = 0; w < RATE_DOWNGRADE_WINDOWS; w++) {
      burstOverCap(limiter, "noisy", 1, cap, now);
      now += MIN;
    }
    // Another key's traffic sweeps after the noisy peer's windows ended.
    now += 2 * MIN;
    limiter.check("quiet", "inbox", 1, 1, now);
    expect(limiter.check("noisy", "backfill", 1, 1, now).downgraded).toBe(true);

    now = (RATE_DOWNGRADE_WINDOWS - 1) * MIN + RATE_DOWNGRADE_COOLDOWN_SEC * 1000 + 2 * MIN;
    limiter.check("quiet", "inbox", 1, 1, now);
    expect(limiter.trackedEntries()).toBe(1);
  });

  it("keeps a streak that can still go on", () => {
    const limiter = createInMemoryRateLimiter({ downgradeWindows: 2 });
    const cap = ratePolicyForTier(1).inboxPerMin;
    burstOverCap(limiter, "noisy", 1, cap, 0);
    // A sweep in the next window keeps the streak, so a second overrun downgrades.
    limiter.check("quiet", "inbox", 1, 1, MIN);
    burstOverCap(limiter, "noisy", 1, cap, MIN + 1);
    expect(limiter.check("noisy", "backfill", 1, 1, MIN + 2).downgraded).toBe(true);
  });
});

describe("anonymousRateKey", () => {
  it("keys an IPv4 address as itself", () => {
    expect(anonymousRateKey("192.0.2.7")).toBe("\u0000anonymous:192.0.2.7");
  });

  it("keys an IPv6 address by its /64 prefix", () => {
    expect(anonymousRateKey("2001:db8:1:2:aaaa::1")).toBe("\u0000anonymous:2001:db8:1:2::/64");
    expect(anonymousRateKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(
      "\u0000anonymous:2001:db8:1:2::/64",
    );
    expect(anonymousRateKey("2001:db8::1")).toBe("\u0000anonymous:2001:db8:0:0::/64");
    expect(anonymousRateKey("fe80::1%eth0")).toBe("\u0000anonymous:fe80:0:0:0::/64");
  });

  it("keys an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(anonymousRateKey("::ffff:192.0.2.7")).toBe("\u0000anonymous:192.0.2.7");
    expect(anonymousRateKey("::ffff:c000:207")).toBe("\u0000anonymous:192.0.2.7");
  });

  it("gives everything that is not an address one key", () => {
    expect(anonymousRateKey("not an address")).toBe("\u0000anonymous:unknown");
  });
});
