import type { DirectionRef, Effect, Issue, Validity } from "@openconditions/model";
import {
  type BaseEffect,
  type PlacedEffect,
  restrictionEffects,
  WZDX_LANE_TYPES,
  WZDX_UNITS,
  WZDX_VEHICLE_IMPACTS,
} from "@openconditions/model-roads";
import type { Restriction, RoadEvent } from "../model.js";
import { vehicleClassesOf } from "../routing.js";
import { localAccessExceptionOf } from "./local-access.js";
import { entryOf, text } from "./location.js";

type Applicability = Effect["applicability"];

/** Which vehicles the event's vehicle terms name. */
function vehicleApplicabilityOf(event: RoadEvent): Applicability {
  const raw = (event.vehiclesAffected ?? []).filter((v) => v.trim().length > 0);
  if (raw.length === 0) return { kind: "all" };
  const classes = vehicleClassesOf(raw);
  return classes === null
    ? { kind: "unknown", raw }
    : { kind: "classes", include: classes.map((c) => ({ class: c })), raw };
}

/**
 * Which vehicles the event's own effects apply to, from its vehicle terms and
 * the traffic its measure applies to. A measure for through traffic only
 * (DATEX `throughTraffic`, "traffic which is not for local access") spares
 * local access; one for any other kind of traffic (long-distance, holiday,
 * destined for the airport) applies to traffic no selector can name, so its
 * vehicles are unknown.
 */
export function applicabilityOf(event: RoadEvent): Applicability {
  const vehicles = vehicleApplicabilityOf(event);
  const traffic = event.situation?.trafficTypes;
  if (traffic === undefined || vehicles.kind === "unknown") return vehicles;
  const tokens = traffic.map((t) => `applicableForTrafficType:${t}`);
  if (traffic.some((t) => t !== "throughTraffic")) {
    return { kind: "unknown", raw: [...(vehicles.raw ?? []), ...tokens] };
  }
  return {
    ...vehicles,
    except: [...(vehicles.except ?? []), { usage: "local_access" }],
    raw: [...(vehicles.raw ?? []), ...tokens],
  };
}

/**
 * Which vehicles a closure of the event applies to: as its vehicle terms say,
 * but open to local access or residents when a closure of every vehicle is
 * excepted for them, in the source's words or by WZDx `local-access-only`.
 */
function closureApplicability(event: RoadEvent): Applicability {
  const applicability = applicabilityOf(event);
  if (applicability.kind !== "all" || applicability.except) return applicability;
  const stated = localAccessExceptionOf([
    event.headline,
    event.description,
    ...(event.situation?.headline ?? []).map((t) => t.text),
    ...(event.situation?.description ?? []).map((t) => t.text),
    ...(event.situation?.comments ?? []).flatMap((c) => c.text.map((t) => t.text)),
  ]);
  if (stated) return { kind: "all", except: [{ usage: stated.usage }], raw: [stated.phrase] };
  if (event.restrictions?.some((r) => r.type === "local-access-only"))
    return { kind: "all", except: [{ usage: "local_access" }], raw: ["local-access-only"] };
  return applicability;
}

const DIMENSIONS: Record<string, Extract<Effect, { kind: "dimension_limit" }>["dimension"]> = {
  height: "height",
  "reduced-height": "height",
  width: "width",
  "reduced-width": "width",
  length: "length",
  "reduced-length": "length",
  weight: "gross_weight",
  "reduced-weight": "gross_weight",
  "gross-weight-limit": "gross_weight",
  axle_load: "axle_load",
  "axle-load-limit": "axle_load",
};

/**
 * Source unit → [canonical unit, factor]. "tons" is ambiguous across sources
 * (short or metric) and not listed; a format that defines it says so in its
 * own table (WZDx: {@link WZDX_UNITS}).
 */
const UNITS: Readonly<Record<string, readonly [string, number]>> = {
  m: ["m", 1],
  meters: ["m", 1],
  metres: ["m", 1],
  cm: ["m", 0.01],
  centimeters: ["m", 0.01],
  ft: ["m", 0.3048],
  feet: ["m", 0.3048],
  in: ["m", 0.0254],
  inches: ["m", 0.0254],
  t: ["kg", 1000],
  tonnes: ["kg", 1000],
  kg: ["kg", 1],
  kilograms: ["kg", 1],
  lb: ["kg", 0.45359237],
  pounds: ["kg", 0.45359237],
};

/** Issue codes that leave an effect's time unknown rather than its content partial. */
const TEMPORAL_ISSUE_CODES = new Set([
  "invalid_window",
  "unsupported_schedule",
  "unsupported_status",
]);

