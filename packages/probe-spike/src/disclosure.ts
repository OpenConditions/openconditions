/**
 * The exhaustive list of what an aggregator (Leader or Helper) learns in the
 * clear about a probe report. Everything NOT on this list — the private segment,
 * the clamped speed, the reporter's identity, any coordinate or trajectory — is
 * carried only inside the two-share VDAF encoding and is never visible to a
 * single aggregator. This is asserted as a test constant so the disclosure
 * surface cannot silently grow.
 */
export interface PublicMetadataDisclosure {
  /** What each aggregator sees in the clear. */
  aggregatorSees: readonly string[];
  /** What is NEVER visible to a single aggregator. */
  neverVisibleToOneAggregator: readonly string[];
}

export const PUBLIC_METADATA_DISCLOSURE: PublicMetadataDisclosure = {
  aggregatorSees: [
    "task id (the DAP task identifier)",
    "VDAF type and parameters (Prio3Histogram length + chunk length, or Prio3Sum bit width)",
    "coarse region id (approach A) or the public segment/region partition (approach B)",
    "batch window (the coarse time window / epoch)",
    "report id / 16-byte VDAF nonce",
    "public share (VDAF joint-randomness parts)",
    "this aggregator's own input share (an additive share that reveals nothing alone)",
  ],
  neverVisibleToOneAggregator: [
    "the private segment index (approach A)",
    "the clamped speed value",
    "the reporter identity or admission key id",
    "any coordinate, map-match, or raw trajectory",
    "the other aggregator's input share",
  ],
} as const;
