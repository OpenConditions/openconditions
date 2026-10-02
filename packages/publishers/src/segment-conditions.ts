import {
  type RoadConditionRoutingEvidence,
  routingEvidenceReasons,
  type SegmentConditionRow,
} from "@openconditions/core";
import { type Effect, effectStateAt, effectValidity, routingBlockers } from "@openconditions/model";
import type { LineString } from "geojson";

/**
 * One routable-or-evidence effect, flat and snake_case at the top, keyed by
 * directed way spans. `effect` is the model effect itself. A restriction
 * evidence effect carries reason codes in its routing evidence and never
 * routes; it is listed so a consumer knows the road is restricted.
 */
export interface SegmentConditionJson {
  /** `<situationId>#<effectId>`. */
  id: string;
  record_id: string;
  effect_id: string;
  source: string;
  kind: string;
  type: string;
  subtype: string | null;
  severity: string;
  effect: Effect;
  origin: string;
  evidence_state: string | null;
  routing_eligible: boolean;
  binding: { status: string; confidence: number | null; direction_mode: string };
  routing_evidence: RoadConditionRoutingEvidence;
  segments: Array<{
    way_id: number;
    dir: "f" | "b";
    start_fraction: number;
    end_fraction: number;
    geometry: LineString | null;
  }>;
}

export interface SegmentConditionsJson {
  schema_version: 2;
  complete: true;
  generated_at: string;
  at: string;
  resolver_version: string;
  conditions: SegmentConditionJson[];
}

function iso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** The only reason a listed restriction-evidence effect may carry: it reported why it does not apply. */
const EVIDENCE_ONLY = "evidence_reported_unapplied";

/**
 * Projects bound effects in effect at `at` to the routing-consumer JSON. An
 * effect is evaluated against its own validity, else its situation's
 * (`effectStateAt`), so a roadworks phase routes only during its phase. A
 * crowd effect routes only once evidence made its situation routing
 * eligible; a feed effect always may. Anything missing from the evidence
 * (binding currency, rights, freshness, spans) drops the effect: the feed
 * fails closed. A restriction-evidence effect is listed with its blockers as
 * reason codes.
 */
export function segmentConditionsToJson(
  rows: SegmentConditionRow[],
  at: Date,
  info: { resolverVersion: string; evaluatedAt?: Date },
): SegmentConditionsJson {
  const conditions: SegmentConditionJson[] = [];
  const evaluatedAt = info.evaluatedAt ?? at;
  for (const r of rows) {
    const { state, nextTransitionAt } = effectStateAt(r.effect, r.validity, at);
    if (state !== "active") continue;
    if (r.origin === "crowd" && r.routing_eligible !== true) continue;
    const license = r.provenance_attribution?.license;
    if (
      !r.source_checked_at ||
      !r.fresh_until ||
      !license ||
      !r.rights ||
      r.binding_resolver_version !== info.resolverVersion ||
      r.segments.length === 0 ||
      r.segments.some((span) => !span.segmentId || span.geometry == null)
    ) {
      continue;
    }
    const validity = effectValidity(r.effect, r.validity);
    const dirs = new Set(r.segments.map((span) => span.dir));
    const evidence: RoadConditionRoutingEvidence = {
      schema_version: 2,
      record_class: "situation",
      record_id: r.record_id,
      effect_id: r.effect_id,
      record_revision: r.record_revision,
      binding_revision: r.binding_revision,
      effect_kind: r.effect.kind,
      graph_generation: r.graph_generation,
      resolver_version: r.binding_resolver_version,
      source_id: r.routing_source_id ?? r.source_id,
      child_source_id: r.child_source_id ?? null,
      source_license: license,
      license_url: r.license_url ?? null,
      attribution: r.attribution ?? null,
      record_url: r.source_uri,
      source_checked_at: iso(r.source_checked_at)!,
      fresh_until: iso(r.fresh_until)!,
      expires_at: iso(r.expires_at),
      valid_from: validity.start ?? null,
      valid_to: validity.end ?? null,
      next_transition_at: nextTransitionAt,
      direction_mode:
        dirs.size > 1 ? "both" : dirs.has("f") ? "forward" : dirs.has("b") ? "reverse" : "unknown",
      applicability: r.effect.applicability,
      rights: r.rights,
      segments: r.segments.map((span) => ({
        segment_id: span.segmentId,
        direction: span.dir === "f" ? "forward" : "reverse",
        from_fraction: span.startFraction,
        to_fraction: span.endFraction,
      })),
      binding_status: r.binding_status as RoadConditionRoutingEvidence["binding_status"],
      reason_codes: routingBlockers(r.effect),
      evaluated_at: evaluatedAt.toISOString(),
    };
    const reasons = routingEvidenceReasons(evidence, evaluatedAt);
    const listable =
      evidence.reason_codes.length === 0
        ? reasons.length === 0
        : reasons.every(
            (reason) =>
              reason === EVIDENCE_ONLY || (evidence.reason_codes as string[]).includes(reason),
          );
    if (!listable) continue;
    conditions.push({
      id: `${r.record_id}#${r.effect_id}`,
      record_id: r.record_id,
      effect_id: r.effect_id,
      source: r.source_id,
      kind: r.kind,
      type: r.type,
      subtype: r.subtype,
      severity: r.severity,
      effect: r.effect,
      origin: r.origin,
      evidence_state: r.evidence_state,
      routing_eligible: r.origin === "crowd" ? r.routing_eligible === true : true,
      binding: {
        status: r.binding_status,
        confidence: r.binding_confidence,
        direction_mode: r.binding_direction_mode,
      },
      routing_evidence: evidence,
      segments: r.segments.map((s) => ({
        way_id: s.wayId,
        dir: s.dir,
        start_fraction: s.startFraction,
        end_fraction: s.endFraction,
        geometry: s.geometry ?? null,
      })),
    });
  }
  return {
    schema_version: 2,
    complete: true,
    generated_at: new Date().toISOString(),
    at: at.toISOString(),
    resolver_version: info.resolverVersion,
    conditions,
  };
}
