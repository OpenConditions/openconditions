import {
  type Effect,
  type InformationSource,
  type SituationClass,
  situationEffects,
  type Validity,
} from "@openconditions/model";
import {
  DATEX2_FAULTY_EQUIPMENT,
  DATEX2_RECORDS,
  datexDiscriminator,
} from "@openconditions/model-roads";
import { type ExportDiagnosticSink, ProjectionDiagnostics } from "./export-diagnostics.js";
import {
  definesManagementNature,
  omittedPath,
  type ProjectionEffect,
  projectionEffects,
  projectionStateAt,
  sameInterval,
} from "./export-validity.js";
import type { FeedInfo } from "./types.js";
import { buildXmlDocument } from "./xml.js";

type Rec = Record<string, unknown>;
type Text = { lang: string; text: string }[];

/**
 * DATEX II v3 SituationPublication emitter over situations. Spec:
 * https://docs.datex2.eu/ (v3 modular schemas: messageContainer / situation /
 * common / locationReferencing). Hand-built with fast-xml-parser, mirroring
 * the reader in `@openconditions/roads`.
 *
 * One `situation` per situation: a record for its nature (`DATEX2_RECORDS`),
 * then one record per effect in force or scheduled that DATEX has a
 * management record for (closures, lane restrictions, contraflow, speed
 * limits, diversions). An effect whose record would repeat the nature record
 * is folded into it; a nature without a record of its own leads with its first
 * effect's. A record keeps the DATEX id it was read from (`sourceRecordRef`),
 * else `<situation id>#<effect id>`. Every record states the situation's
 * probability; severity, the informant and headline travel on its leading
 * record. A delay (its length, band and description) supplements that record
 * only when its timing and place agree.
 *
 * The output validates against the base DATEX II v3.7 schemas inside an
 * Exchange 2020 `messageContainer`, but it is NOT SRTI-profile-conformant
 * and NOT NAP-publication-ready — see `docs/datex-conformance.md`. Every
 * location is reduced to a representative point; the publication creator
 * carries one feed-level country.
 *
 * DATEX output cannot carry an effect's vehicle conditions faithfully, so a
 * situation with any vehicle-specific effect, or one that is restriction
 * evidence, is left out rather than exported with a changed meaning.
 */

const SEVERITY: Readonly<Record<string, string>> = {
  none: "none",
  minor: "low",
  moderate: "medium",
  major: "high",
  critical: "highest",
};

/** v3 dropped v2's `improbable`; it travels as an extended value. */
const PROBABILITY: Readonly<Record<string, string | Rec>> = {
  observed: "certain",
  likely: "probable",
  possible: "riskOf",
  unlikely: extended("improbable"),
};

const COMPLIANCE: Readonly<Record<string, string | Rec>> = {
  mandatory: "mandatory",
  advisory: "advisory",
  unknown: extended("unknown"),
};

/** Record classes deriving from `NetworkManagement`, which must state their compliance. */
const NETWORK_MANAGEMENT = new Set([
  "GeneralInstructionOrMessageToRoadUsers",
  "GeneralNetworkManagement",
  "ReroutingManagement",
  "RoadOrCarriagewayOrLaneManagement",
  "SpeedManagement",
  "WinterDrivingManagement",
]);

/** Record classes deriving from `OperatorAction`, which may state the action's status. */
const OPERATOR_ACTIONS = new Set([
  ...NETWORK_MANAGEMENT,
  "ConstructionWorks",
  "MaintenanceWorks",
  "RoadsideAssistance",
]);

/** The kernel's action statuses as `OperatorActionStatusEnum`. */
const ACTION_STATUS: Readonly<Record<NonNullable<Effect["actionStatus"]>, string>> = {
  requested: "requested",
  approved: "approved",
  being_implemented: "beingImplemented",
  implemented: "implemented",
  rejected: "rejected",
  termination_requested: "terminationRequested",
  being_terminated: "beingTerminated",
};

/**
 * The `ValidityStatusEnum` value of a lifecycle. The kernel's `active` leaves
 * the window to decide, which is DATEX `definedByValidityTimeSpec`; DATEX
 * `active` would hold the record in force "regardless of the definition of the
 * validity time specification", even before the start or after the end it
 * exports. `planned` and `suspended` are DATEX's own.
 */
