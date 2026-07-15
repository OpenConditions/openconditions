import { describe, it, expect } from "vitest";
import {
  evaluateEvidence,
  updateReliability,
  reliabilityLowerBound,
  shrinkToward,
  confidenceEnum,
  type EvidenceEntry,
  type EvidenceLedger,
  type EvidencePolicy,
} from "../evidence.js";

const T0 = Date.parse("2026-07-01T10:00:00.000Z");

/** ISO instant `minutes` after T0. */
function iso(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

function entry(
  id: string,
  minutes: number,
  kind: EvidenceEntry["kind"],
  reporterKey?: string
): EvidenceEntry {
  return { id, at: iso(minutes), kind, ...(reporterKey !== undefined ? { reporterKey } : {}) };
}

function external(
  id: string,
  minutes: number,
  outcome: "confirmed" | "rejected",
  source: "official" | "reviewer" | "objective" = "official"
): EvidenceEntry {
  return { id, at: iso(minutes), kind: "external", external: { source, outcome } };
}

const TEST_POLICY: EvidencePolicy = {
  policyVersion: "test-1",
  corroborationMinDistinctKeys: 2,
  peerNegationMinKeys: 2,
  ttlSec: 3600,
  maxLifetimeSec: 6 * 3600,
  scoreByState: {
    self_reported: 0.3,
    corroborated: 0.6,
    externally_resolved: 0.9,
    negated: 0.1,
    expired: 0,
  },
  reliabilityWeight: 0.1,
  peerConfidenceCap: 0.75,
  confirmDecay: 0.5,
  negateAsymmetry: 2,
  negateShrinkFactor: 0.5,
};

function ledger(
  entries: EvidenceEntry[],
  nowMinutes: number,
  reporterLowerBound?: number
): EvidenceLedger {
  return {
    entries,
    now: iso(nowMinutes),
    ...(reporterLowerBound !== undefined ? { reporterLowerBound } : {}),
  };
}

describe("evaluateEvidence cold-start ladder", () => {
  const report = entry("r1", 0, "report", "keyA");
  const confirm = entry("c1", 20, "confirm", "keyB");
  const resolved = external("x1", 30, "confirmed");

  it("single report is self_reported, map-visible, never routing-eligible, expires at reportAt+ttl", () => {
    const result = evaluateEvidence(ledger([report], 10), TEST_POLICY);
    expect(result).toEqual({
      state: "self_reported",
      confidenceScore: 0.3,
      routingEligible: false,
      expiresAt: iso(60),
    });
  });

  it("a second distinct admitted key corroborates, raises the score, extends expiry from the confirm time, and STILL does not enable routing", () => {
    const result = evaluateEvidence(ledger([report, confirm], 25), TEST_POLICY);
    // One distinct confirmation (c=1) yields the incremental crowd confidence
    // 0.3 + (0.75 - 0.3) * (1 - 0.5^1) = 0.525, replacing the old flat 0.6 step.
    expect(result).toEqual({
      state: "corroborated",
      confidenceScore: 0.525,
      routingEligible: false,
      expiresAt: iso(20 + 60),
    });
  });

  it("external confirmation makes it externally_resolved and routing-eligible", () => {
    const result = evaluateEvidence(ledger([report, confirm, resolved], 40), TEST_POLICY);
    expect(result).toEqual({
      state: "externally_resolved",
      confidenceScore: 0.9,
      routingEligible: true,
      expiresAt: iso(30 + 60),
    });
  });

  it("advancing now past expiry yields expired, routing false, keeping the computed expiresAt", () => {
    const result = evaluateEvidence(ledger([report, confirm, resolved], 120), TEST_POLICY);
    expect(result).toEqual({
      state: "expired",
      confidenceScore: 0,
      routingEligible: false,
      expiresAt: iso(90),
    });
  });

  it("now exactly at expiresAt is already expired (now >= expiresAt)", () => {
    const result = evaluateEvidence(ledger([report], 60), TEST_POLICY);
    expect(result.state).toBe("expired");
    expect(result.expiresAt).toBe(iso(60));
  });
});

describe("evaluateEvidence corroboration rules", () => {
  it("a same-key confirm does NOT corroborate (the original reporter cannot corroborate their own report)", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("c1", 5, "confirm", "keyA")], 10),
      TEST_POLICY
    );
    expect(result.state).toBe("self_reported");
  });

  it("a keyless confirm does NOT corroborate", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("c1", 5, "confirm")], 10),
      TEST_POLICY
    );
    expect(result.state).toBe("self_reported");
  });

  it("a second distinct-key report counts toward corroboration", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("r2", 5, "report", "keyB")], 10),
      TEST_POLICY
    );
    expect(result.state).toBe("corroborated");
  });

  it("corroboration extends expiry from the confirm's observation time but never beyond firstReportAt+maxLifetime", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("c1", 330, "confirm", "keyB")], 335),
      TEST_POLICY
    );
    expect(result.state).toBe("corroborated");
    expect(result.expiresAt).toBe(iso(360));
  });

  it("corroboration alone never flips routing, no matter how many distinct keys agree", () => {
    const entries = [entry("r1", 0, "report", "keyA")];
    for (let i = 0; i < 10; i++) {
      entries.push(entry(`c${i}`, i + 1, "confirm", `key${i}`));
    }
    const result = evaluateEvidence(ledger(entries, 15), TEST_POLICY);
    expect(result.state).toBe("corroborated");
    expect(result.routingEligible).toBe(false);
  });
});

