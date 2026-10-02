import {
  type Effect,
  effectStateAt,
  effectValidity,
  isRestrictionEvidence,
  isVehicleSpecific,
  type Registry,
  type SituationClass,
  situationEffects,
  type Validity,
} from "@openconditions/model";
import { XMLBuilder } from "fast-xml-parser";

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
 * be read is too.
 */

export interface TraffEvent {
  cls: string;
  type: string;
  quantifiers?: Record<string, number>;
  /** A diversion is in operation (a detour effect), as supplementary info. */
  diversion?: true;
}

const event = (type: string, quantifiers?: Record<string, number>): TraffEvent => ({
  cls: type.slice(0, type.indexOf("_")),
  type,
  ...(quantifiers && Object.keys(quantifiers).length > 0 ? { quantifiers } : {}),
});

/** An effect TraFF cannot carry without widening or misstating it. */
const untellable = (effect: Effect) => isVehicleSpecific(effect) || isRestrictionEvidence(effect);

const CLOSURE_BY_SCOPE: Readonly<Record<string, string>> = {
  carriageway: "RESTRICTION_CARRIAGEWAY_CLOSED",
  ramp: "RESTRICTION_RAMP_CLOSED",
  bridge: "RESTRICTION_BRIDGE_CLOSED",
  tunnel: "RESTRICTION_TUNNEL_CLOSED",
};

/** The TraFF event an effect states, if it restricts traffic. */
function effectEvent(effect: Effect): TraffEvent | undefined {
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
    case "delay":
      return event(
        "DELAY_DELAY",
        effect.queueLength ? { length: Math.round(effect.queueLength.value) } : undefined,
      );
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

function buildLocation(situation: Rec): Record<string, unknown> {
  const location = situation["location"] as Rec;
  const road = (location["roads"] as Rec[] | undefined)?.[0];
  const loc: Record<string, unknown> = {};
  const name = firstText(road?.["name"]);
  if (name) loc["@_road_name"] = name;
  if (typeof road?.["ref"] === "string") loc["@_road_ref"] = road["ref"];
  const roadClass = ROAD_CLASSES[String(road?.["class"])];
  if (roadClass) loc["@_road_class"] = roadClass;
  const direction = location["direction"] as Rec | undefined;
  const directionText = direction?.["text"] ?? direction?.["compass"];
  if (typeof directionText === "string") loc["@_direction"] = directionText;
  const geometry = location["geometry"] as { type?: string } | null;
  const pts = positions(geometry);
  if (geometry?.type === "LineString" && pts.length >= 2) {
    // An ordered line from start to end implies one direction.
    loc["@_directionality"] = "ONE_DIRECTION";
    const from: Record<string, unknown> = { "#text": coordText(pts[0]!) };
    if (typeof road?.["from"] === "string") from["@_junction_name"] = road["from"];
    const to: Record<string, unknown> = { "#text": coordText(pts.at(-1)!) };
    if (typeof road?.["to"] === "string") to["@_junction_name"] = road["to"];
    loc["from"] = from;
    loc["to"] = to;
  } else if (pts.length > 0) {
    loc["at"] = coordText(pts[0]!);
  }
  return loc;
}

/** Whether an effect holds at a place of its own rather than its situation's. */
const hasOwnPlace = (effect: Effect) =>
  (effect.location as { geometry?: unknown } | undefined)?.geometry != null;

/** The events of `effects` in force or scheduled at `at`, appended to `out`. */
function effectEvents(effects: Effect[], validity: Validity, at: Date, out: TraffEvent[]) {
  let diversion = false;
  for (const effect of effects) {
    const { state } = effectStateAt(effect, validity, at);
    if (state === "ended" || state === "unknown") continue;
    if (effect.kind === "detour") diversion = true;
    const e = effectEvent(effect);
    if (e && !out.some((o) => o.type === e.type)) out.push(e);
  }
  if (diversion && out[0]) out[0] = { ...out[0], diversion: true };
  return out;
}

/**
 * The TraFF events of a situation at `at` told at its own place: its nature,
 * then those of its effects in force or scheduled that hold there. None when
 * TraFF cannot tell the situation truthfully.
 */
export function traffEventsOf(registry: Registry, situation: Rec, at: Date): TraffEvent[] {
  const effects = situationEffects(situation);
  if (effects.some(untellable)) return [];
  const out: TraffEvent[] = [];
  const nature = registry.crosswalk.situationTargetCode(
    "traff",
    situation as unknown as SituationClass,
  );
  if (nature) out.push(event(nature));
  const here = effects.filter((e) => !hasOwnPlace(e));
  return effectEvents(here, situation["validity"] as Validity, at, out);
}

/**
 * The messages of one situation: itself at its place, then one per effect
 * holding at a place of its own (a grouped record on another road), at that
 * place, so a consumer never closes the wrong road.
 */
function messagesOf(registry: Registry, situation: Rec, at: Date): Record<string, unknown>[] {
  if (situationEffects(situation).some(untellable)) return [];
  const events = traffEventsOf(registry, situation, at);
  const out = events.length > 0 ? [buildMessage(situation, events)] : [];
  const validity = situation["validity"] as Validity;
  for (const effect of situationEffects(situation).filter(hasOwnPlace)) {
    const own = effectEvents([effect], validity, at, []);
    if (own.length === 0) continue;
    out.push(
      buildMessage(
        {
          ...situation,
          id: `${String(situation["id"])}#${effect.id}`,
          validity: effectValidity(effect, validity),
          location: { ...(situation["location"] as Rec), ...(effect.location as Rec) },
        },
        own,
      ),
    );
  }
  return out;
}

function buildMessage(situation: Rec, events: TraffEvent[]): Record<string, unknown> {
  const validity = situation["validity"] as Validity;
  const provenance = situation["provenance"] as Rec;
  const freshness = situation["freshness"] as Rec;
  const updated =
    (provenance["sourceUpdatedAt"] as string | undefined) ?? (freshness["fetchedAt"] as string);
  const expiration = (freshness["expiresAt"] as string | undefined) ?? validity.end;
  return {
    "@_id": situation["id"],
    "@_receive_time": freshness["fetchedAt"],
    "@_update_time": updated,
    "@_urgency": urgencyOf(situation["severity"]),
    ...(expiration ? { "@_expiration_time": expiration } : {}),
    ...(validity.start ? { "@_start_time": validity.start } : {}),
    ...(validity.end ? { "@_end_time": validity.end } : {}),
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
    location: buildLocation(situation),
  };
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

/**
 * Projects situations to a TraFF v0.8 `<feed>` document, evaluated at `at`.
 * A situation with no event TraFF can carry, or with a vehicle-specific
 * effect, is left out. TraFF carries no feed-level attribution element;
 * credit travels via HTTP headers and each source's licence.
 */
export function situationsToTraff(
  registry: Registry,
  situations: readonly Rec[],
  at: Date = new Date(),
): string {
  const message = situations.flatMap((situation) => messagesOf(registry, situation, at));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ feed: { message } })}`;
}
