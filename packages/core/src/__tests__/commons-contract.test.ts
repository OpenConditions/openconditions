import { describe, expect, it } from "vitest";
import {
  canonicalId,
  canonicalIdentityParts,
  normalizeNamespace,
  phenomenonFingerprint,
  centroid,
  gridCell,
  truncateType,
  timeBucket,
  evaluateEvidence,
  updateReliability,
  reliabilityLowerBound,
  shrinkToward,
  confidenceEnum,
  OBSERVED_PROPERTIES,
  validateObserved,
  observedKey,
  type CanonicalIdentityParts,
  type EvidenceLedger,
  type EvidencePolicy,
  type BetaPosterior,
  type ConditionEvent,
  type Observation,
} from "../index.js";

/**
 * Pins the commons substrate's PUBLIC contract: every export a downstream
 * consumer (crowd reporting, federation, publishing emitters, probe
 * aggregation) will import from "@openconditions/core" is exercised here via
 * the package's barrel entry point ("../index.js"), not a relative module
 * path. Every other test in this directory imports straight from the source
 * module and exercises full behaviour; this file only pins that the barrel
 * still re-exports each name with a working one-line smoke call, so an
 * accidental drop from `src/index.ts` or a signature change breaks here
 * first, not in a downstream package.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const GRID_CELL_FORMAT = /^-?\d+:-?\d+$/;

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "situation-123",
    source: "ndw",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    geometry: { type: "Point", coordinates: [6.5, 52.0] },
    status: "active",
    origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-07-10T12:00:00Z",
    fetchedAt: "2026-07-10T12:01:00Z",
    isStale: false,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ConditionEvent> = {}): ConditionEvent {
  return {
    ...makeObservation(),
    kind: "event",
    type: "accident",
    category: "incident",
    severity: "high",
    severitySource: "declared",
    headline: "Accident on the ring road",
    validFrom: "2026-07-10T12:00:00Z",
    ...overrides,
  } as ConditionEvent;
}

describe("commons substrate public contract (packages/core barrel)", () => {
  it("canonical.ts identity functions are reachable and consistent", () => {
    const obs = makeObservation({ source: "ndw", id: "situation-123" });

    const id = canonicalId(obs);
    expect(id).toMatch(HEX64);

    const parts: CanonicalIdentityParts = canonicalIdentityParts(obs);
    expect(parts).toEqual({ namespace: "ndw", recordId: "situation-123" });
    expect(canonicalId(parts)).toBe(id);

    expect(normalizeNamespace(" NDW ")).toBe("ndw");
  });

  it("canonical.ts geometry/type/time helpers are reachable", () => {
    expect(centroid({ type: "Point", coordinates: [6.5, 52.0] })).toEqual([6.5, 52.0]);
    expect(gridCell([6.5, 52.0], 100)).toMatch(GRID_CELL_FORMAT);
    expect(truncateType("roads", "accident", 2)).toEqual(["roads", "accident"]);
    expect(Number.isInteger(timeBucket("2026-07-10T12:00:00Z", 300))).toBe(true);
  });

  it("canonical.ts phenomenonFingerprint is reachable (events only)", () => {
    expect(phenomenonFingerprint(makeEvent())).toMatch(HEX64);
  });

  it("evidence.ts evaluateEvidence + confidenceEnum are reachable", () => {
    const ledger: EvidenceLedger = {
      entries: [{ id: "e1", at: "2026-07-01T10:00:00.000Z", kind: "report", reporterKey: "k1" }],
      now: "2026-07-01T10:01:00.000Z",
    };
    const policy: EvidencePolicy = {
      policyVersion: "v1",
      corroborationMinDistinctKeys: 2,
      peerNegationMinKeys: 2,
      ttlSec: 900,
      maxLifetimeSec: 7200,
      scoreByState: {
        self_reported: 0.3,
        corroborated: 0.6,
        externally_resolved: 0.9,
        negated: 0,
        expired: 0,
      },
      reliabilityWeight: 0.1,
    };
    const result = evaluateEvidence(ledger, policy);
    expect(result.state).toBe("self_reported");
    expect(["observed", "likely", "possible", "unknown"]).toContain(
      confidenceEnum(result.confidenceScore)
    );
  });

  it("evidence.ts reliability posterior functions are reachable", () => {
    const prior: BetaPosterior = { alpha: 1, beta: 1 };
    const updated = updateReliability(prior, "confirmed");
    expect(updated).toEqual({ alpha: 2, beta: 1 });
    expect(reliabilityLowerBound(updated, 0.8)).toBeGreaterThan(0);
    expect(shrinkToward(updated, prior, 0.5)).toEqual({ alpha: 1.5, beta: 1 });
  });

  it("observed-properties.ts registry + soft validation are reachable", () => {
    expect(OBSERVED_PROPERTIES["roads/accident"]).toBeDefined();
    expect(observedKey(makeEvent({ type: "accident" }))).toBe("roads/accident");

    const { warnings } = validateObserved(makeEvent({ type: "not_a_real_type" }));
    expect(warnings).toEqual([expect.stringContaining("unregistered observed property")]);
  });
});