/**
 * An access rule a restriction type names. `truck` limits it to trucks;
 * `hovMin` exempts vehicles carrying at least that many people, so WZDx
 * `hov-2` ("travel restricted to high occupancy vehicles of two or more") is
 * every other vehicle prohibited.
 */
const ACCESS: Record<string, { mode: string; truck?: true; hovMin?: number }> = {
  "no-trucks": { mode: "prohibited", truck: true },
  "hov-2": { mode: "prohibited", hovMin: 2 },
  "hov-3": { mode: "prohibited", hovMin: 3 },
  "local-access-only": { mode: "local_access_only" },
  "no-passing": { mode: "no_overtaking" },
  "towing-prohibited": { mode: "towing_prohibited" },
  "permitted-oversize-loads-prohibited": { mode: "oversize_prohibited" },
  "no-parking": { mode: "no_parking" },
};

interface Draft {
  kind: string;
  fields: Record<string, unknown>;
}

/**
 * A restriction from a parser that has not adopted the restriction contract.
 * It is display evidence, never routing authority: a dimension with a
 * convertible unit becomes a `dimension_limit`, a known access rule an
 * `access` effect, both `partial` because the source states no comparator;
 * anything else is an `unsupported` carrier. Presence is evidence, so nothing
 * is dropped.
 */
function legacyRestriction(
  r: Restriction,
  path: string,
  applicability: Applicability,
  units: Readonly<Record<string, readonly [string, number]>> = UNITS,
): Draft {
  const dimension = entryOf(DIMENSIONS, r.type.toLowerCase());
  const unit = entryOf(units, r.unit?.toLowerCase());
  const source = { path, tokens: { ...r } };
  if (dimension !== undefined && r.value !== undefined && unit !== undefined) {
    const canonical = dimension === "gross_weight" || dimension === "axle_load" ? "kg" : "m";
    if (unit[0] === canonical) {
      return {
        kind: "dimension_limit",
        fields: {
          dimension,
          value: { value: Math.round(r.value * unit[1] * 1000) / 1000, unit: canonical },
          operator: "lte",
          meaning: "maximum_permitted",
          applicability,
          compliance: "mandatory",
          normalization: "partial",
          issues: [{ code: "unsupported_operator", sourcePath: path }],
          source,
        },
      };
    }
  }
  const access = entryOf(ACCESS, r.type.toLowerCase());
  if (access !== undefined) {
    return {
      kind: "access",
      fields: {
        mode: access.mode,
        applicability: access.truck
          ? { kind: "classes", include: [{ class: "truck" }] }
          : access.hovMin !== undefined
            ? { kind: "all", except: [{ hovMin: access.hovMin }], raw: [r.type] }
            : applicability,
        compliance: "mandatory",
        normalization: "partial",
        issues: [{ code: "unsupported_type", sourcePath: path, sourceText: r.type }],
        source,
      },
    };
  }
  const code =
    dimension !== undefined && r.value !== undefined ? "unsupported_unit" : "unsupported_type";
  return {
    kind: "unsupported",
    fields: {
      applicability: { kind: "unknown", raw: [r.type] },
      compliance: "unknown",
      normalization: "unsupported",
      issues: [{ code, sourcePath: path, sourceText: r.unit ?? r.type }],
      source,
    },
  };
}

function laneImpact(event: RoadEvent): string {
  const lanes = event.lanesAffected!;
  const declared = entryOf(WZDX_VEHICLE_IMPACTS, lanes.vehicleImpact);
  if (declared !== undefined) return declared;
  if (event.roadState === "single_lane_alternating") return "alternating_one_way";
  if (lanes.total !== undefined && lanes.closed !== undefined) {
    if (lanes.closed >= lanes.total) return "all_lanes_closed";
    if (lanes.closed > 0) return "some_lanes_closed";
    return "all_lanes_open";
  }
  if (lanes.closed !== undefined && lanes.closed > 0) return "some_lanes_closed";
  return event.roadState === "some_lanes_closed" ? "some_lanes_closed" : "unknown";
}

/** A parser lane type as the kernel's; only WZDx lane types are mapped. */
const laneTypeOf = (event: RoadEvent, type: string | undefined) =>
  event.sourceFormat === "wzdx" ? entryOf(WZDX_LANE_TYPES, type) : undefined;

function lanesOf(event: RoadEvent): Record<string, unknown>[] | undefined {
  const lanes = event.lanesAffected?.lanes;
  if (!lanes || lanes.length === 0) return undefined;
  return lanes
    .filter((l) => Number.isInteger(l.index) && l.index >= 1)
    .map((l) => {
      const type = laneTypeOf(event, l.type);
      return { index: l.index, status: l.status, ...(type ? { type } : {}) };
    });
}

