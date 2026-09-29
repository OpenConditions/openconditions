import type { Effect } from "@openconditions/model";
import { ROADS_SITUATION_KINDS } from "./kinds.js";

type Clearance = {
  road: "carried" | "crossed";
  height: { value: number; unit: "m" };
  basis: "measured" | "calculated" | "signed" | "design";
  position?: "left" | "centre" | "right";
};

/** The parts of a structure feature (draft or stored) the derivation reads. */
export interface StructureInput {
  id: string;
  type?: string;
  name?: readonly { lang: string; text: string }[];
  lifecycle: string;
  location: Record<string, unknown>;
  provenance: {
    sourceId: string;
    sourceFormat: string;
    accessMode: string;
    recordId: string;
    attribution: object;
    privacy: object;
    upstream?: readonly object[];
  };
  freshness: { fetchedAt: string; expiresAt?: string };
  details: {
    carries?: string;
    crosses?: string;
    clearances?: readonly Clearance[];
    weightLimit?: { value: number; unit: "kg" };
    axleLimit?: { value: number; unit: "kg" };
    widthLimit?: { value: number; unit: "m" };
    nbi?: { openStatus: string };
  };
}

/** Rule version recorded in `provenance.derivedFrom`; bump it when the derivation changes. */
export const STRUCTURE_RESTRICTIONS_VERSION = "1";

const DIMENSION_SUBTYPE = {
  height: "height",
  width: "width",
  gross_weight: "weight",
  axle_load: "axle_load",
} as const;
type LimitDimension = keyof typeof DIMENSION_SUBTYPE;

/**
 * The standing restrictions a structure imposes, as situation drafts: one
 * `restriction.dimension` situation per limit, and a `closure` when the
 * structure is closed. Routing reads restrictions from situations only, so
 * a structure's clearance must become one to be avoided.
 *
 * A signed or posted value is the legal limit (`maximum_permitted`). Where
 * a road has no signed height, the lowest clearance published for it is
 * what physically fits (`physical_limit`); a calculated height already
 * holds the publisher's safety margin, so it is chosen over the measured
 * one it was calculated from. A limit the source says exists but publishes
 * no value for (an inventory bridge posted for load) becomes an
 * `unsupported` effect: withheld from routing, but kept as evidence.
 *
 * Every draft is `origin: derived`, keeps the structure's source, rights
 * and access mode, and names the structure in `derivedFrom` and in
 * `details.structureRef`.
 */
export function structureRestrictions(structure: StructureInput): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const d = structure.details;
  for (const road of ["carried", "crossed"] as const) {
    const forRoad = (d.clearances ?? []).filter((c) => c.road === road);
    if (forRoad.length === 0) continue;
    const signed = lowest(forRoad.filter((c) => c.basis === "signed"));
    const physical =
      lowest(forRoad.filter((c) => c.basis === "calculated")) ??
      lowest(forRoad.filter((c) => c.basis !== "signed"));
    const chosen = signed ?? physical!;
    out.push(
      restriction(structure, `${road}/height`, road, {
        dimension: "height",
        value: chosen.height.value,
        unit: "m",
        meaning: signed !== undefined ? "maximum_permitted" : "physical_limit",
      }),
    );
  }
  const legal: [LimitDimension, { value: number; unit: string } | undefined][] = [
    ["width", d.widthLimit],
    ["gross_weight", d.weightLimit],
    ["axle_load", d.axleLimit],
  ];
  for (const [dimension, limit] of legal) {
    if (limit === undefined) continue;
    out.push(
      restriction(structure, `carried/${dimension}`, "carried", {
        dimension,
        value: limit.value,
        unit: limit.unit,
        meaning: "maximum_permitted",
      }),
    );
  }
  const posted = d.nbi?.openStatus === "P" || d.nbi?.openStatus === "R";
  if (posted && d.weightLimit === undefined) {
    out.push(restriction(structure, "carried/gross_weight", "carried", undefined));
  }
  if (structure.lifecycle === "temporarily_closed") out.push(closure(structure));
  return out;
}

function lowest(list: readonly Clearance[]): Clearance | undefined {
  return list.reduce<Clearance | undefined>(
    (min, c) => (min === undefined || c.height.value < min.height.value ? c : min),
    undefined,
  );
}

