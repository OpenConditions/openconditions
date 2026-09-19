import type {
  DirectionRef,
  Effect,
  Issue,
  Validity,
  VehicleApplicability,
  VehicleSelector,
} from "@openconditions/model";
import type {
  RestrictionIssue,
  RoadRestrictionDetailsV1,
  RoadRestrictionFact,
} from "./restriction-types.js";

/**
 * The effect a restricted record imposes on the vehicles its facts select —
 * what the record's nature says it does (a closure, an access ban). The
 * situation parser derives it from the situation type; the restriction facts
 * only narrow who it applies to.
 */
export type BaseEffect =
  | { kind: "closure"; scope: "road" | "carriageway" | "ramp" | "bridge" | "tunnel" }
  | { kind: "access"; mode: "prohibited" | "local_access_only" | "permit_only" };

export interface PlacedEffect {
  /** null = the situation's own effects; else the roadworks phase the effect belongs to. */
  phaseId: string | null;
  effect: Effect;
}

const ACTION_STATUS: Record<string, NonNullable<Effect["actionStatus"]>> = {
  requested: "requested",
  approved: "approved",
  beingImplemented: "being_implemented",
  implemented: "implemented",
  rejected: "rejected",
  terminationRequested: "termination_requested",
  beingTerminated: "being_terminated",
};

type Scope = RoadRestrictionFact["scope"];

function scopeKey(scope: Scope): string {
  return `${scope.kind}|${scope.phaseId ?? ""}`;
}

function direction(fact: RoadRestrictionFact): DirectionRef {
  return {
    value: fact.direction.value,
    basis: fact.direction.basis,
    ...(fact.direction.description !== null ? { text: fact.direction.description } : {}),
  };
}

function validity(fact: RoadRestrictionFact): Validity {
  const status =
    fact.context.validityStatus === "active"
      ? "active"
      : fact.context.validityStatus === "suspended"
        ? "suspended"
        : "unknown";
  return {
    status,
    ...(fact.validFrom !== null ? { start: fact.validFrom } : {}),
    ...(fact.validTo !== null ? { end: fact.validTo } : {}),
    ...(fact.schedule !== undefined && fact.schedule.length > 0
      ? { periods: fact.schedule as Validity["periods"] }
      : {}),
  };
}

function issueOf(issue: RestrictionIssue): Issue {
  return {
    code: issue.code,
    sourcePath: issue.sourcePath,
    ...(issue.sourceText !== undefined ? { sourceText: issue.sourceText } : {}),
    ...(issue.sourceTokens !== undefined ? { sourceTokens: issue.sourceTokens } : {}),
    ...(issue.truncated ? { truncated: true as const } : {}),
  };
}

/** One selector holding every event_applies_when condition of a scope (AND). */
function selectorOf(facts: RoadRestrictionFact[]): VehicleSelector {
  const selector: VehicleSelector = {};
  for (const fact of facts) {
    if (fact.kind === "vehicle_class") selector.class = fact.value;
    else if (fact.kind === "vehicle_usage") selector.usage = fact.value;
    else {
      selector.when = [
        ...(selector.when ?? []),
        {
          dimension: fact.dimension,
          operator: fact.operator,
          value: { value: fact.value, unit: fact.unit },
        },
      ];
    }
  }
  return selector;
}

/**
 * Maps a restriction-contract envelope onto kernel effects, one scope
 * (event road, roadworks phase, detour) at a time:
 *
 * - `event_applies_when` facts become the applicability of the record's base
 *   effect: all conditions of a scope in one selector (DATEX
 *   `forVehiclesWithCharacteristicsOf` group semantics; compound groups are
 *   already flagged `compound_condition` by the parser).
 * - `maximum_permitted` dimension facts become `dimension_limit` effects;
 *   a comparator other than lt/lte cannot be a maximum and becomes an
 *   `unsupported` effect.
 * - An envelope with no usable fact (vehicleScope "unknown") becomes one
 *   `unsupported` effect carrying the issues — presence is evidence.
 *
 * Fact-level issues stay with the fact's effect; record-level issues
 * (`factId: null`) and `completeness: "partial"` make every effect `partial`.
 * Effect ids are `<recordId>/<kind>[:<n>]`, numbered per kind in
 * source order only when the record yields several of that kind.
 */
