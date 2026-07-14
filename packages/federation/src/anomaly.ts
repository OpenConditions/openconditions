/**
 * Per-peer anomaly baselining — MONITORING ONLY.
 *
 * A peer that suddenly changes its behaviour (a 10x event-rate spike, a
 * collapsed type-distribution entropy, a lurching confidence distribution) is a
 * smell worth an OPERATOR's attention. {@link detectAnomaly} compares a rolling
 * baseline against a recent window and names the drift signals.
 *
 * BINDING (ADR §8): this NEVER blocks a peer, NEVER rejects an event, and NEVER
 * judges an event's truth. Its output is a reviewer NOTIFICATION — a flag, a
 * metric, a log line — nothing more. A block is a separate, accountable operator
 * decision (see peer-blocklist.ts); a data-quality downgrade of an event
 * requires an EXTERNALLY RESOLVED outcome, never this signal.
 *
 * Co-location weighting (ADR §4/§8) — DEFERRED. The intent that a federated
 * corroboration lacking any plausible co-location evidence should weigh LESS in
 * canonicalId corroboration is real, but the full proximity-graph Sybil defense
 * is out of scope here and is a funded-research follow-up. Federated
 * corroboration composes with the crowd co-reporting monitoring signal
 * (services/contributions-api/src/abuse/coreporting.ts) — also monitoring-only,
 * never a hard block. Do NOT infer a speculative co-location graph from this
 * module.
 */

/** A peer's rolling behavioural baseline. */
export interface PeerBaseline {
  /** Typical events per minute. */
  eventsPerMin: number;
  /** Typical Shannon entropy (bits) of the event-type distribution. */
  typeEntropy: number;
  /** Typical mean confidence of the peer's events. */
  meanConfidence: number;
}

/** A recent window's summary statistics, in the same units as the baseline. */
export type PeerWindowStats = PeerBaseline;

export interface DetectAnomalyOptions {
  /** Rate multiple over baseline that counts as a spike (default 10x). */
  rateSpikeFactor?: number;
  /** Entropy fraction of baseline below which the distribution has collapsed. */
  entropyCollapseFraction?: number;
  /** Absolute mean-confidence shift that counts as a distribution shift. */
  confidenceShiftDelta?: number;
}

export interface AnomalyResult {
  anomalous: boolean;
  /** The named drift signals; empty when nothing drifted. */
  signals: string[];
}

const DEFAULTS: Required<DetectAnomalyOptions> = {
  rateSpikeFactor: 10,
  entropyCollapseFraction: 0.4,
  confidenceShiftDelta: 0.3,
};

/**
 * Compares a `window` against a peer's `baseline` and names any drift. Pure and
 * side-effect-free — the caller decides how to surface a positive result (log,
 * metric, reviewer flag). It does NOT block or reject.
 */
export function detectAnomaly(
  baseline: PeerBaseline,
  window: PeerWindowStats,
  options: DetectAnomalyOptions = {}
): AnomalyResult {
  const opts = { ...DEFAULTS, ...options };
  const signals: string[] = [];

  if (
    baseline.eventsPerMin > 0 &&
    window.eventsPerMin >= baseline.eventsPerMin * opts.rateSpikeFactor
  ) {
    signals.push("event_rate_spike");
  }

  if (
    baseline.typeEntropy > 0 &&
    window.typeEntropy <= baseline.typeEntropy * opts.entropyCollapseFraction
  ) {
    signals.push("type_entropy_collapse");
  }

  if (Math.abs(window.meanConfidence - baseline.meanConfidence) >= opts.confidenceShiftDelta) {
    signals.push("confidence_shift");
  }

  return { anomalous: signals.length > 0, signals };
}

/** A raw observation window over which {@link peerWindowStats} computes stats. */
export interface RawPeerWindow {
  /** The window length in seconds. */
  windowSec: number;
  /** Event count per event type over the window. */
  typeCounts: Record<string, number>;
  /** Per-event confidence scores over the window (may be empty). */
  confidences: number[];
}

/** Shannon entropy (bits) of a discrete count distribution. */
function shannonEntropy(counts: number[]): number {
  const total = counts.reduce((sum, c) => sum + c, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Reduces a raw per-peer window into the {@link PeerWindowStats} shape
 * {@link detectAnomaly} consumes. Wiring note: compute the baseline as a rolling
 * average of these same stats over prior windows (from the inbox stats), and
 * surface a positive {@link detectAnomaly} result to logs / the peer-health
 * reviewer notification — never to an accept/reject path.
 */
export function peerWindowStats(window: RawPeerWindow): PeerWindowStats {
  const counts = Object.values(window.typeCounts);
  const events = counts.reduce((sum, c) => sum + c, 0);
  const eventsPerMin = window.windowSec > 0 ? (events / window.windowSec) * 60 : 0;
  const meanConfidence =
    window.confidences.length > 0
      ? window.confidences.reduce((sum, c) => sum + c, 0) / window.confidences.length
      : 0;
  return { eventsPerMin, typeEntropy: shannonEntropy(counts), meanConfidence };
}
