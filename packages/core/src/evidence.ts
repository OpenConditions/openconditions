import type { Confidence } from "./model.js";

/**
 * Replayable evidence policy + resolved-outcome Bayesian reliability.
 *
 * Pure module: no I/O, no clocks, no randomness. The evaluation instant is an
 * input, so the same ledger evaluated under the same policy version always
 * produces a byte-identical result.
 */

export type EvidenceState =
  | "self_reported"
  | "corroborated"
  | "externally_resolved"
  | "negated"
  | "expired";

export interface EvidenceEntry {
  id: string;
  /** ISO instant (UTC basis). */
  at: string;
  kind: "report" | "confirm" | "negate" | "cancel" | "external";
  /** Admitted pseudonymous device key (crowd entries; absent on external). */
  reporterKey?: string;
  /** Present on kind "external" only. */
  external?: {
    source: "official" | "reviewer" | "objective";
    outcome: "confirmed" | "rejected";
  };
}

export interface EvidenceLedger {
  /** Append-only upstream; order-insensitive input (sorted internally by (at, id)). */
  entries: EvidenceEntry[];
  /** Evaluation instant — supplied by the caller for purity. */
  now: string;
  /** Optional advisory: originating reporter's reliabilityLowerBound (0..1). */
  reporterLowerBound?: number;
}

export interface EvidencePolicy {
  policyVersion: string;
  corroborationMinDistinctKeys: number;
  peerNegationMinKeys: number;
  /** Per (type, origin) TTL in seconds — caller computes it from the decay table. */
  ttlSec: number;
  /** Bounded corroboration-extension ceiling in seconds from the first report. */
  maxLifetimeSec: number;
  /** Presentation ranking bases per state, 0..1. */
  scoreByState: Record<EvidenceState, number>;
  /** Bounded advisory adjustment magnitude (e.g. 0.1). */
  reliabilityWeight: number;
  /**
   * Saturating ceiling the crowd-state confidence asymptotes toward but never
   * reaches. Bounded strictly below `scoreByState.externally_resolved`: no
   * amount of peer agreement may reach an external resolution's authority.
   */
  peerConfidenceCap: number;
  /**
   * Per-confirmation diminishing-returns base in (0, 1). Each additional
   * distinct confirmation closes `1 - confirmDecay^c` of the gap from the
   * base to the peer cap, so smaller values saturate faster.
   */
  confirmDecay: number;
  /**
   * How much more a sub-quorum negation erodes confidence than one
   * confirmation builds it. `2.0` makes one "gone" roughly cancel two
   * confirmations (the asymmetry of the "still there?" model).
   */
  negateAsymmetry: number;
  /**
   * Per distinct sub-quorum negation, the fraction of the remaining time (from
   * the last negation's timestamp to the decay expiry) that survives. `0.5`
   * halves that remaining life per distinct negator. Shrinks life only; it
   * never extends it or sets the state to negated (only the kill quorum ends an
   * observation early). Anchoring on the ledger timestamp (not eval-time now)
   * keeps the shrunk expiry stable across recomputes.
   */
  negateShrinkFactor: number;
}

export interface EvidencePolicyResult {
  state: EvidenceState;
  /**
   * Derived PRESENTATION RANKING in [0, 1] — not a probability of truth.
   * Raw evidence is authoritative; this score only orders how prominently
   * the observation is shown.
   */
  confidenceScore: number;
  /**
   * True only for a live externally_resolved state. Peer corroboration can
   * never flip this: routing eligibility requires an external resolution.
   */
  routingEligible: boolean;
  /** ISO instant at which the observation stops being live. */
  expiresAt: string;
}