export function restrictionEffects(
  details: RoadRestrictionDetailsV1,
  base: BaseEffect,
): PlacedEffect[] {
  const recordId = details.source.recordId;
  const recordIssues = details.issues.filter((i) => i.factId === null).map(issueOf);
  const partial = details.completeness === "partial";
  const drafts: { phaseId: string | null; fields: Record<string, unknown>; kind: string }[] = [];

  const common = (fact: RoadRestrictionFact, factIssues: Issue[]) => {
    const issues = [...factIssues, ...recordIssues];
    const actionStatus =
      fact.context.operatorActionStatus === null
        ? undefined
        : ACTION_STATUS[fact.context.operatorActionStatus];
    return {
      direction: direction(fact),
      validity: validity(fact),
      compliance: fact.context.compliance,
      normalization: partial || issues.length > 0 ? "partial" : "complete",
      ...(actionStatus !== undefined ? { actionStatus } : {}),
      ...(issues.length > 0 ? { issues } : {}),
      ...(fact.scope.locationDescription !== null
        ? { location: { areaDescription: [{ lang: "und", text: fact.scope.locationDescription }] } }
        : {}),
      source: {
        path: String(fact.sourceTokens["sourcePath"] ?? fact.id),
        tokens: { ...fact.sourceTokens, locationRefs: fact.scope.sourceLocationRefs },
      },
    };
  };
  const issuesOfFact = (fact: RoadRestrictionFact) =>
    details.issues.filter((i) => i.factId === fact.id).map(issueOf);

  const scopes = new Map<string, RoadRestrictionFact[]>();
  for (const fact of details.facts) {
    const key = scopeKey(fact.scope);
    scopes.set(key, [...(scopes.get(key) ?? []), fact]);
  }

  for (const facts of scopes.values()) {
    const phaseId = facts[0]!.scope.phaseId;
    const conditions = facts.filter((f) => f.meaning === "event_applies_when");
    if (conditions.length > 0) {
      const applicability: VehicleApplicability = {
        kind: "classes",
        include: [selectorOf(conditions)],
      };
      drafts.push({
        phaseId,
        kind: base.kind,
        fields: {
          ...base,
          applicability,
          ...common(conditions[0]!, conditions.flatMap(issuesOfFact)),
        },
      });
    }
    for (const fact of facts) {
      if (fact.meaning !== "maximum_permitted" || fact.kind !== "dimension") continue;
      const all: VehicleApplicability = { kind: "all" };
      if (fact.operator === "lt" || fact.operator === "lte") {
        drafts.push({
          phaseId,
          kind: "dimension_limit",
          fields: {
            kind: "dimension_limit",
            dimension: fact.dimension,
            value: { value: fact.value, unit: fact.unit },
            operator: fact.operator,
            meaning: "maximum_permitted",
            applicability: all,
            ...common(fact, issuesOfFact(fact)),
          },
        });
      } else {
        const issue: Issue = {
          code: "unsupported_operator",
          sourcePath: String(fact.sourceTokens["sourcePath"] ?? fact.id),
          sourceText: fact.operator,
        };
        drafts.push({
          phaseId,
          kind: "unsupported",
          fields: {
            kind: "unsupported",
            applicability: all,
            ...common(fact, [issue, ...issuesOfFact(fact)]),
            normalization: "unsupported",
          },
        });
      }
    }
  }

  if (drafts.length === 0) {
    const issues = details.issues.map(issueOf);
    drafts.push({
      phaseId: null,
      kind: "unsupported",
      fields: {
        kind: "unsupported",
        applicability: { kind: "unknown" },
        compliance: "unknown",
        normalization: "unsupported",
        ...(issues.length > 0
          ? { issues }
          : { issues: [{ code: "unsupported_type", sourcePath: "restrictionDetails" }] }),
        source: { path: "restrictionDetails" },
      },
    });
  }

  const perKind = new Map<string, number>();
  for (const d of drafts) perKind.set(d.kind, (perKind.get(d.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  return drafts.map((d) => {
    const n = (seen.get(d.kind) ?? 0) + 1;
    seen.set(d.kind, n);
    const id = perKind.get(d.kind)! > 1 ? `${recordId}/${d.kind}:${n}` : `${recordId}/${d.kind}`;
    return { phaseId: d.phaseId, effect: { id, v: 1, ...d.fields } as Effect };
  });
}