function base(structure: StructureInput, localSuffix: string) {
  const p = structure.provenance;
  return {
    id: `oc:situation:${p.sourceId}:${p.recordId}/${localSuffix}`,
    class: "situation",
    temporality: "static",
    provenance: {
      origin: "derived",
      sourceId: p.sourceId,
      sourceFormat: p.sourceFormat,
      accessMode: p.accessMode,
      recordId: `${p.recordId}/${localSuffix}`,
      attribution: p.attribution,
      privacy: p.privacy,
      ...(p.upstream === undefined ? {} : { upstream: p.upstream }),
      derivedFrom: {
        records: [{ class: "feature", id: structure.id }],
        method: "structure_restrictions",
        version: STRUCTURE_RESTRICTIONS_VERSION,
      },
    },
    freshness: structure.freshness,
    planned: false,
    certainty: "observed",
    validity: { status: "active" },
  };
}

/** The crossed road passes under the structure's point; name it so binding can tell the two roads apart. */
function locationFor(structure: StructureInput, road: "carried" | "crossed") {
  const crosses = structure.details.crosses;
  if (road === "carried" || crosses === undefined) return structure.location;
  const lang = structure.name?.[0]?.lang ?? "und";
  return { ...structure.location, roads: [{ name: [{ lang, text: crosses }] }] };
}

function restriction(
  structure: StructureInput,
  localSuffix: string,
  road: "carried" | "crossed",
  limit:
    | {
        dimension: LimitDimension;
        value: number;
        unit: string;
        meaning: "maximum_permitted" | "physical_limit";
      }
    | undefined,
): Record<string, unknown> {
  const recordId = structure.provenance.recordId;
  const common = {
    applicability: { kind: "all" },
    compliance: "mandatory",
  };
  const effect =
    limit === undefined
      ? {
          id: `${recordId}/unsupported`,
          kind: "unsupported",
          v: 1,
          ...common,
          normalization: "unsupported",
          issues: [{ code: "value_not_published", sourcePath: "details.nbi.openStatus" }],
        }
      : {
          id: `${recordId}/dimension_limit`,
          kind: "dimension_limit",
          v: 1,
          ...common,
          normalization: "complete",
          dimension: limit.dimension,
          value: { value: limit.value, unit: limit.unit },
          operator: "lte",
          meaning: limit.meaning,
        };
  const subtype = DIMENSION_SUBTYPE[limit?.dimension ?? "gross_weight"];
  return {
    ...base(structure, localSuffix),
    kind: "restriction",
    type: "dimension",
    subtype,
    location: locationFor(structure, road),
    severity: severityOf("restriction", "dimension", subtype, [effect as Effect]),
    effects: [effect],
    details: {
      kind: "restriction",
      v: 1,
      basis: "structural",
      structureRef: { class: "feature", id: structure.id },
      enforcement: limit?.meaning === "maximum_permitted" ? "signed" : "unknown",
    },
  };
}

function closure(structure: StructureInput): Record<string, unknown> {
  const scope =
    structure.type === "tunnel" ? "tunnel" : structure.type === "bridge" ? "bridge" : "road";
  const effect = {
    id: `${structure.provenance.recordId}/closure`,
    kind: "closure",
    v: 1,
    scope,
    applicability: { kind: "all" },
    compliance: "mandatory",
    normalization: "complete",
  };
  const subtype = scope === "road" ? undefined : scope;
  return {
    ...base(structure, "closure"),
    kind: "closure",
    type: "closure",
    ...(subtype === undefined ? {} : { subtype }),
    location: structure.location,
    severity: severityOf("closure", "closure", subtype, [effect as Effect]),
    effects: [effect],
    details: { kind: "closure", v: 1 },
  };
}

function severityOf(kind: string, type: string, subtype: string | undefined, effects: Effect[]) {
  const rule = ROADS_SITUATION_KINDS.find((k) => k.code === kind)?.deriveSeverity;
  const label = rule?.({ type, ...(subtype === undefined ? {} : { subtype }), effects });
  return label === undefined ? { label: "unknown" } : { label, source: "derived" };
}
