import {
  type Effect,
  effectValidity,
  type Registry,
  type SituationClass,
  type Validity,
} from "@openconditions/model";
import { type ExportDiagnosticSink, ProjectionDiagnostics } from "./export-diagnostics.js";
import {
  definesManagementNature,
  type ProjectionEffect,
  projectionEffects,
  projectionStateAt,
  sameInterval,
} from "./export-validity.js";
import { buildXmlDocument } from "./xml.js";

type Rec = Record<string, unknown>;

/**
 * TraFF (Traffic Feed Format) v0.8 emitter — the interop format the FOSS nav
 * ecosystem (CoMaps, Navit) reads. Spec: https://traffxml.gitlab.io/. Each
 * situation becomes one `<message>`: its nature through the registry's TraFF
 * crosswalk, then one event per effect that restricts traffic (TraFF's
 * cause-and-effect multi-event model), with the effect's quantifiers.
 * Coordinates are "lat lon", space-separated.
 *
 * TraFF cannot say which vehicles an event applies to, so a situation with
 * any vehicle-specific effect is left out rather than published as applying
 * to everyone. Ended effects are left out; an effect whose window could not
 * be read is too. Explicit directions without representable travel order are
 * withheld; absent direction metadata uses TraFF's bidirectional default.
 */

export interface TraffEvent {
  cls: string;
  type: string;
  quantifiers?: Record<string, number | string>;
  /** A diversion is in operation (a detour effect), as supplementary info. */
  diversion?: true;
}

const event = (type: string, quantifiers?: Record<string, number | string>): TraffEvent => ({
  cls: type.slice(0, type.indexOf("_")),
  type,
  ...(quantifiers && Object.keys(quantifiers).length > 0 ? { quantifiers } : {}),
});

const CLOSURE_BY_SCOPE: Readonly<Record<string, string>> = {
  carriageway: "RESTRICTION_CARRIAGEWAY_CLOSED",
  ramp: "RESTRICTION_RAMP_CLOSED",
  bridge: "RESTRICTION_BRIDGE_CLOSED",
  tunnel: "RESTRICTION_TUNNEL_CLOSED",
};

/** TraFF 0.8 q_duration is whole minutes, written as hours:minutes. */
function delayDuration(effect: Effect, diagnostics: ProjectionDiagnostics): string | undefined {
  if (effect.kind !== "delay" || !effect.delay) return undefined;
  const seconds = effect.delay.value;
  const minutes = Math.round(seconds / 60);
  const path = `${diagnostics.effectPath(effect)}/delay`;
  if (
    effect.delay.unit !== "s" ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    !Number.isSafeInteger(minutes) ||
    (seconds > 0 && minutes === 0)
  ) {
    diagnostics.emit(
      "field_not_exported",
      "field",
      "omitted",
      path,
      "This delay duration cannot be represented in TraFF's whole-minute precision; queue length can still be exported.",
      effect,
    );
    return undefined;
  }
  if (seconds !== minutes * 60)
    diagnostics.emit(
      "field_precision_reduced",
      "field",
      "reduced",
      path,
      "TraFF rounds this delay duration to the nearest whole minute.",
      effect,
    );
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The TraFF event an effect states, if it restricts traffic. */
function effectEvent(effect: Effect, diagnostics: ProjectionDiagnostics): TraffEvent | undefined {
  switch (effect.kind) {
    case "closure":
      return event(CLOSURE_BY_SCOPE[effect.scope] ?? "RESTRICTION_CLOSED");
    case "lane_restriction":
      if (effect.vehicleImpact === "all_lanes_closed") return event("RESTRICTION_CLOSED");
      if (effect.vehicleImpact === "all_lanes_open") return undefined;
      return event("RESTRICTION_LANE_CLOSED");
    case "contraflow":
      return event("RESTRICTION_CONTRAFLOW");
    case "speed_limit":
      return event("RESTRICTION_SPEED_LIMIT", { speed: Math.round(effect.limit.value) });
    case "delay": {
      const duration = delayDuration(effect, diagnostics);
      return event("DELAY_DELAY", {
        ...(effect.queueLength ? { length: Math.round(effect.queueLength.value) } : {}),
        ...(duration !== undefined ? { q_duration: duration } : {}),
      });
    }
    default:
      return undefined;
  }
}

function urgencyOf(severity: unknown): string {
  const label = (severity as { label?: string } | undefined)?.label;
  if (label === "critical") return "X_URGENT";
  if (label === "major") return "URGENT";
  return "NORMAL";
}

const ROAD_CLASSES: Record<string, string> = {
  motorway: "MOTORWAY",
  trunk: "TRUNK",
  primary: "PRIMARY",
  secondary: "SECONDARY",
  tertiary: "TERTIARY",
};

/** Signed decimal with explicit "+" for non-negatives, matching the TraFF examples. */
function fmtNum(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function coordText([lon, lat]: [number, number]): string {
  return `${fmtNum(lat)} ${fmtNum(lon)}`;
}

function positions(geometry: unknown): [number, number][] {
  const out: [number, number][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") out.push([c[0], c[1]]);
    else for (const x of c) walk(x);
  };
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] } | null;
  if (g?.type === "GeometryCollection")
    for (const part of g.geometries ?? []) out.push(...positions(part));
  else walk(g?.coordinates);
  return out;
}

