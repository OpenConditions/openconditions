import {
  type Effect,
  localDateInZone,
  type Schedule,
  situationCode,
  type Validity,
} from "@openconditions/model";
import {
  natureFromCauses,
  type PlacedEffect,
  ROADS_SITUATION_KINDS,
  type RoadClassification,
  WZDX_RELATIONS,
} from "@openconditions/model-roads";
import type { RoadEvent } from "../model.js";
import type { RoadSnapshotRecord, SnapshotEvent } from "../snapshot.js";
import type { SourceDescriptor } from "../types.js";
import { classificationOf } from "./classes.js";
import { effectsOf } from "./effects.js";
import { locationOf, text } from "./location.js";

/**
 * A situation draft: the parser-side record the write seam (`sealRecord`)
 * validates and stamps. Plain data; the registry is its schema.
 */
export type SituationDraft = Record<string, unknown>;

export interface AssembleOptions {
  source: SourceDescriptor;
  /** A snapshot parser's per-record accounting, for record versions. */
  records?: readonly RoadSnapshotRecord[];
}

/** Kinds that name what a record does rather than what it is; they fold into the group's nature. */
const EFFECT_ONLY_KINDS = new Set(["closure", "restriction", "winter_operation", "other"]);

const DECLARED_SEVERITY: Record<string, string> = {
  low: "minor",
  medium: "moderate",
  high: "major",
  critical: "critical",
};

const STATUS: Record<RoadEvent["status"], Validity["status"]> = {
  active: "active",
  inactive: "ended",
  archived: "ended",
  cancelled: "cancelled",
};

const SURFACE: Record<string, string> = {
  icy: "ice",
  snow_covered: "snow",
  slush: "slush",
  wet: "wet",
  dry: "dry",
  frost: "frost",
  standing_water: "standing_water",
};

const LOS: Record<string, string> = {
  queuing: "queuing",
  stationary: "stationary",
  slow: "slow",
  heavy: "heavy",
  stop_and_go: "queuing",
};

const EXTERNAL_ID_SCHEME: Record<string, string> = {
  datex2: "datex:record",
  wzdx: "wzdx:road_event",
  open511: "open511",
};

