import type { EvidencePolicy, EvidenceState } from "@openconditions/core";
import { decayMaxLifetimeSec, decayTtlSec, type DecayEntry, type DecayOrigin } from "./decay.js";

/**
 * The production evidence policy constants: the corroboration/negation
 * thresholds, per-state presentation scores, and the bounded reliability
 * adjustment magnitude consumed by core's `evaluateEvidence`. Defined once here
 * so there is a single source of truth for THE policy; {@link evidencePolicyFor}
 * pairs them with the per-(type, origin) decay TTLs.
 */
export const EVIDENCE_POLICY_DEFAULTS = {
  policyVersion: "v1",
  corroborationMinDistinctKeys: 2,
  peerNegationMinKeys: 2,
  reliabilityWeight: 0.1,
  scoreByState: {
    self_reported: 0.3,
    corroborated: 0.6,
    externally_resolved: 0.9,
    negated: 0.1,
    expired: 0,
  } satisfies Record<EvidenceState, number>,
  // Asymmetric peer-confirmation trust (the Waze/Google "still there?" model):
  // confidence saturates below `peerConfidenceCap` (strictly under the 0.9
  // externally_resolved authority), a "gone" erodes `negateAsymmetry`× as much
  // as a confirm builds, and each sub-quorum negation shrinks remaining life by
  // `negateShrinkFactor`.
  peerConfidenceCap: 0.75,
  confirmDecay: 0.5,
  negateAsymmetry: 2,
  negateShrinkFactor: 0.5,
} as const;

/**
 * Build the {@link EvidencePolicy} for a condition `type` and `origin`: the
 * decay table supplies `ttlSec` (per origin) and `maxLifetimeSec` (the
 * corroboration-extension ceiling), and {@link EVIDENCE_POLICY_DEFAULTS}
 * supplies the rest. Operator decay overrides and a policy-version pin are
 * optional. The evidence math itself lives in `@openconditions/core` and is
 * never re-implemented here.
 */
export function evidencePolicyFor(
  type: string,
  origin: DecayOrigin,
  opts?: { overrides?: Record<string, Partial<DecayEntry>>; policyVersion?: string }
): EvidencePolicy {
  return {
    policyVersion: opts?.policyVersion ?? EVIDENCE_POLICY_DEFAULTS.policyVersion,
    corroborationMinDistinctKeys: EVIDENCE_POLICY_DEFAULTS.corroborationMinDistinctKeys,
    peerNegationMinKeys: EVIDENCE_POLICY_DEFAULTS.peerNegationMinKeys,
    ttlSec: decayTtlSec(type, origin, opts?.overrides),
    maxLifetimeSec: decayMaxLifetimeSec(type, opts?.overrides),
    scoreByState: { ...EVIDENCE_POLICY_DEFAULTS.scoreByState },
    reliabilityWeight: EVIDENCE_POLICY_DEFAULTS.reliabilityWeight,
    peerConfidenceCap: EVIDENCE_POLICY_DEFAULTS.peerConfidenceCap,
    confirmDecay: EVIDENCE_POLICY_DEFAULTS.confirmDecay,
    negateAsymmetry: EVIDENCE_POLICY_DEFAULTS.negateAsymmetry,
    negateShrinkFactor: EVIDENCE_POLICY_DEFAULTS.negateShrinkFactor,
  };
}