/** The first text of a localised Text. */
const firstText = (text: unknown) => (text as { text: string }[] | undefined)?.[0]?.text;

function buildLocation(
  situation: Rec,
  diagnostics: ProjectionDiagnostics,
  path: string,
  effect?: Effect,
): Record<string, unknown> | undefined {
  const location = situation["location"] as Rec;
  const road = (location["roads"] as Rec[] | undefined)?.[0];
  const loc: Record<string, unknown> = {};
  const name = firstText(road?.["name"]);
  if (name) loc["@_road_name"] = name;
  if (typeof road?.["ref"] === "string") loc["@_road_ref"] = road["ref"];
  const roadClass = ROAD_CLASSES[String(road?.["class"])];
  if (roadClass) loc["@_road_class"] = roadClass;
  const direction = location["direction"] as Rec | undefined;
  // A source-axis direction is not GeoJSON coordinate order. TraFF has no
  // unknown direction, and omitting directionality would assert both directions.
  if (direction !== undefined && direction["value"] !== "both") {
    diagnostics.emit(
      "unrepresentable_direction",
      "message",
      "withheld",
      `${effect && effect.location?.direction === undefined ? "/location" : path}/direction`,
      "This message is withheld: TraFF travel order cannot be inferred from this direction.",
      effect,
    );
    return undefined;
  }
  loc["@_directionality"] = "BOTH_DIRECTIONS";
  const geometry = location["geometry"] as { type?: string } | null;
  const pts = positions(geometry);
  if (geometry?.type === "LineString" && pts.length >= 2) {
    const from: Record<string, unknown> = { "#text": coordText(pts[0]!) };
    if (typeof road?.["from"] === "string") from["@_junction_name"] = road["from"];
    const to: Record<string, unknown> = { "#text": coordText(pts.at(-1)!) };
    if (typeof road?.["to"] === "string") to["@_junction_name"] = road["to"];
    if (pts.length > 2)
      diagnostics.emit(
        "geometry_to_endpoints",
        "field",
        "reduced",
        `${path}/geometry`,
        "Only the first and last line coordinates are exported; intermediate geometry is omitted.",
        effect,
      );
    loc["from"] = from;
    loc["to"] = to;
  } else if (pts.length > 0) {
    if (geometry?.type !== "Point")
      diagnostics.emit(
        "geometry_to_point",
        "field",
        "reduced",
        `${path}/geometry`,
        "This geometry is exported as its first coordinate only.",
        effect,
      );
    loc["at"] = coordText(pts[0]!);
  } else {
    diagnostics.emit(
      "missing_geometry",
      "message",
      "withheld",
      `${path}/geometry`,
      "This message is withheld: no usable coordinate is available.",
      effect,
    );
    return undefined;
  }
  return loc;
}

/** Whether an effect holds at a place of its own rather than its situation's. */
const hasOwnPlace = (effect: Effect) =>
  (effect.location as { geometry?: unknown } | undefined)?.geometry != null;

/** Stable comparison of canonical semantics, excluding record identity/provenance.
 * Keep unprojected fields: equal wire events can still describe different restrictions.
 */
