/**
 * Aggregator-topology guard. A two-share VDAF only protects a contributor if the
 * Leader and the Helper are run by INDEPENDENT operators — a single operator that
 * holds both shares can reconstruct every measurement. A same-operator Helper is
 * therefore legitimate ONLY for tests/staging; it must be impossible to enable
 * production publication with that topology, so this guard fails closed.
 */

export interface AggregatorEndpoint {
  /** Stable operator identity (org id / domain). */
  operatorId: string;
  /** Aggregator base URL. */
  endpoint: string;
  /** HPKE config / key id the aggregator publishes, if pinned. */
  hpkeConfigId?: string;
}

export interface AggregatorTopology {
  /** "production" is the only environment the guard refuses to compromise. */
  environment: "production" | "staging" | "test";
  leader: AggregatorEndpoint;
  helper: AggregatorEndpoint;
}

export class SameOperatorHelperError extends Error {
  constructor(reason: string) {
    super(`refusing production publication with a same-operator Helper: ${reason}`);
    this.name = "SameOperatorHelperError";
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

/** True when Leader and Helper are plausibly the same operator. */
export function isSameOperator(topology: AggregatorTopology): boolean {
  const { leader, helper } = topology;
  if (normalize(leader.operatorId) === normalize(helper.operatorId)) return true;
  if (normalize(leader.endpoint) === normalize(helper.endpoint)) return true;
  if (
    leader.hpkeConfigId !== undefined &&
    helper.hpkeConfigId !== undefined &&
    normalize(leader.hpkeConfigId) === normalize(helper.hpkeConfigId)
  ) {
    return true;
  }
  return false;
}

/**
 * Throws in a PRODUCTION topology whose Leader and Helper share an operator id,
 * an endpoint, or an HPKE key. Non-production environments may use a
 * same-operator Helper (that is the whole point of the test wiring), so the
 * guard is a no-op there.
 */
export function assertHelperIndependentForProduction(topology: AggregatorTopology): void {
  if (topology.environment !== "production") return;
  const { leader, helper } = topology;
  if (normalize(leader.operatorId) === normalize(helper.operatorId)) {
    throw new SameOperatorHelperError(`Leader and Helper share operator id "${leader.operatorId}"`);
  }
  if (normalize(leader.endpoint) === normalize(helper.endpoint)) {
    throw new SameOperatorHelperError(`Leader and Helper share endpoint "${leader.endpoint}"`);
  }
  if (
    leader.hpkeConfigId !== undefined &&
    helper.hpkeConfigId !== undefined &&
    normalize(leader.hpkeConfigId) === normalize(helper.hpkeConfigId)
  ) {
    throw new SameOperatorHelperError("Leader and Helper share an HPKE config id");
  }
}