/** The base effect a record's restriction facts narrow: a closure or an access ban. */
function restrictionBase(event: RoadEvent): BaseEffect {
  return event.roadState === "closed" || event.type === "road_closure"
    ? { kind: "closure", scope: "road" }
    : { kind: "access", mode: "prohibited" };
}

export interface EffectContext {
  /** The source-local id of the record the effects come from; prefixes every effect id. */
  recordId: string;
  /** DATEX situationRecord id/version, when the effects come from one record of a group. */
  sourceRecordRef?: string;
  /** The record's own validity, when it differs from the situation's. */
  validity?: Validity;
  /** The record's own geometry, when it differs from the situation's. */
  location?: Record<string, unknown>;
  direction?: DirectionRef;
  /** Whether a closure effect is implied when the event states no impact (closure situations). */
  closureNature: boolean;
  /**
   * Whether the record itself says lanes are closed (its own classification
   * is `closure.closure.lane`). Parsers type every DATEX lane-management
   * record as `lane_closure`, including one that opens the hard shoulder, so
   * the coarse type alone never implies a lane closure.
   */
  laneClosureNature: boolean;
}

/**
 * The kernel effects one parsed event states. Each impact field becomes one
 * effect: a road closure a `closure`, lane figures a `lane_restriction`, a
 * speed limit a `speed_limit`, the restriction contract its dimension and
 * applicability effects, a diversion a `detour`, a delay or queue a `delay`.
 * A closure situation without any impact still closes the road. Effect ids are
 * `<recordId>/<kind>[:<n>]`, numbered per kind only when a record yields
 * several of that kind.
 */