describe("evaluateEvidence incremental crowd confidence (asymmetric peer trust)", () => {
  const B = TEST_POLICY.scoreByState.self_reported;

  function scoreForConfirmers(confirmers: number, nowMinutes: number): number {
    const entries = [entry("r1", 0, "report", "keyA")];
    for (let i = 0; i < confirmers; i++) {
      entries.push(entry(`c${i}`, i + 1, "confirm", `key${i}`));
    }
    return evaluateEvidence(ledger(entries, nowMinutes), TEST_POLICY).confidenceScore;
  }

  it("rises with each distinct confirmation, with diminishing returns, never reaching the peer cap or externally_resolved score", () => {
    const c1 = scoreForConfirmers(1, 5);
    const c2 = scoreForConfirmers(2, 5);
    const c3 = scoreForConfirmers(3, 5);
    // 0.3 + 0.45*(1 - 0.5^c)
    expect(c1).toBeCloseTo(0.525, 12);
    expect(c2).toBeCloseTo(0.6375, 12);
    expect(c3).toBeCloseTo(0.69375, 12);
    expect(c1).toBeLessThan(c2);
    expect(c2).toBeLessThan(c3);
    // Diminishing returns: each successive gain is smaller than the last.
    expect(c2 - c1).toBeLessThan(c1 - B);
    expect(c3 - c2).toBeLessThan(c2 - c1);
    // Saturates strictly below the peer cap, which is strictly below 0.9.
    expect(c3).toBeLessThan(TEST_POLICY.peerConfidenceCap);
    expect(TEST_POLICY.peerConfidenceCap).toBeLessThan(
      TEST_POLICY.scoreByState.externally_resolved
    );
  });

  it("saturates below the peer cap even with dozens of confirmations", () => {
    const entries = [entry("r1", 0, "report", "keyA")];
    for (let i = 0; i < 40; i++) {
      entries.push(entry(`c${i}`, i + 1, "confirm", `key${i}`));
    }
    const result = evaluateEvidence(ledger(entries, 60), TEST_POLICY);
    expect(result.state).toBe("corroborated");
    expect(result.confidenceScore).toBeLessThan(TEST_POLICY.peerConfidenceCap);
    expect(result.confidenceScore).toBeLessThan(TEST_POLICY.scoreByState.externally_resolved);
  });

  it("a self-confirm by the originating key does not raise confidence (exclusion holds)", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("c1", 5, "confirm", "keyA")], 10),
      TEST_POLICY
    );
    expect(result.state).toBe("self_reported");
    expect(result.confidenceScore).toBe(0.3);
  });
});

