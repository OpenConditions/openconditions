import type { RecordDraft } from "@openconditions/ingest-framework";
import {
  type Effect,
  isRestrictionEvidence,
  isVehicleSpecific,
  situationEffects,
} from "@openconditions/model";

/** What the vehicle-specific effects of a set of situations say, as bounded counts. */
export interface RestrictionTally {
  /** Situations carrying at least one vehicle-specific effect. */
  situations: number;
  effects: number;
  /**
   * Per condition: `dimension:unit` for a dimension limit or a dimension the
   * applicability tests, `vehicle_class:…` and `vehicle_usage:…` for the
   * vehicles it names. Absence of a key is "not observed".
   */
  kinds: Record<string, number>;
  /** Per applicability kind (all, classes, unknown). */
  applicability: Record<string, number>;
  issues: Record<string, number>;
  /** Effects the parser recognised but could not type. */
  unsupported: number;
  /** Effects that are restriction evidence: listed for routing, never routed. */
  evidence: number;
}

function tally(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

/** Counts the vehicle-specific effects of `situations`. */
export function tallyRestrictions(situations: readonly RecordDraft[]): RestrictionTally {
  const out: RestrictionTally = {
    situations: 0,
    effects: 0,
    kinds: {},
    applicability: {},
    issues: {},
    unsupported: 0,
    evidence: 0,
  };
  for (const situation of situations) {
    const restrictions = situationEffects(situation).filter(isVehicleSpecific);
    if (restrictions.length > 0) out.situations++;
    for (const effect of restrictions) {
      out.effects++;
      const e = effect as Effect & Record<string, unknown>;
      if (effect.kind === "unsupported") out.unsupported++;
      if (effect.kind === "dimension_limit") {
        tally(out.kinds, `${String(e["dimension"])}:${(e["value"] as { unit: string }).unit}`);
      }
      for (const selector of effect.applicability.include ?? []) {
        if (selector.class) tally(out.kinds, `vehicle_class:${selector.class}`);
        if (selector.usage) tally(out.kinds, `vehicle_usage:${selector.usage}`);
        for (const when of selector.when ?? []) {
          tally(out.kinds, `${when.dimension}:${when.value.unit}`);
        }
      }
      tally(out.applicability, effect.applicability.kind);
      for (const issue of effect.issues ?? []) tally(out.issues, issue.code);
      if (isRestrictionEvidence(effect)) out.evidence++;
    }
  }
  return out;
}
