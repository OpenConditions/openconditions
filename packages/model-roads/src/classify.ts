import { type MappingTarget, parseSituationCode, type SituationClass } from "@openconditions/model";
import { CAUSE_NATURES } from "./cause-natures.js";
import {
  AUTOBAHN_SITUATIONS,
  DIGITRAFFIC_SITUATIONS,
  GDDKIA_SITUATIONS,
  LTA_SITUATIONS,
  OHGO_SITUATIONS,
  TRAFIKVERKET_SITUATIONS,
  VIC_SITUATIONS,
} from "./crosswalk/providers.js";
import { ROADS_SITUATION_KINDS } from "./kinds.js";
import { roadsCrosswalk } from "./module.js";
import { DATEX2_V2, DATEX2_V3 } from "./vocabularies/datex2.js";

/** A classification plus the causes the source states, ready for a situation draft. */
export interface RoadClassification extends SituationClass {
  causes?: string[];
}

type Discriminators = Record<string, { element: string }>;

/**
 * The typed discriminator element of a DATEX record class (`accidentType` for
 * `Accident`), v3 first; undefined for classes without one.
 */
export function datexDiscriminator(recordClass: string): string | undefined {
  return (
    (DATEX2_V3.discriminators as Discriminators)[recordClass]?.element ??
    (DATEX2_V2.discriminators as Discriminators)[recordClass]?.element
  );
}

function lookup(targets: readonly MappingTarget[], codes: readonly string[]) {
  for (const code of codes) {
    for (const target of targets) {
      const c = roadsCrosswalk.situation(target, code);
      if (c !== undefined) return c;
    }
  }
  return undefined;
}

function causesOf(targets: readonly MappingTarget[], codes: readonly string[]) {
  const causes: string[] = [];
  for (const code of codes) {
    for (const target of targets) {
      const cause = roadsCrosswalk.value("cause", target, code);
      if (cause !== undefined) {
        if (!causes.includes(cause)) causes.push(cause);
        break;
      }
    }
  }
  return causes;
}

const DATEX: readonly MappingTarget[] = ["datex2_v3", "datex2_v2"];

/**
 * A DATEX record's classification: the first discriminator value that refines
 * the record class, else the class itself; undefined for a class neither
 * version knows. `causeTypes` are the record's `cause/causeType` values.
 */
export function datexClassification(
  recordClass: string,
  discriminatorValues: readonly string[],
  causeTypes: readonly string[] = [],
): RoadClassification | undefined {
  const c = lookup(DATEX, [...discriminatorValues.map((v) => `${recordClass}:${v}`), recordClass]);
  if (c === undefined) return undefined;
  const causes = causesOf(DATEX, causeTypes);
  return causes.length > 0 ? { ...c, causes } : c;
}

/**
 * A WZDx road event's classification from its event type and, for a work zone
 * its types of work, for a restriction event its restriction types. A work
 * zone's restrictions are its effects, never its nature.
 */
export function wzdxClassification(
  eventType: string,
  typesOfWork: readonly string[] = [],
  restrictionTypes: readonly string[] = [],
): RoadClassification | undefined {
  const refinements =
    eventType === "restriction"
      ? restrictionTypes.map((t) => `restriction:${t}`)
      : typesOfWork.map((t) => `${eventType}:${t}`);
  return lookup(["wzdx"], [...refinements, eventType]);
}

/** An Open511 event's classification: a subtype first, then the event type. */
export function open511Classification(
  eventType: string,
  subtypes: readonly string[] = [],
): RoadClassification | undefined {
  return lookup(["open511"], [...subtypes, eventType]);
}

/**
 * The nature stated causes imply, for a situation none of whose records names
 * one: the first cause with a nature decides (see CAUSE_NATURES).
 */
export function natureFromCauses(causes: readonly string[]): RoadClassification | undefined {
  for (const cause of causes) {
    const code = CAUSE_NATURES[cause];
    if (code) return { ...parseSituationCode(code), causes: [...causes] };
  }
  return undefined;
}