describe("evaluateEvidence asymmetric sub-quorum negation", () => {
  it("one sub-quorum negation erodes more confidence than one confirmation built, without negating or removing", () => {
    const oneConfirm = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("c1", 5, "confirm", "keyB")], 10),
      TEST_POLICY
    );
    const confirmThenNegate = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("c1", 5, "confirm", "keyB"),
          entry("n1", 8, "negate", "keyC"),
        ],
        10
      ),
      TEST_POLICY
    );
    expect(oneConfirm.confidenceScore).toBeCloseTo(0.525, 12);
    // Still corroborated (1 confirmer, 1 sub-quorum negator < peerNegationMinKeys),
    // never routing-eligible, and NOT removed (expiry stays in the future).
    expect(confirmThenNegate.state).toBe("corroborated");
    expect(confirmThenNegate.routingEligible).toBe(false);
    // 0.3 + 0.225 - 0.9*(1 - 0.5^1) = 0.075
    expect(confirmThenNegate.confidenceScore).toBeCloseTo(0.075, 12);
    const built = oneConfirm.confidenceScore - 0.3;
    const eroded = oneConfirm.confidenceScore - confirmThenNegate.confidenceScore;
    expect(eroded).toBeGreaterThan(built);
    expect(confirmThenNegate.confidenceScore).toBeLessThan(0.3);
    expect(Date.parse(confirmThenNegate.expiresAt)).toBeGreaterThan(Date.parse(iso(10)));
  });

  it("a sub-quorum negation shrinks remaining TTL from the negation time but keeps the state corroborated", () => {
    const entries = [
      entry("r1", 0, "report", "keyA"),
      entry("c1", 20, "confirm", "keyB"),
      entry("n1", 25, "negate", "keyC"),
    ];
    const withNeg = evaluateEvidence(ledger(entries, 30), TEST_POLICY);
    const withoutNeg = evaluateEvidence(ledger([entries[0], entries[1]], 30), TEST_POLICY);
    // Without the negation: confirm at 20 + 60min TTL = 80.
    expect(withoutNeg.expiresAt).toBe(iso(80));
    // With it, anchored at the negation time (25): remaining 80 - 25 = 55min;
    // * 0.5^1 = 27.5min → 25 + 27.5 = 52.5 (independent of eval-time now).
    expect(withNeg.state).toBe("corroborated");
    expect(withNeg.expiresAt).toBe(iso(52.5));
    expect(Date.parse(withNeg.expiresAt)).toBeLessThan(Date.parse(withoutNeg.expiresAt));
    expect(Date.parse(withNeg.expiresAt)).toBeGreaterThan(Date.parse(iso(30)));
  });

  it("a sub-quorum negation on a lone self-report drops confidence and shrinks TTL but stays self_reported and live", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("n1", 10, "negate", "keyB")], 15),
      TEST_POLICY
    );
    expect(result.state).toBe("self_reported");
    // 0.3 + 0 - 0.9*(1 - 0.5^1) = -0.15 → clamped to 0.
    expect(result.confidenceScore).toBe(0);
    // decay expiry = report(0) + 60 = 60; anchored at negation time (10):
    // remaining 60 - 10 = 50; *0.5 = 25 → 10 + 25 = 35.
    expect(result.expiresAt).toBe(iso(35));
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.parse(iso(15)));
  });

  it("the negation kill quorum is unchanged: 2 distinct negators exceeding confirmers negate immediately at the deciding time", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("c1", 5, "confirm", "keyB"),
          entry("n1", 10, "negate", "keyC"),
          entry("n2", 12, "negate", "keyD"),
        ],
        20
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("negated");
    expect(result.confidenceScore).toBe(0.1);
    expect(result.expiresAt).toBe(iso(12));
  });
});