const VALIDITY_STATUS: Readonly<Partial<Record<Validity["status"], string>>> = {
  active: "definedByValidityTimeSpec",
  planned: "planned",
  suspended: "suspended",
};

const CLOSURE_BY_SCOPE: Readonly<Record<string, string>> = {
  carriageway: "carriagewayClosures",
};

/** A DATEX enumeration value outside the schema's list. */
function extended(value: string): Rec {
  return { "@__extendedValue": value, "#text": "_extended" };
}

/** The `Class:discriminator` code DATEX has for an effect, if any. */
function effectCode(effect: Effect): string | undefined {
  switch (effect.kind) {
    case "closure":
      return `RoadOrCarriagewayOrLaneManagement:${CLOSURE_BY_SCOPE[effect.scope] ?? "roadClosed"}`;
    case "lane_restriction":
      if (effect.vehicleImpact === "all_lanes_closed") {
        return "RoadOrCarriagewayOrLaneManagement:roadClosed";
      }
      if (effect.vehicleImpact === "all_lanes_open") return undefined;
      // Lanes restricted in a way no one states, none of them known closed,
      // are managed lanes, not lane closures.
      return effect.vehicleImpact === "unknown" && !((effect.lanesClosed ?? 0) > 0)
        ? "RoadOrCarriagewayOrLaneManagement:other"
        : "RoadOrCarriagewayOrLaneManagement:laneClosures";
    case "contraflow":
      return "RoadOrCarriagewayOrLaneManagement:contraflow";
    case "speed_limit":
      return "SpeedManagement:speedRestrictionInOperation";
    case "detour":
      return "ReroutingManagement:followDiversionSigns";
    default:
      return undefined;
  }
}

/**
 * What an effect says about the record's impact: its lanes. DATEX counts the
 * lanes restricted fully or partially, so closed lanes are restricted ones
 * where no count of restricted lanes is known, and the lanes that remain fully
 * operational are the rest of the total.
 */
function effectImpact(effect: Effect): Rec {
  if (effect.kind !== "lane_restriction") return {};
  const impact: Rec = {};
  const restricted = effect.lanesRestricted ?? effect.lanesClosed;
  if (restricted !== undefined) impact["sit:numberOfLanesRestricted"] = restricted;
  const operational =
    effect.lanesOperational ??
    (effect.lanesTotal !== undefined && restricted !== undefined
      ? effect.lanesTotal - restricted
      : undefined);
  if (operational !== undefined && operational >= 0) {
    impact["sit:numberOfOperationalLanes"] = operational;
  }
  return impact;
}

/** What an effect adds after its record's discriminator: a speed. */
function effectDetail(effect: Effect): Rec {
  return effect.kind === "speed_limit" ? { "sit:temporarySpeedLimit": effect.limit.value } : {};
}

/** First coordinate of any geometry, as [lon, lat]. */
function representativePoint(geometry: unknown): [number, number] | null {
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] } | null;
  if (g?.type === "GeometryCollection") {
    for (const part of g.geometries ?? []) {
      const found = representativePoint(part);
      if (found) return found;
    }
    return null;
  }
  let c: unknown = g?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
    ? [c[0], c[1]]
    : null;
}

/** A road's name, plain in `roadInformation`, so only its first language. */
const roadName = (road: Rec) => (road["name"] as Text | undefined)?.[0];

