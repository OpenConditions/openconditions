import { defineChangeKind } from "../registry/define.js";

type Rec = Readonly<Record<string, unknown>>;

const pick = (record: Rec, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, record[k]]));

function locationWithout(record: Rec, key: string) {
  const location = record["location"] as Record<string, unknown> | undefined;
  if (location === undefined) return undefined;
  const { [key]: _omitted, ...rest } = location;
  return rest;
}

function provenanceContent(record: Rec) {
  const p = record["provenance"] as Record<string, unknown> | undefined;
  if (p === undefined) return undefined;
  const {
    rawRef: _r,
    instanceId: _i,
    originChain: _o,
    mergedSources: _m,
    reporter: _p,
    ...rest
  } = p;
  return rest;
}

/**
 * The kernel's change kinds. Together they watch every content field of the
 * three revisioned classes, so a content-hash change always names at least
 * one kind; domain packages add finer ones (roads: `lanes_change`).
 */
export const KERNEL_CHANGE_KINDS = [
  defineChangeKind({
    code: "classification_change",
    description: "Kind, type, subtype, causes, temporality, planning or certainty changed.",
    classes: ["situation", "feature", "offer"],
    select: (r) =>
      pick(r, ["kind", "type", "subtype", "causes", "temporality", "planned", "certainty"]),
  }),
  defineChangeKind({
    code: "severity_change",
    description: "The severity label, level or its source changed.",
    classes: ["situation"],
    select: (r) => r["severity"],
  }),
  defineChangeKind({
    code: "validity_change",
    description: "Declared start, end, status, periods or exceptions changed.",
    classes: ["situation", "offer"],
    select: (r) => r["validity"],
  }),
  defineChangeKind({
    code: "effects_change",
    description: "An effect was added, removed or changed.",
    classes: ["situation"],
    select: (r) => r["effects"],
  }),
  defineChangeKind({
    code: "geometry_change",
    description: "The published geometry changed.",
    classes: ["situation", "feature", "offer"],
    select: (r) => (r["location"] as Record<string, unknown> | undefined)?.["geometry"],
  }),
  defineChangeKind({
    code: "location_change",
    description:
      "A location reference other than the geometry changed (roads, direction, lanes, codes).",
    classes: ["situation", "feature", "offer"],
    select: (r) => locationWithout(r, "geometry"),
  }),
  defineChangeKind({
    code: "text_change",
    description: "Headline, description, instruction, comments or names changed.",
    classes: ["situation", "feature", "offer"],
    select: (r) =>
      pick(r, [
        "headline",
        "description",
        "instruction",
        "comments",
        "name",
        "altText",
        "displayText",
        "url",
      ]),
  }),
  defineChangeKind({
    code: "details_change",
    description: "The kind's details changed.",
    classes: ["situation", "feature"],
    select: (r) => r["details"],
  }),
  defineChangeKind({
    code: "lifecycle_change",
    description: "A feature's lifecycle changed.",
    classes: ["feature"],
    select: (r) => r["lifecycle"],
  }),
  defineChangeKind({
    code: "components_change",
    description: "A component was added, removed or changed.",
    classes: ["feature"],
    select: (r) => r["components"],
  }),
  defineChangeKind({
    code: "attributes_change",
    description:
      "Operator, owner, publisher, opening hours, access, amenities, images or energy mix changed.",
    classes: ["feature", "offer"],
    select: (r) =>
      pick(r, [
        "operator",
        "owner",
        "publisher",
        "openingHours",
        "access",
        "amenities",
        "images",
        "energyMix",
      ]),
  }),
  defineChangeKind({
    code: "price_change",
    description: "An offer's prices, currency, tariff type, scope or applicability changed.",
    classes: ["offer"],
    select: (r) =>
      pick(r, [
        "currency",
        "elements",
        "minPrice",
        "maxPrice",
        "priceIncludesVat",
        "tariffType",
        "scope",
        "applicability",
      ]),
  }),
  defineChangeKind({
    code: "references_change",
    description:
      "External ids, relations, the offer subject, affected features or the group changed.",
    classes: ["situation", "feature", "offer"],
    select: (r) => pick(r, ["externalIds", "relations", "subject", "affects", "groupId"]),
  }),
  defineChangeKind({
    code: "source_change",
    description: "The source's record version, attribution or allow-listed extras changed.",
    classes: ["situation", "feature", "offer"],
    select: (r) => ({ provenance: provenanceContent(r), extras: r["extras"] }),
  }),
] as const;