describe("evaluateEvidence asymmetric-trust ADR guardrails", () => {
  it("no number of confirmations flips routingEligible or reaches the externally_resolved score", () => {
    const entries = [entry("r1", 0, "report", "keyA")];
    for (let i = 0; i < 50; i++) {
      entries.push(entry(`c${i}`, i + 1, "confirm", `key${i}`));
    }
    const result = evaluateEvidence(ledger(entries, 60), TEST_POLICY);
    expect(result.routingEligible).toBe(false);
    expect(result.confidenceScore).toBeLessThan(TEST_POLICY.scoreByState.externally_resolved);
    expect(result.confidenceScore).toBeLessThan(TEST_POLICY.peerConfidenceCap);
  });

  it("an external resolution still yields routingEligible and the flat 0.9 authority score (crowd math never touches it)", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("c1", 5, "confirm", "keyB"),
          entry("c2", 6, "confirm", "keyC"),
          external("x1", 30, "confirmed"),
        ],
        40
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("externally_resolved");
    expect(result.routingEligible).toBe(true);
    expect(result.confidenceScore).toBe(0.9);
  });

  it("peer confirmations and negations never train reputation: the result carries no posterior", () => {
    const prior = { alpha: 1, beta: 1 };
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("c1", 1, "confirm", "keyB"),
          entry("c2", 2, "confirm", "keyC"),
          entry("n1", 3, "negate", "keyD"),
        ],
        5
      ),
      TEST_POLICY
    );
    expect(Object.keys(result).sort()).toEqual([
      "confidenceScore",
      "expiresAt",
      "routingEligible",
      "state",
    ]);
    expect(prior).toEqual({ alpha: 1, beta: 1 });
  });

  it("crowd confidence + TTL shrink are deterministic replays: identical results across repeated calls", () => {
    const input = ledger(
      [
        entry("r1", 0, "report", "keyA"),
        entry("c1", 5, "confirm", "keyB"),
        entry("c2", 6, "confirm", "keyC"),
        entry("n1", 8, "negate", "keyD"),
      ],
      12,
      0.7
    );
    expect(evaluateEvidence(input, TEST_POLICY)).toEqual(evaluateEvidence(input, TEST_POLICY));
  });

  it("the sub-quorum-shrunk expiry is anchored to the ledger, not eval-time now: it stays STABLE (never relaxes) across recomputes at different now", () => {
    const entries = [
      entry("r1", 0, "report", "keyA"),
      entry("c1", 5, "confirm", "keyB"),
      entry("c2", 6, "confirm", "keyC"),
      entry("n1", 8, "negate", "keyD"),
    ];
    // decay expiry = lastPositive(6) + 60 = 66; anchored at negation time (8):
    // remaining 66 - 8 = 58; * 0.5^1 = 29 → 8 + 29 = 37, regardless of now.
    const atEarly = evaluateEvidence(ledger(entries, 12), TEST_POLICY);
    const atLater = evaluateEvidence(ledger(entries, 30), TEST_POLICY);
    expect(atEarly.state).toBe("corroborated");
    expect(atLater.state).toBe("corroborated");
    expect(atEarly.expiresAt).toBe(iso(37));
    // A later recompute of the unchanged ledger must NOT relax the shrunk expiry.
    expect(atLater.expiresAt).toBe(atEarly.expiresAt);
    // And once now passes the shrunk expiry the observation expires at that same instant.
    const atExpired = evaluateEvidence(ledger(entries, 40), TEST_POLICY);
    expect(atExpired.state).toBe("expired");
    expect(atExpired.expiresAt).toBe(iso(37));
  });

  it("throws TypeError for a non-finite asymmetric-trust policy field", () => {
    for (const field of [
      "peerConfidenceCap",
      "confirmDecay",
      "negateAsymmetry",
      "negateShrinkFactor",
    ] as const) {
      const badPolicy: EvidencePolicy = { ...TEST_POLICY, [field]: NaN };
      expect(() =>
        evaluateEvidence(ledger([entry("r1", 0, "report", "keyA")], 5), badPolicy)
      ).toThrow(TypeError);
    }
  });

  it.each([
    // peerConfidenceCap must be > 0 and strictly below externally_resolved (0.9).
    { field: "peerConfidenceCap", value: 0 },
    { field: "peerConfidenceCap", value: -0.1 },
    { field: "peerConfidenceCap", value: 0.9 },
    { field: "peerConfidenceCap", value: 0.95 },
    // confirmDecay must be in the open interval (0, 1).
    { field: "confirmDecay", value: 0 },
    { field: "confirmDecay", value: 1 },
    { field: "confirmDecay", value: 1.5 },
    { field: "confirmDecay", value: -0.5 },
    // negateAsymmetry must be >= 0.
    { field: "negateAsymmetry", value: -0.1 },
    // negateShrinkFactor must be in [0, 1].
    { field: "negateShrinkFactor", value: -0.1 },
    { field: "negateShrinkFactor", value: 1.1 },
  ] as const)(
    "throws TypeError for an out-of-range policy.$field = $value (ADR ceiling enforced in-function)",
    ({ field, value }) => {
      const badPolicy: EvidencePolicy = { ...TEST_POLICY, [field]: value };
      expect(() =>
        evaluateEvidence(ledger([entry("r1", 0, "report", "keyA")], 5), badPolicy)
      ).toThrow(TypeError);
    }
  );

  it("a finite-but-malformed policy cannot breach the peer-cap ceiling: peerConfidenceCap >= externally_resolved is rejected before any confidence is derived", () => {
    const breaching: EvidencePolicy = { ...TEST_POLICY, peerConfidenceCap: 0.95 };
    const entries = [entry("r1", 0, "report", "keyA")];
    for (let i = 0; i < 50; i++) {
      entries.push(entry(`c${i}`, i + 1, "confirm", `key${i}`));
    }
    expect(() => evaluateEvidence(ledger(entries, 60), breaching)).toThrow(TypeError);
  });
});