function buildLocation(
  location: Rec,
  diagnostics: ProjectionDiagnostics,
  path: string,
  effect?: Effect,
  directionPath = path,
): Rec {
  const loc: Rec = { "@_xsi:type": "loc:PointLocation" };
  const roads = ((location["roads"] as Rec[] | undefined) ?? []).flatMap((road) => {
    const info: Rec = {};
    const name = roadName(road)?.text;
    if (name) info["loc:roadName"] = name;
    if (typeof road["ref"] === "string") info["loc:roadNumber"] = road["ref"];
    return Object.keys(info).length > 0 ? [info] : [];
  });
  if (roads.length > 0) {
    loc["loc:supplementaryPositionalDescription"] = { "loc:roadInformation": roads };
  }
  const pt = representativePoint(location["geometry"]);
  if (pt) {
    if ((location["geometry"] as Rec | undefined)?.["type"] !== "Point")
      diagnostics.emit(
        "geometry_to_point",
        "field",
        "reduced",
        `${path}/geometry`,
        "DATEX exports this geometry as its first representative coordinate only.",
        effect,
      );
    loc["loc:pointByCoordinates"] = {
      "loc:pointCoordinates": { "loc:latitude": pt[1], "loc:longitude": pt[0] },
    };
  }
  if (location["direction"] !== undefined)
    diagnostics.emit(
      "direction_not_exported",
      "field",
      "omitted",
      `${directionPath}/direction`,
      "This DATEX emitter does not export location direction.",
      effect,
    );
  return loc;
}

/**
 * DATEX requires a start; without a declared one, the record is valid from
 * `since`, its version time, the earliest moment it is known to hold.
 */
function buildValidity(validity: Validity, since: string): Rec {
  const spec: Rec = { "com:overallStartTime": validity.start ?? since };
  if (validity.end) spec["com:overallEndTime"] = validity.end;
  return {
    "com:validityStatus": VALIDITY_STATUS[validity.status] ?? "definedByValidityTimeSpec",
    "com:validityTimeSpecification": spec,
  };
}

function comment(text: Text): Rec {
  return {
    "sit:comment": {
      "com:values": {
        "com:value": text.map((t) => ({ "@_lang": t.lang, "#text": t.text })),
      },
    },
  };
}

interface RecordHeader {
  id: string;
  version: string;
  time: string;
  probability: string | Rec;
}

interface RecordBody {
  validity: Validity;
  location: Rec;
  /** Severity, the informant and the headline: what only the leading record carries. */
  lead?: { severity?: string; source?: Rec; headline?: Text };
  impact?: Rec;
  compliance?: string;
  actionStatus?: Effect["actionStatus"];
  /** A network management measure's `applicableForTrafficDirection`. */
  trafficDirection?: string;
  /** What roadworks say of the works before their discriminator. */
  works?: Rec;
  detail?: Rec;
}

/** Record classes deriving from `Roadworks`. */
const ROADWORKS = new Set(["ConstructionWorks", "MaintenanceWorks"]);

/**
 * A record of `code` (`Class` or `Class:discriminator`) in schema order: the
 * situation record's elements up to its location, then the class's own —
 * an operator action's status, compliance and the traffic direction for
 * network management, the works' own elements for roadworks, the
 * discriminator and `detail`.
 */
function record(code: string, header: RecordHeader, body: RecordBody): Rec {
  const [cls, value] = code.split(":") as [string, string | undefined];
  const discriminator = datexDiscriminator(cls);
  const { lead, impact } = body;
  return {
    "@_xsi:type": `sit:${cls}`,
    "@_id": header.id,
    "@_version": header.version,
    "sit:situationRecordCreationTime": header.time,
    "sit:situationRecordVersionTime": header.time,
    "sit:probabilityOfOccurrence": header.probability,
    ...(lead?.severity ? { "sit:severity": lead.severity } : {}),
    ...(lead?.source ? { "sit:source": lead.source } : {}),
    "sit:validity": buildValidity(body.validity, header.time),
    ...(impact && Object.keys(impact).length > 0 ? { "sit:impact": impact } : {}),
    ...(lead?.headline?.length ? { "sit:generalPublicComment": comment(lead.headline) } : {}),
    "sit:locationReference": body.location,
    ...(OPERATOR_ACTIONS.has(cls) && body.actionStatus !== undefined
      ? { "sit:operatorActionStatus": ACTION_STATUS[body.actionStatus] }
      : {}),
    ...(NETWORK_MANAGEMENT.has(cls)
      ? {
          "sit:complianceOption": COMPLIANCE[body.compliance ?? "unknown"] ?? COMPLIANCE["unknown"],
          ...(body.trafficDirection !== undefined
            ? { "sit:applicableForTrafficDirection": body.trafficDirection }
            : {}),
        }
      : {}),
    ...(ROADWORKS.has(cls) ? body.works : {}),
    ...(value && discriminator ? { [`sit:${discriminator}`]: value } : {}),
    ...body.detail,
  };
}

