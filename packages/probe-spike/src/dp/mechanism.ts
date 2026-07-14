/**
 * The `DpMechanism` boundary. The ACTUAL differential-privacy primitives — noise
 * sampling, sensitivity/validity calculation, and the (ε,δ)/RDP/zCDP accounting
 * curve — live BEHIND this interface. Production wires a maintained,
 * out-of-process library (e.g. Google's `differential-privacy` binary or
 * OpenDP); there is no maintained in-process JS DP primitive and this spike
 * hand-rolls none. The interface owns the privacy math; the glue in this package
 * owns everything else (clamping, contribution bounding, partition scheduling,
 * per-unit budget, idempotent retry).
 *
 * For tests the spike supplies a RECORDING DOUBLE (`RecordingDpMechanism`): it
 * records the call sequence and parameters it receives and returns a
 * deterministic stand-in value. The point of the double is the CALL SEQUENCE and
 * PARAMETERS, never the value — the spike makes NO claim that any number it
 * produces is differentially private. That claim belongs to the real library and
 * the P0 reviewer.
 */

/** The privacy boundary. Production binds this to a real DP library. */
export interface DpMechanism {
  /**
   * Noisy sum over already-clamped values. The LIBRARY owns the sampling and the
   * sensitivity derived from `[lower, upper]`; the glue guarantees every value is
   * within `[lower, upper]` and one-per-privacy-unit before calling.
   */
  boundedSum(
    values: number[],
    lower: number,
    upper: number,
    epsilon: number
  ): { value: number; epsilonSpent: number };
  /**
   * Private partition selection: does this partition survive the DP threshold?
   * The library owns the thresholding mechanism; the glue never publishes or
   * divides by `rawCount`.
   */
  selectPartition(
    rawCount: number,
    epsilon: number,
    delta: number
  ): { released: boolean; epsilonSpent: number; deltaSpent: number };
}

/** A recorded `boundedSum` invocation, with the full (data-bearing) arguments. */
export interface BoundedSumCall {
  method: "boundedSum";
  values: number[];
  lower: number;
  upper: number;
  epsilon: number;
}

/** A recorded `selectPartition` invocation, with the full (data-bearing) arguments. */
export interface SelectPartitionCall {
  method: "selectPartition";
  rawCount: number;
  epsilon: number;
  delta: number;
}

export type MechanismCall = BoundedSumCall | SelectPartitionCall;

/**
 * The data-INDEPENDENT projection of a mechanism call: method name and the
 * privacy PARAMETERS (ε/δ/lower/upper) only. The data-bearing payload (`values`,
 * `rawCount`) is dropped. Two neighboring datasets (differing by one device-key
 * epoch) must yield byte-identical control projections — that is the grey-box
 * audit's equality check for mechanism parameters.
 */
export type MechanismControlProjection =
  | { method: "boundedSum"; lower: number; upper: number; epsilon: number }
  | { method: "selectPartition"; epsilon: number; delta: number };

export function controlProjection(call: MechanismCall): MechanismControlProjection {
  if (call.method === "boundedSum") {
    return { method: "boundedSum", lower: call.lower, upper: call.upper, epsilon: call.epsilon };
  }
  return { method: "selectPartition", epsilon: call.epsilon, delta: call.delta };
}

/**
 * Configuration for the recording double. `sumStandIn` and the partition
 * threshold are deterministic stand-ins for the library's noisy output — they are
 * NOT private and carry no DP meaning. `selectThreshold` decides `released` from
 * the RAW count purely so the glue's suppression path is exercisable; a real
 * library would threshold a NOISY count.
 */
export interface RecordingMechanismConfig {
  /** Deterministic stand-in value returned by every `boundedSum`. */
  sumStandIn?: number;
  /** A partition is "released" by the double iff `rawCount >= selectThreshold`. */
  selectThreshold?: number;
  /** Fixed ε reported as spent by each `boundedSum` (accounting is the library's). */
  epsilonSpentPerSum?: number;
  /** Fixed ε reported as spent by each `selectPartition`. */
  epsilonSpentPerSelect?: number;
  /** Fixed δ reported as spent by each `selectPartition`. */
  deltaSpentPerSelect?: number;
}

/**
 * Deterministic recording stand-in for a real `DpMechanism`. It samples NO noise
 * and computes NO privacy curve; it records every call and returns fixed values
 * so the GLUE can be audited. `calls` is the ordered call log; `controlTrace()`
 * is the data-independent projection the grey-box audit compares.
 */
export class RecordingDpMechanism implements DpMechanism {
  readonly calls: MechanismCall[] = [];
  private readonly sumStandIn: number;
  private readonly selectThreshold: number;
  private readonly epsilonSpentPerSum: number;
  private readonly epsilonSpentPerSelect: number;
  private readonly deltaSpentPerSelect: number;

  constructor(config: RecordingMechanismConfig = {}) {
    this.sumStandIn = config.sumStandIn ?? 42;
    this.selectThreshold = config.selectThreshold ?? 1;
    this.epsilonSpentPerSum = config.epsilonSpentPerSum ?? 0;
    this.epsilonSpentPerSelect = config.epsilonSpentPerSelect ?? 0;
    this.deltaSpentPerSelect = config.deltaSpentPerSelect ?? 0;
  }

  boundedSum(
    values: number[],
    lower: number,
    upper: number,
    epsilon: number
  ): { value: number; epsilonSpent: number } {
    this.calls.push({ method: "boundedSum", values: [...values], lower, upper, epsilon });
    return { value: this.sumStandIn, epsilonSpent: this.epsilonSpentPerSum };
  }

  selectPartition(
    rawCount: number,
    epsilon: number,
    delta: number
  ): { released: boolean; epsilonSpent: number; deltaSpent: number } {
    this.calls.push({ method: "selectPartition", rawCount, epsilon, delta });
    return {
      released: rawCount >= this.selectThreshold,
      epsilonSpent: this.epsilonSpentPerSelect,
      deltaSpent: this.deltaSpentPerSelect,
    };
  }

  /** The ordered, data-independent projection of every recorded call. */
  controlTrace(): MechanismControlProjection[] {
    return this.calls.map(controlProjection);
  }

  /** Count of `boundedSum` invocations (used to prove retry samples no fresh noise). */
  get boundedSumCount(): number {
    return this.calls.filter((c) => c.method === "boundedSum").length;
  }

  /** Count of `selectPartition` invocations (query count for the audit). */
  get selectPartitionCount(): number {
    return this.calls.filter((c) => c.method === "selectPartition").length;
  }
}