/** An IBI 511 event's classification from its `EventType`. */
export function ibi511Classification(eventType: string): RoadClassification | undefined {
  return lookup(["ibi511"], [eventType]);
}

/**
 * The classification a `kind.type[.subtype]` code names, when the roads
 * situation kinds register it; undefined for anything else.
 */
export function registeredClassification(code: string): RoadClassification | undefined {
  let c: SituationClass;
  try {
    c = parseSituationCode(code);
  } catch {
    return undefined;
  }
  const subtypes = (
    ROADS_SITUATION_KINDS.find((k) => k.code === c.kind)?.types as
      | Readonly<Record<string, readonly string[]>>
      | undefined
  )?.[c.type];
  if (subtypes === undefined || (c.subtype !== undefined && !subtypes.includes(c.subtype))) {
    return undefined;
  }
  return c;
}

/** The first code a provider table classifies; a `null` entry passes to the next code. */
function fromTable(
  table: Readonly<Record<string, string | null>>,
  codes: readonly string[],
): RoadClassification | undefined {
  for (const code of codes) {
    const target = Object.hasOwn(table, code) ? table[code] : null;
    if (target) return parseSituationCode(target);
  }
  return undefined;
}

/**
 * A Digitraffic traffic message's classification from its normalised
 * `situationType`, the announcement type of a traffic announcement, and a
 * road work's work types (first refining one wins).
 */
export function digitrafficClassification(
  situationType: string,
  announcementType?: string,
  workTypes: readonly string[] = [],
): RoadClassification | undefined {
  return fromTable(DIGITRAFFIC_SITUATIONS, [
    ...workTypes.map((t) => `${situationType}:${t}`),
    ...(announcementType ? [announcementType] : []),
    situationType,
  ]);
}

/** An LTA traffic incident's classification from its `Type`. */
export function ltaClassification(type: string): RoadClassification | undefined {
  return fromTable(LTA_SITUATIONS, [type.trim().toLowerCase()]);
}

/** A GDDKiA obstruction's classification: a bridge failure, else its `typ`. */
export function gddkiaClassification(
  typ: string | undefined,
  bridgeFailure: boolean,
): RoadClassification | undefined {
  return fromTable(GDDKIA_SITUATIONS, [
    ...(bridgeFailure ? ["awaria_mostu"] : []),
    ...(typ ? [typ.trim()] : []),
  ]);
}

/** A Trafikverket deviation's classification from its `MessageType`. */
export function trafikverketClassification(messageType: string): RoadClassification | undefined {
  return fromTable(TRAFIKVERKET_SITUATIONS, [messageType.trim().toLowerCase()]);
}

/**
 * An Autobahn item's classification: a traffic-flow item is congestion,
 * refined by its `abnormalTrafficType`; any other item reads its `display_type`.
 */
export function autobahnClassification(
  displayType: string | undefined,
  flow?: { abnormalTrafficType?: string },
): RoadClassification | undefined {
  if (flow !== undefined) {
    const refined = flow.abnormalTrafficType ? [`congestion:${flow.abnormalTrafficType}`] : [];
    return fromTable(AUTOBAHN_SITUATIONS, [...refined, "congestion"]);
  }
  return displayType ? fromTable(AUTOBAHN_SITUATIONS, [displayType]) : undefined;
}

/** An OHGO record's classification: a work zone by its category, an incident by its category. */
export function ohgoClassification(
  category: string | undefined,
  workZone: boolean,
): RoadClassification | undefined {
  const c = category?.trim().toLowerCase();
  if (workZone) {
    return fromTable(OHGO_SITUATIONS, [...(c ? [`construction:${c}`] : []), "construction"]);
  }
  return c ? fromTable(OHGO_SITUATIONS, [c]) : undefined;
}

/** A Victoria disruption's classification from its candidate tokens, most specific first. */
export function vicClassification(
  ...candidates: (string | undefined)[]
): RoadClassification | undefined {
  return fromTable(
    VIC_SITUATIONS,
    candidates.flatMap((c) => (c ? [c.trim().toLowerCase()] : [])),
  );
}