/** An instant with a zone designator, or undefined when the value is not one. */
function instant(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function localIdOf(event: SnapshotEvent): string {
  const prefix = `${event.source}:`;
  return event.id.startsWith(prefix) ? event.id.slice(prefix.length) : event.id;
}

/**
 * A parser schedule as a kernel Schedule. DATEX `validPeriod` bounds are
 * instants, the kernel's recurrence bounds are local dates: an instant bound
 * becomes its local date in the schedule's zone, which is how the evaluator
 * already reads it; the exact start and end stay on the validity.
 */
function kernelSchedule(s: Schedule): Schedule | undefined {
  const out: Schedule = { ...s };
  for (const key of ["startDate", "endDate"] as const) {
    const value = s[key];
    if (value === undefined || !value.includes("T")) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return undefined;
    out[key] = localDateInZone(new Date(ms), s.scheduleTimezone);
  }
  return out;
}

function validityOf(event: SnapshotEvent): Validity {
  const start = instant(event.validFrom);
  let end = instant(event.validTo);
  // An inverted window cannot be evaluated; the declared start is kept, the
  // contradictory end is not invented away into a closed interval.
  if (start !== undefined && end !== undefined && Date.parse(end) < Date.parse(start)) {
    end = undefined;
  }
  const periods = (event.schedule ?? [])
    .filter((s): s is Schedule => typeof s.scheduleTimezone === "string")
    .map(kernelSchedule)
    .filter((s): s is Schedule => s !== undefined);
  return {
    status: STATUS[event.status],
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(periods.length > 0 ? { periods: periods as Validity["periods"] } : {}),
  };
}

/** The measurement site a derived situation was computed from, as a record ref. */
function derivedFromSiteOf(event: RoadEvent) {
  const site = event.situation?.derivedFromSite;
  return site === undefined
    ? undefined
    : { class: "feature" as const, id: `oc:feature:${event.source}:${site}` };
}

function detailsOf(c: RoadClassification, event: RoadEvent): Record<string, unknown> {
  const base = { kind: c.kind, v: 1 };
  switch (c.kind) {
    case "roadworks":
      return {
        ...base,
        ...(event.workersPresent !== undefined ? { workersPresent: event.workersPresent } : {}),
        ...(event.workZoneType !== undefined
          ? {
              workZoneType:
                event.workZoneType === "area" ? "planned_moving_area" : event.workZoneType,
            }
          : {}),
      };
    case "restriction":
      return { ...base, basis: "temporary" };
    case "road_condition":
      return { ...base, surface: [SURFACE[c.subtype ?? ""] ?? "unknown"] };
    case "congestion": {
      const site = derivedFromSiteOf(event);
      return {
        ...base,
        los: LOS[c.subtype ?? ""] ?? "unknown",
        ...(site !== undefined ? { derivedFrom: site } : {}),
        ...(event.freeFlowSource !== undefined ? { freeFlowSource: event.freeFlowSource } : {}),
      };
    }
    default:
      return base;
  }
}

function severityOf(c: RoadClassification, event: RoadEvent, effects: readonly Effect[]) {
  const declared =
    event.severitySource === "declared" ? DECLARED_SEVERITY[event.severity] : undefined;
  const level = event.severityLevel !== undefined ? { level: event.severityLevel } : {};
  if (declared !== undefined) return { label: declared, source: "declared", ...level };
  const rule = ROADS_SITUATION_KINDS.find((k) => k.code === c.kind)?.deriveSeverity;
  const derived = rule?.({ type: c.type, ...(c.subtype ? { subtype: c.subtype } : {}), effects });
  return derived !== undefined
    ? { label: derived, source: "derived", ...level }
    : { label: "unknown" };
}

function relationsOf(event: RoadEvent, source: SourceDescriptor, selfId: string) {
  const ref = (id: string) => ({ class: "situation", id: `oc:situation:${source.id}:${id}` });
  const typed = (event.relatedEvents ?? []).map((r) => ({
    ref: ref(r.id),
    relation: (r.type ? WZDX_RELATIONS[r.type] : undefined) ?? "related",
  }));
  const seen = new Set(typed.map((r) => r.ref.id));
  const plain = (event.relatedIds ?? [])
    .map((id) => ({ ref: ref(id), relation: "related" }))
    .filter((r) => !seen.has(r.ref.id));
  return [...typed, ...plain].filter((r) => r.ref.id !== selfId);
}

/** The event a detour names as its parent (WZDx `related_road_events`), when it is in the snapshot. */
function parentOf(
  detour: RoadEvent,
  byLocalId: ReadonlyMap<string, RoadEvent>,
): RoadEvent | undefined {
  for (const related of detour.relatedEvents ?? []) {
    const parent =
      byLocalId.get(related.id) ??
      [...byLocalId.entries()].find(([id]) => id.endsWith(`:${related.id}`))?.[1];
    if (parent !== undefined && parent !== detour && parent.type !== "detour") return parent;
  }
  return undefined;
}

/**
 * Events of one source situation, in document order; ungrouped events stand
 * alone, except a detour whose parent is in the snapshot, which joins it.
 */
function groupsOf(
  events: readonly SnapshotEvent[],
): { situationId?: string; events: RoadEvent[] }[] {
  const out: { situationId?: string; events: RoadEvent[] }[] = [];
  const bySituation = new Map<string, RoadEvent[]>();
  const all = events as RoadEvent[];
  const byLocalId = new Map(all.map((e) => [localIdOf(e), e]));
  const ownGroup = new Map<RoadEvent, RoadEvent[]>();
  const deferred: [RoadEvent, RoadEvent][] = [];
  for (const e of all) {
    const parent = e.type === "detour" && !e.situationId ? parentOf(e, byLocalId) : undefined;
    if (parent !== undefined) {
      deferred.push([e, parent]);
      continue;
    }
    if (!e.situationId) {
      const members = [e];
      ownGroup.set(e, members);
      out.push({ events: members });
      continue;
    }
    const members = bySituation.get(e.situationId);
    if (members) members.push(e);
    else {
      const created = [e];
      bySituation.set(e.situationId, created);
      out.push({ situationId: e.situationId, events: created });
    }
  }
  for (const [detour, parent] of deferred) {
    const members = ownGroup.get(parent) ?? bySituation.get(parent.situationId ?? "");
    if (members) members.push(detour);
    else out.push({ events: [detour] });
  }
  return out;
}

const natureCode = (c: RoadClassification) => `${c.kind}.${c.type}`;

/**
 * One source group split into situations: records with one nature form one
 * situation; records of different natures (an accident and a fire reported
 * together) become separate situations sharing `groupId`. Records that only
 * say what is done about it (lane, speed, rerouting management) join the
 * first situation as its effects. When no record names a nature, the stated
 * causes decide it (NDW publishes roadworks as management records caused by
 * `roadMaintenance`); without a cause, the first record's own class stands.
 */
function partsOf(
  events: readonly RoadEvent[],
): { primary: RoadEvent; members: RoadEvent[]; nature?: RoadClassification }[] {
  const natures = new Map<string, RoadEvent[]>();
  for (const e of events) {
    const c = classificationOf(e);
    if (EFFECT_ONLY_KINDS.has(c.kind)) continue;
    const key = natureCode(c);
    natures.set(key, [...(natures.get(key) ?? []), e]);
  }
  if (natures.size === 0) {
    const causes = [...new Set(events.flatMap((e) => classificationOf(e).causes ?? []))];
    const nature = natureFromCauses(causes);
    return [{ primary: events[0]!, members: [...events], ...(nature ? { nature } : {}) }];
  }
  if (natures.size === 1) {
    return [{ primary: [...natures.values()][0]![0]!, members: [...events] }];
  }
  const parts = [...natures.values()].map((members) => ({ primary: members[0]!, members }));
  const effectOnly = events.filter((e) => EFFECT_ONLY_KINDS.has(classificationOf(e).kind));
  parts[0]!.members.push(...effectOnly);
  return parts;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The situation drafts of one parsed snapshot of one source. A DATEX
 * situation's records fold into one situation (or split by nature), each
 * record's effects keeping `sourceRecordRef`, its own validity and its own
 * location when they differ from the situation's. Every other event is one
 * situation. A detour whose parent is not in the snapshot becomes the
 * `closure.closure` situation the spec calls for, marked `derived`.
 */
export function situationDrafts(
  events: readonly SnapshotEvent[],
  opts: AssembleOptions,
): SituationDraft[] {
  const { source } = opts;
  const versions = new Map((opts.records ?? []).map((r) => [r.id, r]));
  const drafts: SituationDraft[] = [];

  for (const group of groupsOf(events)) {
    const parts = partsOf(group.events);
    const split = parts.length > 1;
    for (const { primary, members, nature } of parts) {
      const localId =
        group.situationId !== undefined && !split ? group.situationId : localIdOf(primary);
      const id = `oc:situation:${source.id}:${localId}`;
      const c = nature ?? classificationOf(primary);
      const location = locationOf(primary, source);
      const validity = validityOf(primary);
      const grouped = group.situationId !== undefined;

      const placed: PlacedEffect[] = members.flatMap((member) => {
        const own = member === primary;
        const memberValidity = validityOf(member);
        const memberLocation = locationOf(member, source);
        const version = versions.get(member.id)?.version;
        return effectsOf(member, {
          recordId: localIdOf(member),
          ...(grouped
            ? {
                sourceRecordRef:
                  version !== null && version !== undefined
                    ? `${localIdOf(member)}/${version}`
                    : localIdOf(member),
              }
            : {}),
          ...(!own && !sameJson(memberValidity, validity) ? { validity: memberValidity } : {}),
          ...(!own && !sameJson(memberLocation["geometry"], location["geometry"])
            ? {
                location: {
                  geometry: memberLocation["geometry"],
                  extent: memberLocation["extent"],
                  geometryOrigin: memberLocation["geometryOrigin"],
                },
              }
            : {}),
          ...(location["direction"] !== undefined
            ? { direction: location["direction"] as Effect["direction"] }
            : {}),
          closureNature: c.kind === "closure" && member === primary,
          laneClosureNature: situationCode(classificationOf(member)) === "closure.closure.lane",
        });
      });

      const phased = new Map<string, Effect[]>();
      const effects: Effect[] = [];
      for (const p of placed) {
        if (p.phaseId !== null && c.kind === "roadworks") {
          phased.set(p.phaseId, [...(phased.get(p.phaseId) ?? []), p.effect]);
        } else effects.push(p.effect);
      }
      const details = detailsOf(c, primary);
      if (phased.size > 0) {
        details["phases"] = [...phased.entries()].map(([phaseId, phaseEffects]) => {
          const starts = phaseEffects.map((e) => e.validity?.start).filter((s) => s !== undefined);
          const ends = phaseEffects.map((e) => e.validity?.end).filter((s) => s !== undefined);
          return {
            id: phaseId,
            validity: {
              status: "active",
              ...(starts.length > 0 ? { start: starts.sort()[0] } : {}),
              ...(ends.length > 0 ? { end: ends.sort().at(-1) } : {}),
            },
            effects: phaseEffects,
          };
        });
      }

      const causes = [...new Set(members.flatMap((m) => classificationOf(m).causes ?? []))].map(
        (type) => ({ type }),
      );
      const detourOnly = members.every((m) => m.type === "detour");
      const headline =
        primary.situation?.headlineFromSource === false ? undefined : text(primary.headline);
      const description = text(primary.description);
      const relations = relationsOf(primary, source, id);
      const scheme = EXTERNAL_ID_SCHEME[primary.sourceFormat];
      const externalIds =
        grouped && primary.sourceFormat === "datex2"
          ? [{ scheme: "datex:situation", id: group.situationId! }]
          : scheme !== undefined
            ? [{ scheme, id: localIdOf(primary) }]
            : [];
      const version = versions.get(primary.id)?.version;
      const derivedFrom = derivedFromSiteOf(primary as RoadEvent);
      const sourceUpdatedAt = instant(primary.situation?.sourceUpdatedAt);
      const expiresAt = instant(primary.expiresAt);

      drafts.push({
        id,
        class: "situation",
        kind: c.kind,
        type: c.type,
        ...(c.subtype !== undefined ? { subtype: c.subtype } : {}),
        ...(causes.length > 0 ? { causes } : {}),
        // Planned and not yet started is scheduled; planned works under way are live.
        temporality: primary.isForecast
          ? "forecast"
          : primary.isPlanned &&
              validity.start !== undefined &&
              Date.parse(validity.start) > Date.parse(primary.fetchedAt)
            ? "scheduled"
            : "live",
        planned: primary.isPlanned,
        certainty: primary.confidence ?? "unknown",
        severity: severityOf(c, primary, effects),
        ...(headline ? { headline } : {}),
        ...(description ? { description } : {}),
        validity,
        effects,
        ...(split ? { groupId: group.situationId } : {}),
        details,
        ...(externalIds.length > 0 ? { externalIds } : {}),
        location,
        ...(relations.length > 0 ? { relations } : {}),
        provenance: {
          origin: detourOnly || derivedFrom !== undefined ? "derived" : "feed",
          sourceId: source.id,
          sourceFormat: primary.sourceFormat,
          accessMode: "bulk",
          recordId: localId,
          ...(derivedFrom !== undefined
            ? { derivedFrom: { records: [derivedFrom], method: "los_threshold", version: "1" } }
            : {}),
          ...(version !== null && version !== undefined ? { recordVersion: String(version) } : {}),
          ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
          attribution: {
            provider: source.attribution,
            license: source.license,
            ...(source.licenseUrl ? { licenseUrl: source.licenseUrl } : {}),
          },
          privacy: { class: "authoritative" },
        },
        freshness: {
          fetchedAt: instant(primary.fetchedAt) ?? primary.fetchedAt,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
      });
    }
  }
  return drafts;
}