function effectSemantics(effect: Effect, validity: Validity): string {
  const { id: _id, sourceRecordRef: _ref, source: _source, ...fields } = effect;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return JSON.stringify(canonical({ ...fields, validity: effectValidity(effect, validity) }));
}

/** The events of `effects` in force or scheduled at `at`, appended to `out`. */
function effectEvents(
  effects: ProjectionEffect[],
  at: Date,
  out: TraffEvent[],
  diagnostics: ProjectionDiagnostics,
) {
  let diversion = false;
  const byType = new Map<string, { effect: Effect; semantics: string }[]>();
  for (const context of effects) {
    const { effect, validity, validityPath } = context;
    const { state } = projectionStateAt(context, at);
    const path = diagnostics.effectPath(effect);
    if (state === "ended" || state === "unknown") {
      diagnostics.emit(
        state === "ended" ? "effect_ended" : "effect_time_unknown",
        "effect",
        "omitted",
        state === "unknown"
          ? validity.status === "unknown"
            ? `${validityPath}/status`
            : `${path}/issues`
          : validityPath,
        `This effect is not exported at the evaluation instant: ${state}.`,
        effect,
      );
      continue;
    }
    if (effect.kind === "detour") diversion = true;
    const e = effectEvent(effect, diagnostics);
    if (!e && effect.kind !== "detour")
      diagnostics.emit(
        "unsupported_effect",
        "effect",
        "omitted",
        `${path}/kind`,
        "This effect has no TraFF event mapping in the current emitter.",
        effect,
      );
    if (!e) continue;
    const prior = byType.get(e.type) ?? [];
    const semantics = effectSemantics(effect, validity);
    prior.push({ effect, semantics });
    byType.set(e.type, prior);
    // Delay pairs remain independent observations (not competing restrictions).
    if (!out.some((o) => JSON.stringify(o) === JSON.stringify(e))) out.push(e);
  }
  let conflict = false;
  for (const [type, entries] of byType) {
    if (type === "DELAY_DELAY" || new Set(entries.map((e) => e.semantics)).size < 2) continue;
    conflict = true;
    for (const { effect } of entries)
      diagnostics.emit(
        "conflicting_effects",
        "message",
        "withheld",
        diagnostics.effectPath(effect),
        "This message is withheld: same-type restrictions differ in value or context and cannot be safely collapsed into one TraFF event.",
        effect,
      );
  }
  if (conflict) return [];
  if (diversion && out[0]) out[0] = { ...out[0], diversion: true };
  return out;
}

/**
 * The TraFF events of a situation at `at` told at its own place: its nature,
 * then those of its effects in force or scheduled that hold there. None when
 * TraFF cannot tell the situation truthfully.
 */
export function traffEventsOf(
  registry: Registry,
  situation: Rec,
  at: Date,
  report?: ExportDiagnosticSink,
): TraffEvent[] {
  const effects = projectionEffects(situation);
  const diagnostics = new ProjectionDiagnostics(situation, report);
  if (diagnostics.blocked("traff")) return [];
  const out: TraffEvent[] = [];
  const nature = registry.crosswalk.situationTargetCode(
    "traff",
    situation as unknown as SituationClass,
  );
  // A mapped effect owns the restriction, including its filtering and window.
  const represented =
    nature &&
    effects.some(
      ({ effect }) =>
        definesManagementNature(situation, effect) ||
        effectEvent(effect, new ProjectionDiagnostics(situation))?.type === nature,
    );
  if (nature && !represented) out.push(event(nature));
  else if (!nature)
    diagnostics.emit(
      "unsupported_nature",
      "field",
      "omitted",
      "/type",
      "This situation classification has no TraFF nature mapping in the current registry.",
    );
  const here = effects.filter(
    ({ effect, validity }) =>
      !hasOwnPlace(effect) && sameInterval(validity, situation["validity"] as Validity),
  );
  return effectEvents(here, at, out, diagnostics);
}

/**
 * The messages of one situation: itself at its place, then one per effect
 * holding at a place of its own (a grouped record on another road), at that
 * place, so a consumer never closes the wrong road.
 */
