import type { Schedule } from "@openconditions/core";
import type {
  RestrictionIssue,
  RestrictionTokens,
  RoadRestrictionDetailsV1,
  RoadRestrictionFact,
} from "./restriction-types.js";
import {
  intersectRestrictionWindows,
  normalizeRestrictionDimension,
  toRestrictionInstant,
} from "./restrictions.js";
import type { SourceDescriptor } from "./types.js";
import {
  getXmlAttribute,
  getXmlChild,
  getXmlChildren,
  getXmlChildText,
  isXmlObject,
  stripXmlNamespace,
  type XmlObject,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

/**
 * Normalizes DATEX II vehicle applicability into the shared restriction
 * contract.
 *
 * Only predicates published under the measure's own
 * `forVehiclesWithCharacteristicsOf` role are applicability. Vehicles that are
 * obstructing the road, involved in an accident or otherwise described by the
 * record are participants: they say nothing about which vehicles a measure
 * applies to, and they never reach this module.
 *
 * Normalization is deliberately narrow. A leaf whose name resembles a supported
 * dimension is not evidence that its unit and comparator semantics were
 * verified, so only the demonstrated height/class/usage forms produce facts and
 * everything else is retained as an explicit issue.
 */

/** Source comparison operators with a verified contract equivalent. */
const OPERATOR_MAP = { greaterThan: "gt" } as const;

/** Source vehicle-type tokens with a verified contract class. */
const TYPE_MAP = { lorry: "truck" } as const;

/** Source vehicle-usage tokens with a verified contract usage. */
const USAGE_MAP = { emergencyServices: "emergency_services" } as const;

/**
 * Structural wrappers that group characteristics without being one. DATEX v3
 * publishers may place characteristics directly under the applicability role or
 * inside a `vehicleCharacteristics` container; both are the same group.
 */
const GROUP_WRAPPERS = new Set(["vehicleCharacteristics"]);

/** Source validity statuses whose active meaning is established. */
const ACTIVE_VALIDITY_STATUSES = new Set(["active", "definedByValidityTimeSpec"]);

/**
 * The strict XML decimal lexical space. Hex, exponents, `Infinity`, `NaN`,
 * empty values and trailing junk are not decimals, so they never reach
 * `Number()` where they would silently become a plausible measurement.
 */
const XML_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function decimalOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!XML_DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  const t = xmlText(value);
  return typeof t === "string" && t.trim() !== "" ? t.trim() : null;
}

/** Local element names of a node's children, ignoring attributes. */
function localNames(node: XmlObject): string[] {
  return Object.keys(node)
    .filter((key) => !key.startsWith("@_"))
    .map(stripXmlNamespace);
}

function childByLocalName(node: XmlObject, localName: string): unknown {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (stripXmlNamespace(key) === localName) return value;
  }
  return undefined;
}

function leafText(node: XmlObject, localName: string): string | null {
  return text(childByLocalName(node, localName));
}

/**
 * Flatten one applicability group into its characteristic containers: the group
 * itself plus any `vehicleCharacteristics` wrappers inside it. This is a single
 * declared level, not a recursive search of the record.
 */
function containersOf(group: XmlObject): XmlObject[] {
  const out: XmlObject[] = [group];
  for (const wrapper of GROUP_WRAPPERS) {
    for (const node of xmlNodeToArray(childByLocalName(group, wrapper))) {
      if (isXmlObject(node)) out.push(node);
    }
  }
  return out;
}

/** The kind-specific half of a fact; the rest is shared record context. */
type FactKindFields =
  | Pick<
      Extract<RoadRestrictionFact, { kind: "dimension" }>,
      "kind" | "dimension" | "meaning" | "value" | "unit" | "operator"
    >
  | Pick<Extract<RoadRestrictionFact, { kind: "vehicle_class" }>, "kind" | "meaning" | "value">
  | Pick<Extract<RoadRestrictionFact, { kind: "vehicle_usage" }>, "kind" | "meaning" | "value">;

/** One characteristic found inside an applicability group. */
interface Characteristic {
  name: string;
  node: unknown;
}