export function effectsOf(event: RoadEvent, ctx: EffectContext): PlacedEffect[] {
  const applicability = applicabilityOf(event);
  const common = {
    ...(ctx.sourceRecordRef ? { sourceRecordRef: ctx.sourceRecordRef } : {}),
    ...(ctx.location ? { location: ctx.location } : {}),
    ...(ctx.direction ? { direction: ctx.direction } : {}),
    ...(ctx.validity ? { validity: ctx.validity } : {}),
  };
  const drafts: Draft[] = [];
  // A measure is mandatory unless its source declares it advisory, or states
  // a compliance it cannot establish.
  const declared = event.situation?.compliance;
  const measure = { applicability, compliance: declared ?? "mandatory", normalization: "complete" };
  const closure = {
    scope: event.situation?.closureScope ?? "road",
    ...measure,
    applicability: closureApplicability(event),
  };

  const closed = event.roadState === "closed";
  // With the restriction contract present, its facts decide which vehicles the
  // closure applies to; an all-vehicle closure next to them would contradict it.
  const contract = event.restrictionDetails !== undefined;
  if (closed && !contract) drafts.push({ kind: "closure", fields: closure });
  if (
    !closed &&
    (event.lanesAffected || event.roadState === "some_lanes_closed" || ctx.laneClosureNature)
  ) {
    const lanes = event.lanesAffected ? lanesOf(event) : undefined;
    const figures = event.lanesAffected;
    const total = figures?.total !== undefined && figures.total > 0 ? figures.total : undefined;
    const closedLanes =
      figures?.closed !== undefined && (total === undefined || figures.closed <= total)
        ? figures.closed
        : undefined;
    drafts.push({
      kind: "lane_restriction",
      fields: {
        vehicleImpact: event.lanesAffected ? laneImpact(event) : "some_lanes_closed",
        ...(total !== undefined ? { lanesTotal: total } : {}),
        ...(closedLanes !== undefined ? { lanesClosed: closedLanes } : {}),
        ...(lanes && lanes.length > 0 ? { lanes } : {}),
        ...measure,
      },
    });
  }
  if (event.type === "contraflow") drafts.push({ kind: "contraflow", fields: { ...measure } });
  if (event.speedLimitKph !== undefined && event.speedLimitKph > 0) {
    drafts.push({
      kind: "speed_limit",
      fields: {
        limit: { value: event.speedLimitKph, unit: "km/h" },
        ...(declared === "advisory" ? { advisory: true } : {}),
        ...measure,
      },
    });
  }
  if (event.restrictionDetails === undefined) {
    const units = event.sourceFormat === "wzdx" ? WZDX_UNITS : UNITS;
    for (const [i, r] of (event.restrictions ?? []).entries()) {
      drafts.push(legacyRestriction(r, `restrictions[${i}]`, applicability, units));
    }
    // A lane's own restrictions hold on that lane only.
    const lanes = event.lanesAffected?.lanes ?? [];
    for (const [i, lane] of lanes.entries()) {
      if (!lane.restrictions?.length || !Number.isInteger(lane.index) || lane.index < 1) continue;
      const type = laneTypeOf(event, lane.type);
      const laneScope = [{ index: lane.index, ...(type ? { type } : {}) }];
      for (const [j, r] of lane.restrictions.entries()) {
        const draft = legacyRestriction(
          r,
          `lanesAffected.lanes[${i}].restrictions[${j}]`,
          applicability,
          units,
        );
        drafts.push({ ...draft, fields: { ...draft.fields, laneScope } });
      }
    }
  }
  // A detour event (WZDx Detour) is the diversion itself: its own line is the route.
  const ownRoute =
    event.type === "detour" &&
    (event.geometry?.type === "LineString" || event.geometry?.type === "MultiLineString")
      ? event.geometry
      : undefined;
  if (event.detour || event.detourGeometry || event.type === "detour") {
    const description = text(
      event.detour ?? (event.type === "detour" ? event.headline : undefined),
    );
    const geometry = event.detourGeometry ?? ownRoute;
    drafts.push({
      kind: "detour",
      fields: {
        ...(description ? { description } : {}),
        ...(geometry ? { geometry } : {}),
        applicability,
        // A diversion is advice unless the source makes it mandatory.
        compliance: declared ?? "advisory",
        normalization: "complete",
      },
    });
  }
  const delay = event.delaySeconds !== undefined && event.delaySeconds > 0;
  const queue = event.queueLengthMeters !== undefined && event.queueLengthMeters > 0;
  const capacity = event.capacityRemainingPct;
  if (delay || queue || capacity !== undefined) {
    drafts.push({
      kind: "delay",
      fields: {
        ...(delay ? { delay: { value: event.delaySeconds!, unit: "s" } } : {}),
        ...(queue ? { queueLength: { value: event.queueLengthMeters!, unit: "m" } } : {}),
        ...(capacity !== undefined ? { capacityRemainingPct: capacity } : {}),
        applicability,
        compliance: "unknown",
        normalization: "complete",
      },
    });
  }
  if (event.restrictionDetailsUnsupported === true) {
    const issues: Issue[] = [{ code: "unsupported_type", sourcePath: "restrictionDetails" }];
    drafts.push({
      kind: "unsupported",
      fields: {
        applicability: { kind: "unknown" },
        compliance: "unknown",
        normalization: "unsupported",
        issues,
        source: { path: "restrictionDetails" },
      },
    });
  }
  if (
    ctx.closureNature &&
    !contract &&
    event.type !== "detour" &&
    !drafts.some((d) => d.kind === "closure" || d.kind === "lane_restriction")
  ) {
    drafts.unshift({ kind: "closure", fields: closure });
  }

  // A record whose lifecycle status does not establish that it is in force
  // marks every effect it states, as do its other record-level issues; the
  // restriction contract's effects carry their own. An issue that does not
  // leave the effect's time unknown leaves a complete effect partial.
  const recordIssues = [
    ...(event.situation?.statusIssue ? [event.situation.statusIssue] : []),
    ...(event.situation?.effectIssues ?? []),
  ];
  const partial = recordIssues.some((i) => !TEMPORAL_ISSUE_CODES.has(i.code));
  const actionStatus = event.situation?.actionStatus;
  for (const d of drafts) {
    if (recordIssues.length > 0) {
      d.fields = {
        ...d.fields,
        issues: [...((d.fields["issues"] as Issue[]) ?? []), ...recordIssues],
        ...(partial && d.fields["normalization"] === "complete"
          ? { normalization: "partial" }
          : {}),
      };
    }
    if (actionStatus !== undefined) d.fields = { ...d.fields, actionStatus };
  }

  const perKind = new Map<string, number>();
  for (const d of drafts) perKind.set(d.kind, (perKind.get(d.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  const placed: PlacedEffect[] = drafts.map((d) => {
    const n = (seen.get(d.kind) ?? 0) + 1;
    seen.set(d.kind, n);
    const id =
      perKind.get(d.kind)! > 1 ? `${ctx.recordId}/${d.kind}:${n}` : `${ctx.recordId}/${d.kind}`;
    return { phaseId: null, effect: { id, kind: d.kind, v: 1, ...common, ...d.fields } as Effect };
  });

  if (event.restrictionDetails !== undefined) {
    for (const p of restrictionEffects(event.restrictionDetails, restrictionBase(event))) {
      placed.push({
        phaseId: p.phaseId,
        effect: {
          ...p.effect,
          ...(ctx.sourceRecordRef ? { sourceRecordRef: ctx.sourceRecordRef } : {}),
        } as Effect,
      });
    }
  }
  return placed;
}