function messagesOf(
  registry: Registry,
  situation: Rec,
  at: Date,
  report?: ExportDiagnosticSink,
): Record<string, unknown>[] {
  const diagnostics = new ProjectionDiagnostics(situation, report);
  if (diagnostics.blocked("traff")) return [];
  const events = traffEventsOf(registry, situation, at, report);
  const main =
    events.length > 0 ? buildMessage(situation, events, diagnostics, "/location") : undefined;
  const out = main === undefined ? [] : [main];
  const validity = situation["validity"] as Validity;
  const groups: ProjectionEffect[][] = [];
  for (const context of projectionEffects(situation)) {
    if (hasOwnPlace(context.effect)) groups.push([context]);
    else if (!sameInterval(context.validity, validity)) {
      const group = groups.find(
        (g) => !hasOwnPlace(g[0]!.effect) && sameInterval(g[0]!.validity, context.validity),
      );
      if (group) group.push(context);
      else groups.push([context]);
    }
  }
  for (const group of groups) {
    // Stable against input order; do not bypass collision checks when splitting.
    group.sort((a, b) => a.effect.id.localeCompare(b.effect.id));
    const first = group[0]!;
    const ownPlace = hasOwnPlace(first.effect);
    const own = effectEvents(group, at, [], diagnostics);
    if (own.length === 0) continue;
    const message = buildMessage(
      {
        ...situation,
        id: `${String(situation["id"])}#${first.effect.id}`,
        validity: first.validity,
        location: {
          ...(situation["location"] as Rec),
          ...(ownPlace ? (first.effect.location as Rec) : {}),
        },
      },
      own,
      diagnostics,
      ownPlace ? `${diagnostics.effectPath(first.effect)}/location` : "/location",
      ownPlace ? first.effect : undefined,
    );
    if (message !== undefined) out.push(message);
  }
  return out;
}

/** The Java TraFF reader accepts second-resolution ISO timestamps only. */
const wireTime = (value: string) => new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");

function buildMessage(
  situation: Rec,
  events: TraffEvent[],
  diagnostics: ProjectionDiagnostics,
  path: string,
  effect?: Effect,
): Record<string, unknown> | undefined {
  const location = buildLocation(situation, diagnostics, path, effect);
  if (location === undefined) return undefined;
  const validity = situation["validity"] as Validity;
  const provenance = situation["provenance"] as Rec;
  const freshness = situation["freshness"] as Rec;
  const updated =
    (provenance["sourceUpdatedAt"] as string | undefined) ?? (freshness["fetchedAt"] as string);
  const expiration = (freshness["expiresAt"] as string | undefined) ?? validity.end;
  return {
    "@_id": situation["id"],
    "@_receive_time": wireTime(freshness["fetchedAt"] as string),
    "@_update_time": wireTime(updated),
    "@_urgency": urgencyOf(situation["severity"]),
    ...(expiration ? { "@_expiration_time": wireTime(expiration) } : {}),
    ...(validity.start ? { "@_start_time": wireTime(validity.start) } : {}),
    ...(validity.end ? { "@_end_time": wireTime(validity.end) } : {}),
    ...(situation["temporality"] === "forecast" ? { "@_forecast": "true" } : {}),
    events: {
      event: events.map((e) => ({
        "@_class": e.cls,
        "@_type": e.type,
        ...Object.fromEntries(
          Object.entries(e.quantifiers ?? {}).map(([key, value]) => [`@_${key}`, value]),
        ),
        ...(e.diversion
          ? {
              supplementary_info: {
                "@_class": "DIVERSION",
                "@_type": "S_DIVERSION_IN_OPERATION",
              },
            }
          : {}),
      })),
    },
    location,
  };
}

/**
 * Projects situations to a TraFF v0.8 `<feed>` document, evaluated at `at`.
 * A situation with no event TraFF can carry, or with a vehicle-specific
 * effect, is left out. Locations whose explicit direction cannot be represented
 * without guessing travel order are withheld too. TraFF carries no feed-level attribution element;
 * credit travels via HTTP headers and each source's licence.
 */
export function situationsToTraff(
  registry: Registry,
  situations: readonly Rec[],
  at: Date = new Date(),
  report?: ExportDiagnosticSink,
): string {
  const message = situations.flatMap((situation) => messagesOf(registry, situation, at, report));
  return buildXmlDocument({ feed: { message } });
}