describe("evaluateEvidence negative evidence", () => {
  it("external rejection negates and ends expiry at the resolution time (even when now is far past it)", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), external("x1", 30, "rejected", "reviewer")], 120),
      TEST_POLICY
    );
    expect(result).toEqual({
      state: "negated",
      confidenceScore: 0.1,
      routingEligible: false,
      expiresAt: iso(30),
    });
  });

  it("external rejection overrides any amount of peer corroboration", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("c1", 5, "confirm", "keyB"),
          entry("c2", 6, "confirm", "keyC"),
          external("x1", 30, "rejected", "objective"),
        ],
        40
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("negated");
  });

  it("a later external overrides an earlier one (rejected then confirmed => externally_resolved)", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          external("x1", 30, "rejected"),
          external("x2", 40, "confirmed"),
        ],
        50
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("externally_resolved");
    expect(result.routingEligible).toBe(true);
  });

  it("a later external overrides an earlier one (confirmed then rejected => negated)", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          external("x1", 30, "confirmed"),
          external("x2", 40, "rejected"),
        ],
        50
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("negated");
    expect(result.expiresAt).toBe(iso(40));
  });

  it("externals with the same at are ordered by id (later id decides)", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          external("xa", 30, "confirmed"),
          external("xb", 30, "rejected"),
        ],
        40
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("negated");
  });

  it("an originating-key cancel is a retraction, negating at the cancel time", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("k1", 15, "cancel", "keyA")], 20),
      TEST_POLICY
    );
    expect(result).toEqual({
      state: "negated",
      confidenceScore: 0.1,
      routingEligible: false,
      expiresAt: iso(15),
    });
  });

  it("an originating-key negate is treated as a retraction (negates regardless of the peer-negation threshold)", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("n1", 10, "negate", "keyA")], 20),
      TEST_POLICY
    );
    expect(result.state).toBe("negated");
    expect(result.expiresAt).toBe(iso(10));
  });

  it("a single foreign-key cancel is peer evidence, not an instant kill (cannot negate below the peer threshold)", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("k1", 10, "cancel", "keyB")], 20),
      TEST_POLICY
    );
    expect(result.state).toBe("self_reported");
  });

  it("a foreign-key cancel counts toward peer negation alongside negate entries", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("k1", 10, "cancel", "keyB"),
          entry("n1", 12, "negate", "keyC"),
        ],
        20
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("negated");
    expect(result.expiresAt).toBe(iso(12));
  });

  it("foreign cancels and negates dedupe by reporter key", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("k1", 10, "cancel", "keyB"),
          entry("n1", 12, "negate", "keyB"),
        ],
        20
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("self_reported");
  });

  it("a keyless cancel is ignored (accountable all-clears use kind external)", () => {
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), entry("k1", 10, "cancel")], 20),
      TEST_POLICY
    );
    expect(result).toEqual({
      state: "self_reported",
      confidenceScore: 0.3,
      routingEligible: false,
      expiresAt: iso(60),
    });
  });

  it("peer negation: 2 distinct negators vs 1 confirmer negates (>= min AND > confirmers)", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("c1", 5, "confirm", "keyB"),
          entry("n1", 10, "negate", "keyC"),
          entry("n2", 12, "negate", "keyD"),
        ],
        20
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("negated");
    expect(result.expiresAt).toBe(iso(12));
  });

  it("peer negation: 2 negators vs 2 confirmers does NOT negate (must EXCEED, not tie)", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("c1", 5, "confirm", "keyB"),
          entry("c2", 6, "confirm", "keyC"),
          entry("n1", 10, "negate", "keyD"),
          entry("n2", 12, "negate", "keyE"),
        ],
        20
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("corroborated");
  });

  it("the same negator key counts once toward peer negation", () => {
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "keyA"),
          entry("n1", 10, "negate", "keyB"),
          entry("n2", 12, "negate", "keyB"),
        ],
        20
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("self_reported");
  });
});

