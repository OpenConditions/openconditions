import type { EvidencePolicy } from "@openconditions/core";
import type { EvidenceState, ResolvedCrowdRules } from "@openconditions/model";

/**
 * The evidence policy constants core's `evaluateEvidence` reads besides a
 * report's lifetime: the per-state presentation scores, the bounded
 * reliability adjustment and the asymmetric peer-confirmation trust.
 * Lifetimes and quorums are the registry's crowd rules.
 */
export const EVIDENCE_POLICY_DEFAULTS = {
  policyVersion: "v2",
  reliabilityWeight: 0.1,
  scoreByState: {
    self_reported: 0.3,
    corroborated: 0.6,
    externally_resolved: 0.9,
    negated: 0.1,
    expired: 0,
  } satisfies Record<EvidenceState, number>,
  // Asymmetric peer-confirmation trust (the "still there?" model): confidence
  // saturates below `peerConfidenceCap` (strictly under the 0.9
  // externally_resolved authority), a "gone" erodes `negateAsymmetry`× as much
  // as a confirm builds, and each sub-quorum negation shrinks remaining life by
  // `negateShrinkFactor`.
  peerConfidenceCap: 0.75,
  confirmDecay: 0.5,
  negateAsymmetry: 2,
  negateShrinkFactor: 0.5,
} as const;

/**
 * The evidence policy for a crowd report of a kind and type, or of a
 * property: its lifetime, the ceiling confirmations extend it to and the
 * corroboration and negation quorums come from the registry's crowd rules
 * (`crowdRulesFor`), the rest from {@link EVIDENCE_POLICY_DEFAULTS}.
 */
export function crowdEvidencePolicy(rules: ResolvedCrowdRules): EvidencePolicy {
  return {
    policyVersion: EVIDENCE_POLICY_DEFAULTS.policyVersion,
    corroborationMinDistinctKeys: rules.corroborationKeys,
    peerNegationMinKeys: rules.negationKeys,
    ttlSec: rules.ttlSec,
    maxLifetimeSec: rules.maxLifetimeSec,
    scoreByState: { ...EVIDENCE_POLICY_DEFAULTS.scoreByState },
    reliabilityWeight: EVIDENCE_POLICY_DEFAULTS.reliabilityWeight,
    peerConfidenceCap: EVIDENCE_POLICY_DEFAULTS.peerConfidenceCap,
    confirmDecay: EVIDENCE_POLICY_DEFAULTS.confirmDecay,
    negateAsymmetry: EVIDENCE_POLICY_DEFAULTS.negateAsymmetry,
    negateShrinkFactor: EVIDENCE_POLICY_DEFAULTS.negateShrinkFactor,
  };
}
