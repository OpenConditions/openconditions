import { type MappingTarget, parseSituationCode, type SituationClass } from "@openconditions/model";
import { CAUSE_NATURES } from "./cause-natures.js";
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
