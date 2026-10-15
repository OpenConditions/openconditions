import {
  type Effect,
  isRestrictionEvidence,
  isVehicleSpecific,
  situationEffects,
} from "@openconditions/model";

type Rec = Record<string, unknown>;
export interface ExportDiagnostic {
  situationId: string;
  code:
    | "coarse_location"
    | "vehicle_specific_effect"
    | "restriction_evidence"
    | "unrepresentable_direction"
    | "direction_not_exported"
    | "geometry_to_endpoints"
    | "geometry_to_point"
    | "missing_geometry"
    | "unsupported_nature"
    | "unsupported_effect"
    | "effect_ended"
    | "effect_time_unknown"
    | "field_not_exported";
  /** Scope of the decision: entire situation, individual message, effect or field. */
  scope: "situation" | "message" | "effect" | "field";
  disposition: "withheld" | "omitted" | "reduced";
  /** RFC 6901 JSON pointer into the canonical situation. */
  path: string;
  effectId?: string;
  message: string;
}
export type ExportDiagnosticSink = (diagnostic: ExportDiagnostic) => void;

/** Optional observations from the emitter itself, never a second projection. */
export class ProjectionDiagnostics {
  constructor(
    readonly situation: Rec,
    private readonly sink?: ExportDiagnosticSink,
  ) {}

  private paths: Map<Effect, string> | undefined;

  effectPath(effect: Effect): string {
    if (!this.sink) return "";
    if (!this.paths) {
      this.paths = new Map();
      for (const [i, e] of ((this.situation["effects"] as Effect[] | undefined) ?? []).entries()) {
        this.paths.set(e, `/effects/${i}`);
      }
      const details = this.situation["details"] as
        | { phases?: { effects?: Effect[] }[] }
        | undefined;
      for (const [p, phase] of (details?.phases ?? []).entries()) {
        for (const [i, e] of (phase.effects ?? []).entries())
          this.paths.set(e, `/details/phases/${p}/effects/${i}`);
      }
    }
    const path = this.paths.get(effect);
    if (path === undefined)
      throw new Error("export diagnostic effect is not part of the situation");
    return path;
  }

  emit(
    code: ExportDiagnostic["code"],
    scope: ExportDiagnostic["scope"],
    disposition: ExportDiagnostic["disposition"],
    path: string,
    message: string,
    effect?: Effect,
  ): void {
    this.sink?.({
      situationId: String(this.situation["id"]),
      code,
      scope,
      disposition,
      path,
      ...(effect ? { effectId: effect.id } : {}),
      message,
    });
  }

  /** Shared whole-situation gates. Even an ended effect can trigger these:
   * that is the exporters' existing conservative policy, before time filtering. */
  blocked(format: "traff" | "datex"): boolean {
    let blocked = false;
    const coarse = (location: Rec | undefined, path: string, effect?: Effect) => {
      if (location?.["fuzziness"] !== undefined && location["fuzziness"] !== "exact") {
        blocked = true;
        this.emit(
          "coarse_location",
          "situation",
          "withheld",
          `${path}/fuzziness`,
          "The whole situation is withheld: this XML projection cannot carry location uncertainty.",
          effect,
        );
      }
    };
    coarse(this.situation["location"] as Rec | undefined, "/location");
    for (const effect of situationEffects(this.situation)) {
      const path = this.effectPath(effect);
      coarse(effect.location as Rec | undefined, `${path}/location`, effect);
      if (isVehicleSpecific(effect)) {
        blocked = true;
        this.emit(
          "vehicle_specific_effect",
          "situation",
          "withheld",
          `${path}/${effect.applicability.kind === "all" ? "kind" : "applicability"}`,
          "The whole situation is withheld: vehicle conditions cannot be represented faithfully.",
          effect,
        );
      }
      if (isRestrictionEvidence(effect)) {
        blocked = true;
        this.emit(
          "restriction_evidence",
          "situation",
          "withheld",
          `${path}/${effect.normalization !== "complete" ? "normalization" : "applicability"}`,
          "The whole situation is withheld: normalization is incomplete or applicability is unknown.",
          effect,
        );
      }
      if (format === "traff") {
        for (const [direction, field] of [
          [effect.direction, "direction"],
          [effect.location?.direction, "location/direction"],
        ] as const) {
          if (direction !== undefined && direction.value !== "both") {
            blocked = true;
            this.emit(
              "unrepresentable_direction",
              "situation",
              "withheld",
              `${path}/${field}`,
              "The whole situation is withheld: TraFF travel order cannot be inferred from this direction.",
              effect,
            );
          }
        }
      }
    }
    return blocked;
  }
}