describe("evaluateEvidence determinism and admissibility", () => {
  const entries = [
    entry("r1", 0, "report", "keyA"),
    entry("c1", 5, "confirm", "keyB"),
    entry("c2", 5, "confirm", "keyC"),
    entry("n1", 10, "negate", "keyD"),
    external("x1", 30, "confirmed"),
  ];

  it("ignores future-dated entries (evidence beyond now is not yet admissible)", () => {
    const result = evaluateEvidence(ledger(entries, 8), TEST_POLICY);
    expect(result.state).toBe("corroborated");
    expect(result.routingEligible).toBe(false);
  });

  it("throws TypeError when no report entry is admissible", () => {
    expect(() =>
      evaluateEvidence(ledger([entry("c1", 5, "confirm", "keyB")], 10), TEST_POLICY)
    ).toThrow(TypeError);
    expect(() =>
      evaluateEvidence(ledger([entry("r1", 20, "report", "keyA")], 10), TEST_POLICY)
    ).toThrow(TypeError);
    expect(() => evaluateEvidence(ledger([], 10), TEST_POLICY)).toThrow(TypeError);
  });

  it("is insensitive to entry order, including same-at ties with distinct ids (replay determinism)", () => {
    const baseline = evaluateEvidence(ledger(entries, 40), TEST_POLICY);
    const permutations = [
      [...entries].reverse(),
      [entries[2], entries[1], entries[0], entries[4], entries[3]],
      [entries[3], entries[0], entries[4], entries[2], entries[1]],
    ];
    for (const permuted of permutations) {
      expect(evaluateEvidence(ledger(permuted, 40), TEST_POLICY)).toEqual(baseline);
    }
  });

  it("evaluating the same ledger and policy twice yields deep-equal results", () => {
    const input = ledger(entries, 40, 0.7);
    expect(evaluateEvidence(input, TEST_POLICY)).toEqual(evaluateEvidence(input, TEST_POLICY));
  });

  it("throws TypeError when two admissible entries share the same id (corrupt ledger), in both input orders", () => {
    const report = entry("r1", 0, "report", "keyA");
    const confirmedX = external("x", 30, "confirmed");
    const rejectedX = external("x", 30, "rejected");
    expect(() =>
      evaluateEvidence(ledger([report, confirmedX, rejectedX], 40), TEST_POLICY)
    ).toThrow(TypeError);
    expect(() =>
      evaluateEvidence(ledger([report, rejectedX, confirmedX], 40), TEST_POLICY)
    ).toThrow(TypeError);
  });

  it("excludes entries whose at is not a parseable instant", () => {
    const garbage: EvidenceEntry = {
      id: "g1",
      at: "not-a-date",
      kind: "confirm",
      reporterKey: "keyB",
    };
    const result = evaluateEvidence(
      ledger([entry("r1", 0, "report", "keyA"), garbage], 10),
      TEST_POLICY
    );
    expect(result.state).toBe("self_reported");
    expect(result.expiresAt).toBe(iso(60));
  });
});

describe("evaluateEvidence input validation", () => {
  const report = entry("r1", 0, "report", "keyA");

  it.each([NaN, Infinity, -Infinity, -1, 2])(
    "throws TypeError for reporterLowerBound %s",
    (value) => {
      expect(() => evaluateEvidence(ledger([report], 10, value), TEST_POLICY)).toThrow(TypeError);
    }
  );

  it("throws TypeError for a non-finite scoreByState value", () => {
    const badPolicy: EvidencePolicy = {
      ...TEST_POLICY,
      scoreByState: { ...TEST_POLICY.scoreByState, corroborated: NaN },
    };
    expect(() => evaluateEvidence(ledger([report], 10), badPolicy)).toThrow(TypeError);
  });

  it("throws TypeError for a non-finite reliabilityWeight", () => {
    const badPolicy: EvidencePolicy = { ...TEST_POLICY, reliabilityWeight: NaN };
    expect(() => evaluateEvidence(ledger([report], 10), badPolicy)).toThrow(TypeError);
  });

  it("throws TypeError when scoreByState is missing a state entry (lossy cast dropped 'expired')", () => {
    const { expired: _dropped, ...partial } = TEST_POLICY.scoreByState;
    const badPolicy = {
      ...TEST_POLICY,
      scoreByState: partial,
    } as unknown as EvidencePolicy;
    expect(() => evaluateEvidence(ledger([report], 10), badPolicy)).toThrow(TypeError);
  });
});

describe("evaluateEvidence reporterLowerBound adjustment", () => {
  const report = entry("r1", 0, "report", "keyA");

  it("is absent-safe: no adjustment when reporterLowerBound is undefined", () => {
    expect(evaluateEvidence(ledger([report], 10), TEST_POLICY).confidenceScore).toBe(0.3);
  });

  it("adjusts by reliabilityWeight * (reporterLowerBound - 0.5), bounded by the weight", () => {
    expect(evaluateEvidence(ledger([report], 10, 1), TEST_POLICY).confidenceScore).toBeCloseTo(
      0.35,
      12
    );
    expect(evaluateEvidence(ledger([report], 10, 0), TEST_POLICY).confidenceScore).toBeCloseTo(
      0.25,
      12
    );
    expect(evaluateEvidence(ledger([report], 10, 0.5), TEST_POLICY).confidenceScore).toBe(0.3);
  });

  it("clamps the score to [0, 1]", () => {
    const low = evaluateEvidence(ledger([report], 120, 0), TEST_POLICY);
    expect(low.state).toBe("expired");
    expect(low.confidenceScore).toBe(0);

    const highPolicy: EvidencePolicy = {
      ...TEST_POLICY,
      scoreByState: { ...TEST_POLICY.scoreByState, self_reported: 0.98 },
    };
    expect(evaluateEvidence(ledger([report], 10, 1), highPolicy).confidenceScore).toBe(1);
  });
});

