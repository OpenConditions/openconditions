import type { Registry } from "../registry/build.js";

/** A crowd report's lifetime, quorums and matching rules, defaults applied. */
export interface ResolvedCrowdRules {
  ttlSec: number;
  maxLifetimeSec: number;
  corroborationKeys: number;
  negationKeys: number;
  /** Situations: the distance within which two records are one phenomenon. */
  matchMetres?: number;
  /** Observations: the tolerance within which two results agree; absent = equal. */
  tolerance?: number;
  /** Observations: how far from its subject a reporter may stand. */
  reachMetres?: number;
}

/** What a crowd report is about: a situation kind and type, or a property. */
export type CrowdTarget =
  | { class: "situation"; kind: string; type: string }
  | { class: "observation"; property: string };

const DEFAULT_MATCH_METRES = 250;
const DEFAULT_REACH_METRES = 300;

/**
 * The crowd rules of a situation kind (its type's lifetimes when the type has
 * its own) or a property; undefined when the crowd cannot report it.
 */
export function crowdRulesFor(
  registry: Registry,
  target: CrowdTarget,
): ResolvedCrowdRules | undefined {
  if (target.class === "observation") {
    const rules = registry.property(target.property)?.crowd;
    if (rules === undefined) return undefined;
    return {
      ttlSec: rules.ttlSec,
      maxLifetimeSec: rules.maxLifetimeSec,
      corroborationKeys: rules.corroborationKeys ?? 2,
      negationKeys: rules.negationKeys ?? 2,
      ...(rules.agreement === undefined ? {} : { tolerance: rules.agreement.tolerance }),
      reachMetres: rules.reachMetres ?? DEFAULT_REACH_METRES,
    };
  }
  const rules = registry.kind("situation", target.kind)?.crowd;
  if (rules === undefined) return undefined;
  const lifetime = rules.types?.[target.type] ?? rules;
  return {
    ttlSec: lifetime.ttlSec,
    maxLifetimeSec: lifetime.maxLifetimeSec,
    corroborationKeys: rules.corroborationKeys ?? 2,
    negationKeys: rules.negationKeys ?? 2,
    matchMetres: rules.matchMetres ?? DEFAULT_MATCH_METRES,
  };
}
