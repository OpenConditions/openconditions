import type { RevisionedClass } from "@openconditions/core/server";
import {
  effectValidity,
  jcs,
  type Registry,
  sha256Hex,
  type Validity,
} from "@openconditions/model";

type Rec = Record<string, unknown>;

const get = (record: Rec, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (value, key) => (value !== null && typeof value === "object" ? (value as Rec)[key] : undefined),
    record,
  );

const orNull = (value: unknown) => (value === undefined ? null : value);

/** The instant a record says it expires at, comparable with a stored `expires_at`. */
export function expiryOf(record: Rec): number | null {
  const at = get(record, "freshness", "expiresAt");
  return typeof at === "string" ? Date.parse(at) : null;
}

/**
 * The kernel columns of a stored record, as the class tables promote them.
 * `record` is the stored record without its evidence summary, which lives in
 * its own columns and is never written by a snapshot.
 */
function kernelRow(record: Rec): Rec {
  const { evidence: _evidence, ...stored } = record;
  return {
    id: record["id"],
    record: stored,
    canonical_id: record["canonicalId"],
    kind: record["kind"],
    type: orNull(record["type"]),
    subtype: orNull(record["subtype"]),
    domain: record["domain"],
    temporality: record["temporality"],
    source_id: get(record, "provenance", "sourceId"),
    source_record_id: get(record, "provenance", "recordId"),
    origin: get(record, "provenance", "origin"),
    access_mode: get(record, "provenance", "accessMode"),
    privacy_class: get(record, "provenance", "privacy", "class"),
    instance_id: get(record, "provenance", "instanceId"),
    revision: record["revision"],
    recorded_at: record["recordedAt"],
    content_hash: record["contentHash"],
    fetched_at: get(record, "freshness", "fetchedAt"),
    expires_at: orNull(get(record, "freshness", "expiresAt")),
    geom: orNull(get(record, "location", "geometry")),
    country: orNull(get(record, "location", "admin", "country")),
    subdivision: orNull(get(record, "location", "admin", "subdivision")),
    tombstone_reason: orNull(get(record, "tombstone", "reason")),
    tombstoned_at: orNull(get(record, "tombstone", "at")),
  };
}

/** A class table's row for a stored record: the kernel columns and the class's own. */
export function rowOf(cls: RevisionedClass, record: Rec): Rec {
  const row = kernelRow(record);
  switch (cls) {
    case "situation":
      return {
        ...row,
        severity: get(record, "severity", "label"),
        severity_level: orNull(get(record, "severity", "level")),
        certainty: record["certainty"],
        planned: record["planned"],
        validity_status: get(record, "validity", "status"),
        valid_from: orNull(get(record, "validity", "start")),
        valid_to: orNull(get(record, "validity", "end")),
        group_id: orNull(record["groupId"]),
      };
    case "feature":
      return { ...row, lifecycle: record["lifecycle"] };
    case "offer":
      return {
        ...row,
        subject_class: get(record, "subject", "class"),
        subject_id: get(record, "subject", "id"),
        component_key: orNull(get(record, "subject", "componentKey")),
        currency: record["currency"],
        valid_from: orNull(get(record, "validity", "start")),
        valid_to: orNull(get(record, "validity", "end")),
        min_price: orNull(get(record, "minPrice", "amount")),
        max_price: orNull(get(record, "maxPrice", "amount")),
      };
  }
}

/**
 * Every effect of a situation as a `situation_effect` row: its own effects,
 * then the effects its kind nests in its details (roadworks phases), each
 * with the validity it is in effect for and the geometry it applies to.
 */
export function effectRows(registry: Registry, situation: Rec): Rec[] {
  const own = (situation["effects"] as Rec[] | undefined) ?? [];
  const validity = situation["validity"] as Validity;
  const kind = registry.kind("situation", situation["kind"] as string);
  const nested = kind?.nestedEffects?.((situation["details"] as Rec | undefined) ?? {}) ?? [];
  const all = [
    ...own.map((effect) => ({ effect, phaseId: "", validity: effectValidity(effect, validity) })),
    ...nested.map((n) => ({
      effect: n.effect as Rec,
      phaseId: n.phaseId,
      validity: (n.effect["validity"] as Validity | undefined) ?? n.validity,
    })),
  ];
  return all.map(({ effect, phaseId, validity: v }) => ({
    situation_id: situation["id"],
    effect_id: effect["id"],
    phase_id: phaseId,
    kind: effect["kind"],
    applicability_kind: get(effect, "applicability", "kind"),
    normalization: effect["normalization"],
    compliance: effect["compliance"],
    direction: orNull(get(effect, "direction", "value")),
    valid_from: orNull(v.start),
    valid_to: orNull(v.end),
    geom: orNull(get(effect, "location", "geometry") ?? get(situation, "location", "geometry")),
    value: effect,
  }));
}

/** A feature's components as `feature_component` rows, each with its own content hash. */
export function componentRows(feature: Rec): Rec[] {
  return ((feature["components"] as Rec[] | undefined) ?? []).map((c) => ({
    feature_id: feature["id"],
    key: c["key"],
    parent_key: orNull(c["parentKey"]),
    kind: c["kind"],
    lifecycle: orNull(c["lifecycle"]),
    position: orNull(c["position"]),
    external_ids: orNull(c["externalIds"]),
    details: c["details"],
    content_hash: sha256Hex(jcs(c)),
  }));
}

/** A record's relations as `record_relation` rows; a component target keeps its key. */
export function relationRows(cls: RevisionedClass, record: Rec): Rec[] {
  return ((record["relations"] as Rec[] | undefined) ?? []).map((r) => ({
    from_class: cls,
    from_id: record["id"],
    relation: r["relation"],
    to_class: get(r, "ref", "class"),
    to_id: get(r, "ref", "id"),
    component_key: get(r, "ref", "componentKey") ?? "",
  }));
}