describe("updateReliability", () => {
  it("confirmed increments alpha; rejected increments beta", () => {
    expect(updateReliability({ alpha: 1, beta: 1 }, "confirmed")).toEqual({ alpha: 2, beta: 1 });
    expect(updateReliability({ alpha: 1, beta: 1 }, "rejected")).toEqual({ alpha: 1, beta: 2 });
    expect(updateReliability({ alpha: 3.5, beta: 2 }, "confirmed")).toEqual({
      alpha: 4.5,
      beta: 2,
    });
  });

  it("does not mutate the prior", () => {
    const prior = { alpha: 2, beta: 3 };
    updateReliability(prior, "confirmed");
    expect(prior).toEqual({ alpha: 2, beta: 3 });
  });

  it("throws TypeError on invalid posteriors", () => {
    expect(() => updateReliability({ alpha: 0, beta: 1 }, "confirmed")).toThrow(TypeError);
    expect(() => updateReliability({ alpha: 1, beta: -1 }, "confirmed")).toThrow(TypeError);
    expect(() => updateReliability({ alpha: NaN, beta: 1 }, "confirmed")).toThrow(TypeError);
    expect(() => updateReliability({ alpha: 1, beta: Infinity }, "confirmed")).toThrow(TypeError);
  });

  it("only externally resolved outcomes reach the posterior: peer corroboration never trains reputation", () => {
    const prior = { alpha: 1, beta: 1 };
    const result = evaluateEvidence(
      ledger(
        [
          entry("r1", 0, "report", "colluderA"),
          entry("c1", 1, "confirm", "colluderB"),
          entry("c2", 2, "confirm", "colluderC"),
        ],
        5
      ),
      TEST_POLICY
    );
    expect(result.state).toBe("corroborated");
    expect(Object.keys(result).sort()).toEqual([
      "confidenceScore",
      "expiresAt",
      "routingEligible",
      "state",
    ]);
    expect(prior).toEqual({ alpha: 1, beta: 1 });
  });
});

describe("reliabilityLowerBound", () => {
  it.each([
    // Verified against scipy 2026-07-11 via:
    //   uv run --with scipy python3 -c "from scipy.stats import beta; print(beta.ppf(q, a, b))"
    // where q = 1 - credibleLevel.
    { alpha: 1, beta: 1, level: 0.95, expected: 0.05 },
    { alpha: 2, beta: 1, level: 0.95, expected: 0.22360679774997896 },
    { alpha: 1, beta: 2, level: 0.95, expected: 0.025320565519103607 },
    { alpha: 2, beta: 2, level: 0.95, expected: 0.13535036217158378 },
    { alpha: 3, beta: 1, level: 0.95, expected: 0.3684031498640387 },
    { alpha: 3, beta: 2, level: 0.95, expected: 0.2486046257301818 },
    { alpha: 2, beta: 3, level: 0.95, expected: 0.09761146288641434 },
    { alpha: 5, beta: 2, level: 0.95, expected: 0.4181965907479741 },
    { alpha: 10, beta: 3, level: 0.95, expected: 0.5618945648846887 },
    { alpha: 20, beta: 5, level: 0.95, expected: 0.6581926505958837 },
    { alpha: 2, beta: 2, level: 0.9, expected: 0.19580010565909173 },
    { alpha: 4, beta: 6, level: 0.975, expected: 0.1369956622651665 },
  ])(
    "Beta($alpha, $beta) lower bound at credible level $level matches scipy ($expected)",
    ({ alpha, beta, level, expected }) => {
      expect(reliabilityLowerBound({ alpha, beta }, level)).toBeCloseTo(expected, 9);
    }
  );

  it("increases with each added confirmed outcome and decreases with each rejected", () => {
    let posterior = { alpha: 2, beta: 2 };
    let previous = reliabilityLowerBound(posterior, 0.95);
    for (let i = 0; i < 5; i++) {
      posterior = updateReliability(posterior, "confirmed");
      const bound = reliabilityLowerBound(posterior, 0.95);
      expect(bound).toBeGreaterThan(previous);
      previous = bound;
    }
    const rejected = updateReliability(posterior, "rejected");
    expect(reliabilityLowerBound(rejected, 0.95)).toBeLessThan(previous);
  });

  it("stays in [0, 1] and below the posterior mean", () => {
    const posteriors = [
      { alpha: 1, beta: 1 },
      { alpha: 2, beta: 2 },
      { alpha: 10, beta: 1 },
      { alpha: 1, beta: 10 },
      { alpha: 50, beta: 7 },
    ];
    for (const posterior of posteriors) {
      const bound = reliabilityLowerBound(posterior, 0.95);
      expect(bound).toBeGreaterThanOrEqual(0);
      expect(bound).toBeLessThanOrEqual(1);
      expect(bound).toBeLessThan(posterior.alpha / (posterior.alpha + posterior.beta));
    }
  });

  it("gives a LOW bound for wide newcomer priors (useful but uncertain)", () => {
    expect(reliabilityLowerBound({ alpha: 1, beta: 1 }, 0.95)).toBeLessThan(0.1);
    expect(reliabilityLowerBound({ alpha: 2, beta: 2 }, 0.95)).toBeLessThan(0.2);
  });

  it("throws TypeError for credibleLevel outside (0.5, 1)", () => {
    expect(() => reliabilityLowerBound({ alpha: 2, beta: 2 }, 0.5)).toThrow(TypeError);
    expect(() => reliabilityLowerBound({ alpha: 2, beta: 2 }, 1)).toThrow(TypeError);
    expect(() => reliabilityLowerBound({ alpha: 2, beta: 2 }, NaN)).toThrow(TypeError);
    expect(() => reliabilityLowerBound({ alpha: 2, beta: 2 }, 0.4)).toThrow(TypeError);
    expect(() => reliabilityLowerBound({ alpha: 2, beta: 2 }, 1.2)).toThrow(TypeError);
  });

  it("throws TypeError on invalid posteriors", () => {
    expect(() => reliabilityLowerBound({ alpha: 0, beta: 1 }, 0.95)).toThrow(TypeError);
    expect(() => reliabilityLowerBound({ alpha: 1, beta: NaN }, 0.95)).toThrow(TypeError);
  });
});