function characteristicsOf(group: XmlObject): Characteristic[] {
  const out: Characteristic[] = [];
  for (const container of containersOf(group)) {
    for (const name of localNames(container)) {
      if (GROUP_WRAPPERS.has(name)) continue;
      for (const node of xmlNodeToArray(childByLocalName(container, name))) {
        out.push({ name, node });
      }
    }
  }
  return out;
}

function commentsOf(rec: XmlObject): Array<{ text: string; language: string | null }> | undefined {
  const out: Array<{ text: string; language: string | null }> = [];
  const seen = new Set<string>();
  for (const gpc of getXmlChildren(rec, "generalPublicComment")) {
    for (const comment of [gpc, ...getXmlChildren(gpc, "comment")]) {
      for (const values of getXmlChildren(comment, "values")) {
        for (const value of xmlNodeToArray(childByLocalName(values, "value"))) {
          const body = text(value);
          if (body === null || seen.has(body)) continue;
          seen.add(body);
          out.push({ text: body, language: getXmlAttribute(value, "lang") ?? null });
        }
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function complianceOf(rec: XmlObject): "mandatory" | "advisory" | "unknown" {
  const raw = getXmlChildText(rec, "complianceOption");
  if (raw === "mandatory") return "mandatory";
  if (raw === "advisory") return "advisory";
  return "unknown";
}

/** The record's own source identity, retained without interpretation. */
function sourceNameOf(rec: XmlObject): string | null {
  for (const source of getXmlChildren(rec, "source")) {
    const names = commentsOf(source);
    if (names !== undefined) return names[0]!.text;
    for (const nameNode of getXmlChildren(source, "sourceName")) {
      for (const values of getXmlChildren(nameNode, "values")) {
        for (const value of xmlNodeToArray(childByLocalName(values, "value"))) {
          const body = text(value);
          if (body !== null) return body;
        }
      }
    }
  }
  return null;
}

/**
 * Everything the caller already extracted for the parent record. Direction,
 * location references and the schedule come from the record's selected location
 * so this module never re-derives them from an unrelated subtree.
 */
export interface DatexRestrictionContext {
  recordId: string;
  recordVersion: string | null;
  sourceUpdatedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  direction: RoadRestrictionFact["direction"];
  locationDescription: string | null;
  sourceLocationRefs: Record<string, unknown>;
  schedule?: Schedule[];
  issues: RestrictionIssue[];
}

/**
 * The record's normalized applicability, or `undefined` when the record makes
 * no applicability claim at all. `undefined` is not an empty envelope: an empty
 * envelope is a partial claim that still excludes the record from shared
 * routing.
 */
export function datexRestrictionDetails(
  rec: XmlObject,
  src: SourceDescriptor,
  context: DatexRestrictionContext,
): RoadRestrictionDetailsV1 | undefined {
  // An applicability element that parsed to nothing (`<...OfVehicles/>`) is
  // still a claim that the measure is conditional. Counting only well-formed
  // groups here would turn "we could not read the condition" into "no condition
  // was published", which downstream reads as applying to every vehicle.
  const declaredGroups = xmlNodeToArray(
    childByLocalName(rec, "forVehiclesWithCharacteristicsOf"),
  ).length;
  const groups = getXmlChildren(rec, "forVehiclesWithCharacteristicsOf");
  const inherited = context.issues;
  if (declaredGroups === 0 && inherited.length === 0) return undefined;

  // Rights travel with every published fact, so a source without a licence URL
  // cannot publish rights-bearing restriction evidence at all.
  const licenseUrl = src.licenseUrl ?? null;
  if (context.recordId === "" || licenseUrl === null) return undefined;

  const facts: RoadRestrictionFact[] = [];
  const issues: RestrictionIssue[] = [...inherited];
  const comments = commentsOf(rec);
  const sourceName = sourceNameOf(rec);
  const compliance = complianceOf(rec);
  const operatorActionStatus = getXmlChildText(rec, "operatorActionStatus") ?? null;
  const validityStatus = getXmlChildText(getXmlChild(rec, "validity"), "validityStatus") ?? null;

  const intersection = intersectRestrictionWindows([
    { validFrom: context.validFrom, validTo: context.validTo },
  ]);
  const windowBroken = intersection.issue !== undefined;

  const baseContext = {
    restrictionsLiftable: null,
    compliance,
    operatorActionStatus,
    validityStatus,
    ...(comments !== undefined ? { comments } : {}),
  };

  // Only a measure the operator says is in place, under a validity status this
  // release recognizes, may be labelled active. `beingTerminated` is not proof
  // that a restriction has already ended, and a missing status is not proof
  // that it is in force — both stay explicitly uncertain.
  const allowsActive =
    operatorActionStatus === "implemented" && ACTIVE_VALIDITY_STATUSES.has(validityStatus ?? "");
  if (!allowsActive) {
    issues.push({
      code: "unsupported_status",
      factId: null,
      sourcePath: "situationRecord.operatorActionStatus/validity.validityStatus",
      sourceTokens: { operatorActionStatus, validityStatus },
    });
  }

  /** Groups needing AND/OR/exception semantics this release does not establish. */
  if (declaredGroups > 1) {
    issues.push({
      code: "compound_condition",
      factId: null,
      sourcePath: "situationRecord.forVehiclesWithCharacteristicsOf",
      sourceTokens: { groupCount: declaredGroups },
    });
  }

  /** A declared group that carried no readable characteristic at all. */
  if (declaredGroups > groups.length) {
    issues.push({
      code: "compound_condition",
      factId: null,
      sourcePath: "situationRecord.forVehiclesWithCharacteristicsOf",
      sourceTokens: { declaredGroups, readableGroups: groups.length },
    });
  }

  groups.forEach((group, groupIndex) => {
    const groupPath = `situationRecord.forVehiclesWithCharacteristicsOf[${groupIndex}]`;
    const characteristics = characteristicsOf(group);
    if (characteristics.length === 0) {
      issues.push({
        code: "compound_condition",
        factId: null,
        sourcePath: groupPath,
        sourceTokens: { characteristicCount: 0 },
      });
      return;
    }
    if (characteristics.length > 1) {
      issues.push({
        code: "compound_condition",
        factId: null,
        sourcePath: groupPath,
        sourceTokens: {
          characteristicCount: characteristics.length,
          characteristics: characteristics.map((c) => c.name),
        },
      });
    }

    characteristics.forEach((characteristic, index) => {
      const sourcePath = `${groupPath}.${characteristic.name}[${index}]`;
      const factId = `${context.recordId}:event:event_road:${sourcePath}`;
      const push = (specific: FactKindFields) => {
        facts.push({
          id: factId,
          ...specific,
          scope: {
            kind: "event_road",
            phaseId: null,
            locationDescription: context.locationDescription,
            sourceLocationRefs: context.sourceLocationRefs,
            restrictionBinding: "not_established",
          },
          direction: context.direction,
          validFrom: windowBroken ? null : intersection.window.validFrom,
          validTo: windowBroken ? null : intersection.window.validTo,
          ...(context.schedule !== undefined ? { schedule: context.schedule } : {}),
          sourceTokens: {
            sourcePath,
            ...(sourceName !== null ? { sourceName } : {}),
            ...tokensFor(characteristic),
          },
          context: baseContext,
        });
      };

      if (characteristic.name === "heightCharacteristic") {
        const node = characteristic.node;
        if (!isXmlObject(node)) {
          issues.push({ code: "invalid_value", factId, sourcePath });
          return;
        }
        const rawOperator = leafText(node, "comparisonOperator");
        const operator =
          rawOperator === null ? undefined : OPERATOR_MAP[rawOperator as "greaterThan"];
        if (operator === undefined) {
          issues.push({
            code: "unsupported_operator",
            factId,
            sourcePath,
            ...(rawOperator !== null ? { sourceText: rawOperator } : {}),
            sourceTokens: { comparisonOperator: rawOperator },
          });
          return;
        }
        const rawValue = leafText(node, "vehicleHeight");
        const normalized = normalizeRestrictionDimension({
          dimension: "height",
          value: decimalOf(rawValue ?? undefined),
          unit: "m",
        });
        if (normalized === null) {
          issues.push({
            code: "invalid_value",
            factId,
            sourcePath,
            ...(rawValue !== null ? { sourceText: rawValue } : {}),
            sourceTokens: { vehicleHeight: rawValue, comparisonOperator: rawOperator },
          });
          return;
        }
        push({
          kind: "dimension",
          dimension: "height",
          meaning: "event_applies_when",
          value: normalized.value,
          unit: normalized.unit,
          operator,
        });
        return;
      }

      if (characteristic.name === "vehicleType" || characteristic.name === "vehicleUsage") {
        const raw = text(characteristic.node);
        const mapped =
          characteristic.name === "vehicleType"
            ? TYPE_MAP[raw as "lorry"]
            : USAGE_MAP[raw as "emergencyServices"];
        if (raw === null || mapped === undefined) {
          issues.push({
            code: "unknown_vehicle",
            factId,
            sourcePath,
            ...(raw !== null ? { sourceText: raw } : {}),
            sourceTokens: { [characteristic.name]: raw },
          });
          return;
        }
        push(
          characteristic.name === "vehicleType"
            ? { kind: "vehicle_class", meaning: "event_applies_when", value: "truck" }
            : { kind: "vehicle_usage", meaning: "event_applies_when", value: "emergency_services" },
        );
        return;
      }

      // A dimension-shaped or otherwise unfamiliar predicate. Its unit and
      // comparator meaning are unverified for this source, so it stays context.
      issues.push({
        code: "unsupported_type",
        factId: null,
        sourcePath,
        sourceText: characteristic.name,
        sourceTokens: tokensFor(characteristic),
      });
    });
  });

  if (windowBroken) {
    issues.push({
      code: "invalid_window",
      factId: null,
      sourcePath: "situationRecord.validity.validityTimeSpecification",
      sourceTokens: { validFrom: context.validFrom, validTo: context.validTo },
    });
  }

  if (facts.length === 0 && issues.length === 0) return undefined;

  return {
    schemaVersion: 1,
    vehicleScope: facts.length > 0 ? "specific" : "unknown",
    completeness: issues.length === 0 ? "complete" : "partial",
    facts,
    issues,
    source: {
      sourceId: src.id,
      recordId: context.recordId,
      recordVersion: context.recordVersion,
      sourceUpdatedAt: toRestrictionInstant(context.sourceUpdatedAt),
      // The trusted feed descriptor supplies the canonical endpoint list at
      // publication time; a parser cannot know which partition served a record.
      feedUrls: [],
      publisher: src.attribution,
      license: src.license,
      licenseUrl,
      attribution: src.attribution,
      modificationNotice:
        "Normalized by OpenConditions; source units and structure may be transformed.",
      ...(sourceName !== null ? { notices: [sourceName] } : {}),
    },
  };
}

/** A bounded bag of the characteristic's own original tokens. */
function tokensFor(characteristic: Characteristic): RestrictionTokens {
  const node = characteristic.node;
  if (!isXmlObject(node)) return { [characteristic.name]: text(node) };
  const out: RestrictionTokens = {};
  for (const name of localNames(node)) {
    out[name] = leafText(node, name);
  }
  return { [characteristic.name]: out };
}

/**
 * Vehicle tokens published under the applicability role, for the legacy
 * `vehiclesAffected` array. Participants are deliberately excluded: the array
 * means "vehicles this measure applies to", not "vehicles mentioned anywhere".
 */
export function datexApplicabilityVehicles(rec: XmlObject): string[] | undefined {
  const out = new Set<string>();
  for (const group of getXmlChildren(rec, "forVehiclesWithCharacteristicsOf")) {
    for (const characteristic of characteristicsOf(group)) {
      if (characteristic.name !== "vehicleType" && characteristic.name !== "vehicleUsage") continue;
      const token = text(characteristic.node);
      if (token !== null) out.add(token);
    }
  }
  return out.size > 0 ? [...out] : undefined;
}
