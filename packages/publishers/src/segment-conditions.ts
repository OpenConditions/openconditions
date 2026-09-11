import type { LineString } from "geojson";
import {
  isInEffectAt,
  nextScheduleTransition,
  routingEvidenceReasons,
  type RoadConditionRoutingEvidence,
  type RoutingRights,
  type Schedule,
} from "@openconditions/core";
import { normalizeVehicleApplicability } from "@openconditions/roads";

/**
 * One bound road event as it comes back from the `/segments/conditions.json`
 * query: the observation's routing-relevant columns, its binding summary, and
 * the ordered directed spans it occupies. Column names are the raw snake_case
 * ones the SQL selects (only the span fields are aliased to camelCase, because
 * they are built by `jsonb_build_object`), and every timestamp arrives as the
 * driver's `Date` unless the query already coerced it to a string.
 *
 * `geometry` is the occupied part of the directed segment in travel direction,
 * and is `null` when the span's segment no longer exists in `road_segment` —
 * the binding tables carry no FK to the spine, so a rebuilt spine can drop a
 * segment out from under a still-valid binding.
 */
export interface SegmentConditionRow {
  id: string;
  /** Original independently polled source identity retained on the event row. */
  source: string;
  /** Parent policy/licensing identity used in evidence, when source is a catalogue child. */
  routing_source_id?: string;
  type: string | null;
  severity: string | null;
  attributes: Record<string, unknown> | null;
  origin: { kind: string; attribution?: unknown };
  routing_eligible: boolean | null;
  valid_from: string | Date | null;
  valid_to: string | Date | null;
  schedule: unknown;
  source_license: string | null;
  observation_revision: string | null;
  binding_revision: string | null;
  graph_generation: string | null;
  child_source_id: string | null;
  source_uri: string | null;
  source_checked_at: string | Date | null;
  fresh_until: string | Date | null;
  expires_at: string | Date | null;
  license_url: string | null;
  attribution: string | null;
  rights: RoutingRights | null;
  binding_status: string;
  binding_resolver_version: string;
  binding_confidence: number | null;
  binding_direction_mode: string;
  segments: Array<{
    segmentId: string;
    wayId: number;
    dir: "f" | "b";
    startFraction: number;
    endFraction: number;
    geometry: LineString | null;
  }>;
}

/** One emitted condition: snake_case, flat, and keyed by directed way spans. */
export interface SegmentConditionJson {
  id: string;
  source: string;
  type: string | null;
  severity: string | null;
  road_state: string | null;
  speed_limit_kph: number | null;
  vehicles_affected: string[];
  origin_kind: string;
  routing_eligible: boolean;
  valid_from: string | null;
  valid_to: string | null;
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

function iso(v: string | Date | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Projects bound, in-effect observations to the routing-consumer JSON. The
 * `at` filter runs here rather than in SQL because the `validFrom`/`validTo`
 * span and the schema.org `schedule` intersect: SQL can cheaply exclude
 * expired rows, but only `isInEffectAt` can tell whether a nightly closure is
 * actually closed right now.
 *
 * `routing_eligible` is honoured verbatim for crowd rows (an unconfirmed
 * report must not steer a route) and forced to `true` for every other origin —
 * a feed row's own column defaults to `false` in the schema and would
 * otherwise silently suppress the whole authoritative feed.
 */
export function segmentConditionsToJson(
  rows: SegmentConditionRow[],
  at: Date,
  info: { resolverVersion: string; evaluatedAt?: Date }
): {
  schema_version: 1;
  complete: true;
  generated_at: string;
  at: string;
  resolver_version: string;
  conditions: SegmentConditionJson[];
} {
  const conditions: SegmentConditionJson[] = [];
  const evaluatedAt = info.evaluatedAt ?? at;
  for (const r of rows) {
    const validFrom = iso(r.valid_from);
    const validTo = iso(r.valid_to);
    const schedule = Array.isArray(r.schedule) ? (r.schedule as Schedule[]) : undefined;
    if (!isInEffectAt({ validFrom, validTo, ...(schedule ? { schedule } : {}) }, at)) continue;
    const a = r.attributes ?? {};
    const speed = Number(a["speedLimitKph"]);
    const vehicles = Array.isArray(a["vehiclesAffected"])
      ? (a["vehiclesAffected"] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const nextTransition =
      schedule && schedule.length > 0 ? nextScheduleTransition(schedule, at) : null;
    if (
      !r.observation_revision ||
      !r.binding_revision ||
      !r.graph_generation ||
      !r.source_checked_at ||
      !r.fresh_until ||
      !r.source_license ||
      !r.rights ||
      r.binding_resolver_version !== info.resolverVersion ||
      r.segments.length === 0 ||
      r.segments.some((span) => !span.segmentId || span.geometry == null) ||
      (schedule && schedule.length > 0 && !nextTransition)
    ) {
      continue;
    }
    if (r.origin.kind === "crowd" && r.routing_eligible !== true) continue;
    const dirs = new Set(r.segments.map((span) => span.dir));
    const directionMode: RoadConditionRoutingEvidence["direction_mode"] =
      dirs.size > 1 ? "both" : dirs.has("f") ? "forward" : dirs.has("b") ? "reverse" : "unknown";
    const evidence: RoadConditionRoutingEvidence = {
      schema_version: 1,
      observation_revision: r.observation_revision,
      binding_revision: r.binding_revision,
      graph_generation: r.graph_generation,
      resolver_version: r.binding_resolver_version,
      source_id: r.routing_source_id ?? r.source,
      child_source_id: r.child_source_id,
      source_license: r.source_license,
      license_url: r.license_url,
      attribution: r.attribution,
      record_url: r.source_uri,
      source_checked_at: iso(r.source_checked_at)!,
      fresh_until: iso(r.fresh_until)!,
      expires_at: iso(r.expires_at),
      valid_from: validFrom,
      valid_to: validTo,
      next_transition_at: nextTransition,
      direction_mode: directionMode,
      applicability: normalizeVehicleApplicability(
        vehicles.length > 0 ? vehicles : undefined,
        Array.isArray(a["restrictions"])
          ? (a["restrictions"] as Array<{
              type: string;
              value?: number;
              unit?: string;
              operator?: string;
              raw?: Record<string, unknown>;
            }>)
          : undefined
      ),
      rights: r.rights,
      segments: r.segments.map((span) => ({
        segment_id: span.segmentId,
        direction: span.dir === "f" ? "forward" : "reverse",
        from_fraction: span.startFraction,
        to_fraction: span.endFraction,
      })),
      binding_status: r.binding_status as RoadConditionRoutingEvidence["binding_status"],
      reason_codes: [],
      evaluated_at: evaluatedAt.toISOString(),
    };
    if (routingEvidenceReasons(evidence, evaluatedAt).length > 0) continue;
    conditions.push({
      id: r.id,
      source: r.source,
      type: r.type,
      severity: r.severity,
      road_state: typeof a["roadState"] === "string" ? (a["roadState"] as string) : null,
      speed_limit_kph: Number.isFinite(speed) && speed > 0 ? speed : null,
      vehicles_affected: vehicles,
      origin_kind: r.origin.kind,
      routing_eligible: r.origin.kind === "crowd" ? r.routing_eligible === true : true,
      valid_from: validFrom,
      valid_to: validTo,
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
    schema_version: 1,
    complete: true,
    generated_at: new Date().toISOString(),
    at: at.toISOString(),
    resolver_version: info.resolverVersion,
    conditions,
  };
}