/** The kernel's delay bands, delay types and roadworks duration classes, as DATEX writes them. */
const DELAY_BAND: Readonly<Record<string, string>> = {
  negligible: "negligible",
  up_to_ten_minutes: "upToTenMinutes",
  between_ten_minutes_and_thirty_minutes: "betweenTenMinutesAndThirtyMinutes",
  between_thirty_minutes_and_one_hour: "betweenThirtyMinutesAndOneHour",
  between_one_hour_and_three_hours: "betweenOneHourAndThreeHours",
  between_three_hours_and_six_hours: "betweenThreeHoursAndSixHours",
  longer_than_six_hours: "longerThanSixHours",
};
const DELAYS_TYPE: Readonly<Record<string, string>> = {
  delays: "delays",
  delays_of_uncertain_duration: "delaysOfUncertainDuration",
  long_delays: "longDelays",
  very_long_delays: "veryLongDelays",
};
const ROADWORKS_DURATION: Readonly<Record<string, string>> = {
  long_term: "longTerm",
  medium_term: "mediumTerm",
  short_term: "shortTerm",
};
/** snake_case → camelCase, which is how the kernel's informant types derive from DATEX's. */
const camelCase = (token: string) => token.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * A delay effect as DATEX `delays`, in schema order: its band, its
 * description and its length.
 */