describe("shrinkToward", () => {
  it("factor 1 keeps the posterior; factor 0 fully resets to the cohort prior", () => {
    expect(shrinkToward({ alpha: 10, beta: 4 }, { alpha: 2, beta: 2 }, 1)).toEqual({
      alpha: 10,
      beta: 4,
    });
    expect(shrinkToward({ alpha: 10, beta: 4 }, { alpha: 2, beta: 2 }, 0)).toEqual({
      alpha: 2,
      beta: 2,
    });
  });

  it("interpolates componentwise toward the cohort prior", () => {
    expect(shrinkToward({ alpha: 10, beta: 4 }, { alpha: 2, beta: 2 }, 0.5)).toEqual({
      alpha: 6,
      beta: 3,
    });
  });

  it("keeps components strictly positive", () => {
    const result = shrinkToward({ alpha: 0.001, beta: 0.001 }, { alpha: 2, beta: 2 }, 0.999);
    expect(result.alpha).toBeGreaterThan(0);
    expect(result.beta).toBeGreaterThan(0);
  });

  it("throws TypeError on invalid factor or posteriors", () => {
    expect(() => shrinkToward({ alpha: 1, beta: 1 }, { alpha: 2, beta: 2 }, -0.1)).toThrow(
      TypeError
    );
    expect(() => shrinkToward({ alpha: 1, beta: 1 }, { alpha: 2, beta: 2 }, 1.1)).toThrow(
      TypeError
    );
    expect(() => shrinkToward({ alpha: 1, beta: 1 }, { alpha: 2, beta: 2 }, NaN)).toThrow(
      TypeError
    );
    expect(() => shrinkToward({ alpha: 0, beta: 1 }, { alpha: 2, beta: 2 }, 0.5)).toThrow(
      TypeError
    );
    expect(() => shrinkToward({ alpha: 1, beta: 1 }, { alpha: 2, beta: 0 }, 0.5)).toThrow(
      TypeError
    );
  });
});

describe("confidenceEnum", () => {
  it.each([
    { score: 1, expected: "observed" },
    { score: 0.75, expected: "observed" },
    { score: 0.74, expected: "likely" },
    { score: 0.5, expected: "likely" },
    { score: 0.49, expected: "possible" },
    { score: 0.25, expected: "possible" },
    { score: 0.24, expected: "unknown" },
    { score: 0, expected: "unknown" },
  ] as const)("maps $score to $expected", ({ score, expected }) => {
    expect(confidenceEnum(score)).toBe(expected);
  });
});