interface SortedEntry {
  entry: EvidenceEntry;
  atMs: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Incremental, saturating confidence for the two crowd states. Each distinct
 * confirmation (`confirmers`) closes a diminishing share of the gap from the
 * base to the peer cap; each distinct sub-quorum negation (`negators`) erodes
 * `negateAsymmetry` times as much per-negation, so a "gone" costs more than a
 * confirmation builds. Pure function of the distinct-key counts and the policy.
 */
function crowdConfidence(policy: EvidencePolicy, confirmers: number, negators: number): number {
  const base = policy.scoreByState.self_reported;
  const gap = policy.peerConfidenceCap - base;
  const confIncrement = gap * (1 - Math.pow(policy.confirmDecay, confirmers));
  const negPenalty = policy.negateAsymmetry * gap * (1 - Math.pow(policy.confirmDecay, negators));
  return clamp01(base + confIncrement - negPenalty);
}

/**
 * Shrink a crowd-state expiry toward the last sub-quorum negation by
 * `negateShrinkFactor^negators` of the life remaining AT THE NEGATION TIME.
 * Anchoring on the ledger's negation timestamp (not eval-time now) makes the
 * shrunk expiry a PURE function of the ledger: recomputing an unchanged ledger
 * at a later now yields the same expiry rather than relaxing it back toward the
 * full decay expiry. Shrink only — clamped to never exceed the decay expiry;
 * an already-elapsed shrunk expiry legitimately lets the `expired` overlay fire
 * (the caller's `now >= expiresAt` check is inclusive). No-op with no negations.
 */
function shrinkExpiryForNegations(
  expiryMs: number,
  negateAtMs: number,
  negators: number,
  shrinkFactor: number
): number {
  if (negators <= 0) {
    return expiryMs;
  }
  const remaining = expiryMs - negateAtMs;
  if (remaining <= 0) {
    return expiryMs;
  }
  const shrunk = negateAtMs + remaining * Math.pow(shrinkFactor, negators);
  return Math.min(expiryMs, shrunk);
}

/** The five evidence states scoreByState must supply a finite ranking base for. */
const EVIDENCE_STATES: readonly EvidenceState[] = [
  "self_reported",
  "corroborated",
  "externally_resolved",
  "negated",
  "expired",
];

/**
 * Evaluate an evidence ledger under a policy.
 *
 * Semantics (fixed by the architecture record):
 * - Entries are sorted by (at asc, id asc); entries with at > now are ignored
 *   (future evidence is not yet admissible), keeping replays deterministic.
 * - One admitted report is immediately map-visible (self_reported) with a
 *   short TTL and never routing-eligible.
 * - A second distinct admitted key corroborates, which raises prominence and
 *   extends expiry from its observation time (bounded by maxLifetimeSec), but
 *   peer agreement alone never enables routing.
 * - Only an external resolution (official / reviewer / objective) makes the
 *   observation routing-eligible; an external rejection always negates.
 * - Retraction by the originating key (its own "cancel" or "negate" entry) is
 *   negative evidence and negates at that entry's time. A "cancel" filed by a
 *   different key is peer evidence: it is reclassified as a negation, deduped
 *   by key and counted against peerNegationMinKeys like any "negate" — one
 *   stranger's all-clear is never an instant kill. A keyless "cancel" is
 *   ignored; accountable all-clears from reviewers/officials use kind
 *   "external". Peer negations negate when at least peerNegationMinKeys
 *   distinct keys negate AND the distinct negators strictly exceed the
 *   distinct confirmers.
 * - Negated observations end at the deciding entry's time and stay presented
 *   as negated; the other states decay to expired once now >= expiresAt.
 *
 * The result contains no reliability posterior: reporter reputation can only
 * be trained through updateReliability with an externally resolved outcome.
 *
 * @throws TypeError when the ledger contains no admissible "report" entry,
 *   when two admissible entries share the same id (ids are the append-only
 *   ledger identity, so a duplicate means a corrupt ledger), when
 *   reporterLowerBound is present but not a finite number in [0, 1], or when
 *   any of the five policy.scoreByState entries is missing/non-finite, or
 *   policy.reliabilityWeight, peerConfidenceCap, confirmDecay, negateAsymmetry
 *   or negateShrinkFactor is not finite.
 */
export function evaluateEvidence(
  input: EvidenceLedger,
  policy: EvidencePolicy
): EvidencePolicyResult {
  if (
    input.reporterLowerBound !== undefined &&
    !(
      Number.isFinite(input.reporterLowerBound) &&
      input.reporterLowerBound >= 0 &&
      input.reporterLowerBound <= 1
    )
  ) {
    throw new TypeError("evaluateEvidence: reporterLowerBound must be finite and within [0, 1]");
  }
  if (!Number.isFinite(policy.reliabilityWeight)) {
    throw new TypeError("evaluateEvidence: policy.reliabilityWeight must be finite");
  }
  for (const field of [
    "peerConfidenceCap",
    "confirmDecay",
    "negateAsymmetry",
    "negateShrinkFactor",
  ] as const) {
    if (!Number.isFinite(policy[field])) {
      throw new TypeError(`evaluateEvidence: policy.${field} must be finite`);
    }
  }
  // Range guards enforce the ADR ceilings in the function itself, not just via
  // the default policy: peer confidence can never reach an external
  // resolution's score, confirmations always build and negations always erode.
  if (
    !(policy.peerConfidenceCap > 0) ||
    policy.peerConfidenceCap >= policy.scoreByState.externally_resolved
  ) {
    throw new TypeError(
      "evaluateEvidence: policy.peerConfidenceCap must be > 0 and strictly less than scoreByState.externally_resolved"
    );
  }
  if (!(policy.confirmDecay > 0 && policy.confirmDecay < 1)) {
    throw new TypeError(
      "evaluateEvidence: policy.confirmDecay must be in the open interval (0, 1)"
    );
  }
  if (!(policy.negateAsymmetry >= 0)) {
    throw new TypeError("evaluateEvidence: policy.negateAsymmetry must be >= 0");
  }
  if (!(policy.negateShrinkFactor >= 0 && policy.negateShrinkFactor <= 1)) {
    throw new TypeError("evaluateEvidence: policy.negateShrinkFactor must be in [0, 1]");
  }
  // Iterate the known states (not Object.entries) so a policy MISSING an entry —
  // e.g. a lossy cast that dropped "expired" — is caught here, not silently read
  // as NaN when that state is later selected.
  for (const stateName of EVIDENCE_STATES) {
    if (!Number.isFinite(policy.scoreByState[stateName])) {
      throw new TypeError(`evaluateEvidence: policy.scoreByState.${stateName} must be finite`);
    }
  }

  const nowMs = Date.parse(input.now);
  const admissible: SortedEntry[] = input.entries
    .map((entry) => ({ entry, atMs: Date.parse(entry.at) }))
    .filter(({ atMs }) => atMs <= nowMs)
    .sort((a, b) => {
      if (a.atMs !== b.atMs) return a.atMs - b.atMs;
      if (a.entry.id < b.entry.id) return -1;
      if (a.entry.id > b.entry.id) return 1;
      return 0;
    });

  const seenIds = new Set<string>();
  for (const { entry } of admissible) {
    if (seenIds.has(entry.id)) {
      throw new TypeError(`evaluateEvidence: duplicate entry id "${entry.id}" (corrupt ledger)`);
    }
    seenIds.add(entry.id);
  }

  const reports = admissible.filter(({ entry }) => entry.kind === "report");
  const firstReport = reports[0];
  if (firstReport === undefined) {
    throw new TypeError("evaluateEvidence: ledger has no admissible report entry");
  }
  const originatingKey = firstReport.entry.reporterKey;

  const confirmerKeys = new Set<string>();
  for (const item of admissible) {
    const { entry } = item;
    const isPeerPositive =
      entry.kind === "confirm" || (entry.kind === "report" && item !== firstReport);
    if (isPeerPositive && entry.reporterKey !== undefined && entry.reporterKey !== originatingKey) {
      confirmerKeys.add(entry.reporterKey);
    }
  }

  const negatorKeys = new Set<string>();
  let lastPeerNegate: SortedEntry | undefined;
  let retraction: SortedEntry | undefined;
  let lastExternal: SortedEntry | undefined;
  let lastPositiveAtMs = firstReport.atMs;

  for (const item of admissible) {
    const { entry } = item;
    if (entry.kind === "report" || entry.kind === "confirm") {
      lastPositiveAtMs = Math.max(lastPositiveAtMs, item.atMs);
    } else if (entry.kind === "external" && entry.external !== undefined) {
      lastExternal = item;
    } else if (entry.kind === "cancel" || entry.kind === "negate") {
      if (originatingKey !== undefined && entry.reporterKey === originatingKey) {
        retraction ??= item;
      } else if (entry.reporterKey !== undefined) {
        negatorKeys.add(entry.reporterKey);
        lastPeerNegate = item;
      }
    }
  }

  const firstReportAtMs = firstReport.atMs;
  const ttlMs = policy.ttlSec * 1000;
  const maxLifetimeEndMs = firstReportAtMs + policy.maxLifetimeSec * 1000;
  const decayExpiryMs = Math.min(lastPositiveAtMs + ttlMs, maxLifetimeEndMs);

  let state: EvidenceState;
  let expiresAtMs: number;
  if (lastExternal !== undefined && lastExternal.entry.external !== undefined) {
    if (lastExternal.entry.external.outcome === "confirmed") {
      state = "externally_resolved";
      expiresAtMs = Math.min(lastExternal.atMs + ttlMs, maxLifetimeEndMs);
    } else {
      state = "negated";
      expiresAtMs = lastExternal.atMs;
    }
  } else if (retraction !== undefined) {
    state = "negated";
    expiresAtMs = retraction.atMs;
  } else if (
    negatorKeys.size >= policy.peerNegationMinKeys &&
    negatorKeys.size > confirmerKeys.size &&
    lastPeerNegate !== undefined
  ) {
    state = "negated";
    expiresAtMs = lastPeerNegate.atMs;
  } else if (1 + confirmerKeys.size >= policy.corroborationMinDistinctKeys) {
    state = "corroborated";
    expiresAtMs = shrinkExpiryForNegations(
      decayExpiryMs,
      lastPeerNegate?.atMs ?? decayExpiryMs,
      negatorKeys.size,
      policy.negateShrinkFactor
    );
  } else {
    state = "self_reported";
    expiresAtMs = shrinkExpiryForNegations(
      decayExpiryMs,
      lastPeerNegate?.atMs ?? decayExpiryMs,
      negatorKeys.size,
      policy.negateShrinkFactor
    );
  }

  if (state !== "negated" && nowMs >= expiresAtMs) {
    state = "expired";
  }

  const adjustment =
    input.reporterLowerBound !== undefined
      ? policy.reliabilityWeight * (input.reporterLowerBound - 0.5)
      : 0;

  // Only the two crowd states derive an incremental confidence from the
  // distinct-key counts; the externally_resolved / negated / expired states
  // keep their flat authority score (a crowd count is not an authority).
  const baseScore =
    state === "self_reported" || state === "corroborated"
      ? crowdConfidence(policy, confirmerKeys.size, negatorKeys.size)
      : policy.scoreByState[state];

  return {
    state,
    confidenceScore: clamp01(baseScore + adjustment),
    routingEligible: state === "externally_resolved",
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/** Beta reliability posterior; both components must be finite and > 0. */
export interface BetaPosterior {
  alpha: number;
  beta: number;
}

function assertPosterior(posterior: BetaPosterior, name: string): void {
  if (
    !Number.isFinite(posterior.alpha) ||
    !Number.isFinite(posterior.beta) ||
    posterior.alpha <= 0 ||
    posterior.beta <= 0
  ) {
    throw new TypeError(`${name}: alpha and beta must be finite and > 0`);
  }
}

/**
 * Update a reporter's Beta reliability posterior with an externally resolved
 * outcome.
 *
 * THE API IS THE GUARD: this function accepts only externally resolved
 * outcomes ("confirmed" | "rejected" from an official source, reviewer
 * decision, or objective outcome). Nothing in evaluateEvidence reads or
 * returns posteriors, so reputation cannot be trained by peer corroboration
 * through this module — colluding keys cannot train one another.
 *
 * @throws TypeError when the prior is not a valid posterior.
 */
export function updateReliability(
  prior: BetaPosterior,
  outcome: "confirmed" | "rejected"
): BetaPosterior {
  assertPosterior(prior, "updateReliability");
  return outcome === "confirmed"
    ? { alpha: prior.alpha + 1, beta: prior.beta }
    : { alpha: prior.alpha, beta: prior.beta + 1 };
}

/** Log-gamma via the Lanczos approximation (g = 7, n = 9). */
function logGamma(x: number): number {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const shifted = x - 1;
  let sum = coefficients[0];
  const t = shifted + 7.5;
  for (let i = 1; i < coefficients.length; i++) {
    sum += coefficients[i] / (shifted + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/**
 * Continued-fraction expansion for the regularized incomplete beta function
 * (modified Lentz's algorithm, as in Numerical Recipes betacf).
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 300;
  const epsilon = 3e-16;
  const floor = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let coefficient = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + coefficient * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    h *= d * c;
    coefficient = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + coefficient * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b) (Numerical Recipes betai). */
function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(logBeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * One-sided lower credible bound of a Beta posterior: the (1 - credibleLevel)
 * quantile of Beta(alpha, beta), inverted by bisection to 1e-10.
 *
 * @throws TypeError when the posterior is invalid or credibleLevel is not in
 *   the open interval (0.5, 1).
 */
export function reliabilityLowerBound(posterior: BetaPosterior, credibleLevel: number): number {
  assertPosterior(posterior, "reliabilityLowerBound");
  if (!(credibleLevel > 0.5 && credibleLevel < 1)) {
    throw new TypeError("reliabilityLowerBound: credibleLevel must be in (0.5, 1)");
  }
  const target = 1 - credibleLevel;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 200 && high - low > 1e-10; i++) {
    const mid = (low + high) / 2;
    if (regularizedIncompleteBeta(posterior.alpha, posterior.beta, mid) < target) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

/**
 * Shrink a posterior toward the cohort prior (inactivity decay):
 * cohortPrior + factor * (posterior - cohortPrior) componentwise.
 * factor 1 = no decay, factor 0 = full reset to the cohort prior.
 *
 * @throws TypeError when either posterior is invalid or factor is not in [0, 1].
 */
export function shrinkToward(
  posterior: BetaPosterior,
  cohortPrior: BetaPosterior,
  factor: number
): BetaPosterior {
  assertPosterior(posterior, "shrinkToward");
  assertPosterior(cohortPrior, "shrinkToward");
  if (!(factor >= 0 && factor <= 1)) {
    throw new TypeError("shrinkToward: factor must be in [0, 1]");
  }
  return {
    alpha: cohortPrior.alpha + factor * (posterior.alpha - cohortPrior.alpha),
    beta: cohortPrior.beta + factor * (posterior.beta - cohortPrior.beta),
  };
}

/**
 * Map a confidenceScore (a presentation ranking, not a probability) to the
 * canonical Confidence enum: >= 0.75 observed, >= 0.5 likely, >= 0.25
 * possible, else unknown.
 */
export function confidenceEnum(score: number): Confidence {
  if (score >= 0.75) return "observed";
  if (score >= 0.5) return "likely";
  if (score >= 0.25) return "possible";
  return "unknown";
}