function delaysOf(effect: Extract<Effect, { kind: "delay" }>): Rec | undefined {
  const out: Rec = {
    ...(effect.delayBand !== undefined ? { "sit:delayBand": DELAY_BAND[effect.delayBand] } : {}),
    ...(effect.delayType !== undefined ? { "sit:delaysType": DELAYS_TYPE[effect.delayType] } : {}),
    ...(effect.delay !== undefined ? { "sit:delayTimeValue": effect.delay.value } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The works' own elements of a roadworks nature record, in schema order:
 * duration class, scale, whether under traffic, whether urgent.
 */
function worksOf(details: Rec | undefined): Rec {
  if (details?.["kind"] !== "roadworks") return {};
  const durationClass = details["durationClass"];
  const scale = details["scale"];
  return {
    ...(typeof durationClass === "string" && ROADWORKS_DURATION[durationClass]
      ? { "sit:roadworksDurationClassification": ROADWORKS_DURATION[durationClass] }
      : {}),
    ...(typeof scale === "string" ? { "sit:roadworksScale": scale } : {}),
    ...(typeof details["underTraffic"] === "boolean"
      ? { "sit:underTraffic": details["underTraffic"] }
      : {}),
    ...(typeof details["urgent"] === "boolean" ? { "sit:urgentRoadworks": details["urgent"] } : {}),
  };
}

/** The situation's informant as DATEX `source`, in schema order. */
function sourceOf(provenance: Rec | undefined): Rec | undefined {
  const s = provenance?.["informationSource"] as InformationSource | undefined;
  if (s === undefined) return undefined;
  const out: Rec = {
    ...(s.country !== undefined ? { "com:sourceCountry": s.country.toLowerCase() } : {}),
    ...(s.id !== undefined ? { "com:sourceIdentification": s.id } : {}),
    ...(s.name !== undefined
      ? {
          "com:sourceName": {
            "com:values": {
              "com:value": s.name.map((t) => ({ "@_lang": t.lang, "#text": t.text })),
            },
          },
        }
      : {}),
    ...(s.type !== undefined ? { "com:sourceType": camelCase(s.type) } : {}),
    ...(s.reliable !== undefined ? { "com:reliable": s.reliable } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** DATEX `DirectionEnum` values for a compass point. */
const COMPASS_BOUND: Readonly<Record<string, string>> = {
  N: "northBound",
  NE: "northEastBound",
  E: "eastBound",
  SE: "southEastBound",
  S: "southBound",
  SW: "southWestBound",
  W: "westBound",
  NW: "northWestBound",
};

/** DATEX `DirectionEnum` values an effect's direction keeps as its text. */
const DIRECTION_WORDS = new Set([
  "allDirections",
  "bothWays",
  "clockwise",
  "anticlockwise",
  "innerRing",
  "outerRing",
  "inboundTowardsTown",
  "outboundFromTown",
]);

/**
 * An effect's own direction as `applicableForTrafficDirection`: a compass
 * heading, or one of the axisless DATEX directions it keeps as its text. A
 * direction along a reference axis is not, as the export's point locations
 * carry no axis for it to align with.
 */
function trafficDirectionOf(effect: Effect): string | undefined {
  const d = effect.direction;
  if (d === undefined) return undefined;
  if (d.basis === "compass" && d.compass !== undefined) return COMPASS_BOUND[d.compass];
  if (d.basis === "text" && d.text !== undefined && DIRECTION_WORDS.has(d.text)) return d.text;
  return undefined;
}

/** The DATEX record a classification has of its own: subtype's, else type's. */
function natureRecordCode(c: SituationClass): string | undefined {
  const type = `${c.kind}.${c.type}`;
  const code = c.subtype ? DATEX2_RECORDS[`${type}.${c.subtype}`] : undefined;
  return (code ?? DATEX2_RECORDS[type]) || undefined;
}

/** What a nature record names beyond its discriminator: a fault's equipment. */
function natureDetail(c: SituationClass, code: string): Rec {
  if (!code.startsWith("EquipmentOrSystemFault")) return {};
  const equipment = DATEX2_FAULTY_EQUIPMENT[`${c.kind}.${c.type}.${c.subtype}`] ?? "other";
  return { "sit:faultyEquipmentOrSystemType": equipment };
}

/** The DATEX records of a situation at `at`; none when DATEX cannot tell it truthfully. */
export function datexRecordsOf(situation: Rec, at: Date, report?: ExportDiagnosticSink): Rec[] {
  const effects = projectionEffects(situation);
  const diagnostics = new ProjectionDiagnostics(situation, report);
  if (diagnostics.blocked("datex")) return [];
  const id = situation["id"] as string;
  const version = String(situation["revision"] ?? 1);
  const validity = situation["validity"] as Validity;
  const provenance = situation["provenance"] as Rec;
  const freshness = situation["freshness"] as Rec;
  const time =
    (provenance["sourceUpdatedAt"] as string | undefined) ?? (freshness["fetchedAt"] as string);
  let location: Rec | undefined;
  const rootLocation = () =>
    (location ??= buildLocation(situation["location"] as Rec, diagnostics, "/location"));
  const probability = PROBABILITY[String(situation["certainty"])] ?? "certain";

  // What the situation says as a whole travels on its leading record.
  const lead = {
    severity: SEVERITY[String((situation["severity"] as Rec | undefined)?.["label"])],
    source: sourceOf(provenance),
    headline: situation["headline"] as Text | undefined,
  };
  const classification = situation as unknown as SituationClass;
  const natureCode = natureRecordCode(classification);
  // A classification must not recreate a filtered restriction at the root place.
  const natureRepresented = effects.some(
    ({ effect }) =>
      natureCode !== undefined &&
      (definesManagementNature(situation, effect) || effectCode(effect) === natureCode),
  );
  let folded: ProjectionEffect | undefined;
  const pending: {
    code: string;
    header: RecordHeader;
    body: RecordBody;
    context: ProjectionEffect;
  }[] = [];
  for (const context of effects) {
    const { effect, validity: effectWindow } = context;
    if (effect.kind === "delay") continue;
    const projected = projectionStateAt(context, at, true);
    const { state } = projected;
    const path = diagnostics.effectPath(effect);
    if (state === "ended" || state === "unknown") {
      diagnostics.emit(
        state === "ended" ? "effect_ended" : "effect_time_unknown",
        "effect",
        "omitted",
        omittedPath(context, projected, path),
        `No management record is exported for this effect at the evaluation instant: ${state}.`,
        effect,
      );
      continue;
    }
    const code = effectCode(effect);
    if (code === undefined) {
      diagnostics.emit(
        "unsupported_effect",
        "effect",
        "omitted",
        `${path}/kind`,
        "This effect has no DATEX management record mapping in the current emitter.",
        effect,
      );
      continue;
    }
    // Every record an effect has is network management, which states the
    // directions of traffic it applies to; one along a reference axis has
    // none it can state.
    if (effect.direction !== undefined && trafficDirectionOf(effect) === undefined)
      diagnostics.emit(
        "direction_not_exported",
        "field",
        "omitted",
        `${path}/direction`,
        "This DATEX emitter does not export an effect direction along a reference axis.",
        effect,
      );
    const place = ownPlace(situation, effect);
    if (place === undefined && effect.location?.direction !== undefined)
      diagnostics.emit(
        "direction_not_exported",
        "field",
        "omitted",
        `${path}/location/direction`,
        "This DATEX emitter does not export effect location direction.",
        effect,
      );
    // Only one effect may supply the nature record: never combine independent
    // values, compliance, impact or validity into a synthetic restriction.
    if (code === natureCode && place === undefined && folded === undefined) {
      folded = context;
      continue;
    }
    pending.push({
      code,
      context,
      header: { id: effect.sourceRecordRef ?? `${id}#${effect.id}`, version, time, probability },
      body: {
        validity: effectWindow,
        location:
          place === undefined
            ? rootLocation()
            : buildLocation(
                place,
                diagnostics,
                `${path}/location`,
                effect,
                effect.location?.direction === undefined ? "/location" : `${path}/location`,
              ),
        impact: effectImpact(effect),
        compliance: effect.compliance,
        actionStatus: effect.actionStatus,
        trafficDirection: trafficDirectionOf(effect),
        detail: effectDetail(effect),
      },
    });
  }
  const hasNature = natureCode !== undefined && (!natureRepresented || folded !== undefined);
  if (natureCode === undefined)
    diagnostics.emit(
      "unsupported_nature",
      "field",
      "omitted",
      "/type",
      "This situation classification has no DATEX nature record mapping in the current emitter.",
    );
  const bodies = hasNature
    ? [
        {
          code: natureCode!,
          header: { id, version, time, probability },
          context: folded,
          body: {
            validity: folded?.validity ?? validity,
            location: rootLocation(),
            impact: folded ? effectImpact(folded.effect) : {},
            compliance: folded?.effect.compliance,
            actionStatus: folded?.effect.actionStatus,
            trafficDirection: folded ? trafficDirectionOf(folded.effect) : undefined,
            works: worksOf(situation["details"] as Rec | undefined),
            detail: {
              ...natureDetail(classification, natureCode!),
              ...(folded ? effectDetail(folded.effect) : {}),
            },
          } as RecordBody,
        },
        ...pending,
      ]
    : pending;
  const leading = bodies[0];
  const delays: ProjectionEffect[] = [];
  for (const context of effects.filter(({ effect }) => effect.kind === "delay")) {
    const { effect, validity: delayWindow } = context;
    const projected = projectionStateAt(context, at, true);
    const { state } = projected;
    const path = diagnostics.effectPath(effect);
    if (state === "ended" || state === "unknown") {
      diagnostics.emit(
        state === "ended" ? "effect_ended" : "effect_time_unknown",
        "effect",
        "omitted",
        omittedPath(context, projected, path),
        `This delay supplement is not exported at the evaluation instant: ${state}.`,
        effect,
      );
    } else if (
      !leading ||
      ownPlace(situation, effect) !== undefined ||
      (leading.context && ownPlace(situation, leading.context.effect) !== undefined) ||
      !sameInterval(delayWindow, leading.body.validity) ||
      delayWindow.status !== leading.body.validity.status
    ) {
      diagnostics.emit(
        "field_not_exported",
        "field",
        "omitted",
        `${path}/delay`,
        "This delay cannot supplement the leading record: its place, interval or lifecycle differs, or no leading record is available.",
        effect,
      );
    } else if (effect.kind === "delay" && delaysOf(effect) !== undefined) delays.push(context);
  }
  // A leading record has only one delay slot. Never choose among conflicting observations.
  const values = new Set(
    delays.map(({ effect }) =>
      JSON.stringify(effect.kind === "delay" ? delaysOf(effect) : undefined),
    ),
  );
  if (values.size > 1) {
    for (const { effect } of delays)
      diagnostics.emit(
        "conflicting_effects",
        "field",
        "omitted",
        `${diagnostics.effectPath(effect)}/delay`,
        "Different delays cannot share the leading DATEX record's single supplement.",
        effect,
      );
  } else if (leading && delays[0]?.effect.kind === "delay") {
    leading.body.impact = { ...leading.body.impact, "sit:delays": delaysOf(delays[0].effect) };
  }
  if (leading) leading.body.lead = lead;
  return bodies.map(({ code, header, body }) => record(code, header, body));
}

/**
 * The place an effect holds at when it is not its situation's: its own
 * geometry with the situation's road references.
 */
function ownPlace(situation: Rec, effect: Effect): Rec | undefined {
  const own = effect.location as Rec | undefined;
  if (own?.["geometry"] == null) return undefined;
  return { ...(situation["location"] as Rec), ...own };
}

/**
 * The payload's `lang`, the default language of its text: the one language of
 * every headline and road name written, `mul` when they differ, `und` when
 * there is none. Each headline value still states its own.
 */
function publicationLang(situations: readonly Rec[]): string {
  const langs = new Set<string>();
  for (const situation of situations) {
    for (const t of (situation["headline"] as Text | undefined) ?? []) langs.add(t.lang);
    const places = [situation["location"], ...situationEffects(situation).map((e) => e.location)];
    for (const place of places as (Rec | undefined)[]) {
      for (const road of (place?.["roads"] as Rec[] | undefined) ?? []) {
        const name = roadName(road);
        if (name) langs.add(name.lang);
      }
    }
  }
  const [only, ...more] = langs;
  if (only === undefined) return "und";
  return more.length > 0 ? "mul" : only;
}

/**
 * Projects situations to a DATEX II v3 `SituationPublication` in an Exchange
 * 2020 snapshot-pull `messageContainer`, evaluated at `at`. `info.timestamp`
 * sets the publication and message time (else `at`); `info.attribution` the
 * national identifier. `country` is the feed-level publication-creator
 * country code (ISO 3166-1 α-2); the default `zz` is the user-assigned code
 * for an aggregate that spans countries.
 */
export function situationsToDatex(
  situations: readonly Rec[],
  at: Date = new Date(),
  info: FeedInfo = {},
  country = "zz",
): string {
  const time = info.timestamp ?? at.toISOString();
  const creator = {
    "com:country": country,
    "com:nationalIdentifier": info.attribution ?? "OpenConditions",
  };
  const exported = situations.flatMap((situation) => {
    const records = datexRecordsOf(situation, at);
    return records.length > 0 ? [{ situation, records }] : [];
  });
  const payload: Rec = {
    "@_xsi:type": "sit:SituationPublication",
    "@_lang": publicationLang(exported.map((e) => e.situation)),
    "@_modelBaseVersion": "3",
    "com:publicationTime": time,
    "com:publicationCreator": creator,
  };
  payload["sit:situation"] = exported.map(({ situation, records }) => ({
    "@_id": situation["id"],
    "sit:headerInformation": {
      "com:confidentiality": "noRestriction",
      "com:informationStatus": "real",
    },
    "sit:situationRecord": records,
  }));
  const doc = {
    messageContainer: {
      "@_xmlns": "http://datex2.eu/schema/3/messageContainer",
      "@_xmlns:com": "http://datex2.eu/schema/3/common",
      "@_xmlns:ex": "http://datex2.eu/schema/3/exchangeInformation",
      "@_xmlns:loc": "http://datex2.eu/schema/3/locationReferencing",
      "@_xmlns:sit": "http://datex2.eu/schema/3/situation",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_modelBaseVersion": "3",
      payload,
      exchangeInformation: {
        "@_modelBaseVersion": "3",
        "ex:exchangeContext": {
          "ex:codedExchangeProtocol": "snapshotPull",
          "ex:exchangeSpecificationVersion": "2020.1",
          "ex:supplierOrCisRequester": { "ex:internationalIdentifier": creator },
        },
        "ex:dynamicInformation": {
          "ex:exchangeStatus": "online",
          "ex:messageGenerationTimestamp": time,
        },
      },
    },
  };
  return buildXmlDocument(doc);
}
