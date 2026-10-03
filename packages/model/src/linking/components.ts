import { jcs, parseRecordId } from "../kernel/identity.js";
import type { Registry } from "../registry/build.js";
import type { CanonicalCluster } from "./cluster.js";

/** The parts of a component correspondence reads. */
export interface LinkableComponent {
  key: string;
  parentKey?: string;
  kind: string;
  externalIds?: readonly { scheme: string; id: string; authority?: string }[];
  details: Record<string, unknown>;
}

/** The parts of a member feature correspondence reads. */
export interface ComponentHolder {
  id: string;
  provenance: { sourceId: string };
  components?: readonly LinkableComponent[];
}

/** One component of a canonical feature and the per-source components it stands for. */
export interface CanonicalComponent {
  key: string;
  kind: string;
  parentKey?: string;
  members: readonly { featureId: string; key: string }[];
}

interface Building extends CanonicalComponent {
  members: { featureId: string; key: string }[];
  /** Ids of the member components, `scheme\u0000authority\u0000id`. */
  ids: Set<string>;
  /** The identity fields of the first member, as JCS. */
  fields?: string;
}

/**
 * An id is the same id only from the same authority: OCPI EVSE uids are unique
 * within one operator's platform, so uid "1" from two operators is two charge
 * points.
 */
const idKey = (id: { scheme: string; id: string; authority?: string }) =>
  `${id.scheme}\u0000${id.authority ?? ""}\u0000${id.id}`;

/**
 * The component set of one canonical feature: the union of its members'
 * components. A member's component is the same component as one already in
 * the set only by its kind's identity — a shared authoritative id, compared
 * within the corresponding parent where the kind says so, or equal identity
 * fields — never by position or name. The survivor's components keep their
 * keys; every other component joins as `<member source id>/<key>`, so a fused
 * row exists for each and nothing a source publishes disappears from the
 * canonical view. A member's components each correspond to at most one
 * canonical component, and each canonical component takes at most one
 * component of a member.
 */
export function canonicalComponents(
  registry: Registry,
  cluster: CanonicalCluster,
  members: readonly ComponentHolder[],
): CanonicalComponent[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const order = [
    cluster.survivorId,
    ...cluster.memberIds.filter((id) => id !== cluster.survivorId),
  ];
  const set: Building[] = [];
  const taken = new Set<string>();
  for (const featureId of order) {
    const feature = byId.get(featureId);
    if (feature === undefined) continue;
    const survivor = featureId === cluster.survivorId;
    const components = [...(feature.components ?? [])].sort(
      (a, b) => Number(a.parentKey !== undefined) - Number(b.parentKey !== undefined),
    );
    const placed = new Map<string, Building>();
    for (const component of components) {
      const identity = registry.kind("component", component.kind)?.identity;
      const ids = new Set(
        (component.externalIds ?? [])
          .filter((id) => identity?.idSchemes?.includes(id.scheme))
          .map(idKey),
      );
      const fields =
        identity?.fields === undefined
          ? undefined
          : jcs(identity.fields.map((f) => component.details[f] ?? null));
      const parent =
        component.parentKey === undefined ? undefined : placed.get(component.parentKey)?.key;
      const match = survivor
        ? undefined
        : set.find(
            (c) =>
              c.kind === component.kind &&
              !c.members.some((m) => m.featureId === featureId) &&
              (!identity?.withinParent || c.parentKey === parent) &&
              (([...ids].some((id) => c.ids.has(id)) ||
                (fields !== undefined && c.fields === fields)) as boolean),
          );
      if (match !== undefined) {
        match.members.push({ featureId, key: component.key });
        for (const id of ids) match.ids.add(id);
        placed.set(component.key, match);
        continue;
      }
      let key = survivor ? component.key : `${feature.provenance.sourceId}/${component.key}`;
      if (taken.has(key))
        key = `${parseRecordId(featureId)?.localId ?? featureId}/${component.key}`;
      taken.add(key);
      const created: Building = {
        key,
        kind: component.kind,
        ...(parent === undefined ? {} : { parentKey: parent }),
        members: [{ featureId, key: component.key }],
        ids,
        ...(fields === undefined ? {} : { fields }),
      };
      set.push(created);
      placed.set(component.key, created);
    }
  }
  return set.map(({ key, kind, parentKey, members: m }) => ({
    key,
    kind,
    ...(parentKey === undefined ? {} : { parentKey }),
    members: m,
  }));
}
