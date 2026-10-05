import { formatRecordId, jcs, sha256Hex } from "../kernel/identity.js";
import type { FeatureLink, LinkableFeature } from "./link.js";

/**
 * One cluster of the canonical view (`oc.feature_canonical`): the per-source
 * features that are the same real-world thing. Every feature is in exactly
 * one cluster — an unlinked feature is a cluster of one — so a consumer
 * resolves any feature to its canonical id with one lookup.
 */
export interface CanonicalCluster {
  canonicalFeatureId: string;
  survivorId: string;
  memberIds: readonly string[];
  mergedSources: readonly { source: string; recordId: string }[];
}

class Clusters {
  private readonly parent = new Map<string, string>();

  root(id: string): string {
    const seen: string[] = [];
    let cur = id;
    while (this.parent.get(cur) !== undefined && this.parent.get(cur) !== cur) {
      seen.push(cur);
      cur = this.parent.get(cur)!;
    }
    for (const s of seen) this.parent.set(s, cur);
    if (!this.parent.has(cur)) this.parent.set(cur, cur);
    return cur;
  }

  members(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.root(id);
      groups.set(root, [...(groups.get(root) ?? []), id]);
    }
    return groups;
  }

  join(a: string, b: string): void {
    const [ra, rb] = [this.root(a), this.root(b)];
    if (ra !== rb) this.parent.set(rb, ra);
  }

  add(id: string): void {
    this.root(id);
  }
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * The survivor rank of the canonical view: a publisher feed's member above a
 * community-mapped one (OSM, read through Overpass), whose record is thinner,
 * whatever either feed's access mode. The survivor's record is the canonical
 * record, so it should be the authoritative one.
 */
export function survivorRank(feature: Pick<LinkableFeature, "provenance">): number {
  return feature.provenance.sourceFormat === "overpass" ? 0 : 1;
}

/**
 * Groups features into canonical clusters from the accepted links. Two
 * clusters only merge when every feature of one links to every feature of the
 * other: without that guard a line of separately-accepted pairs, each within
 * its own threshold, would chain a whole street of charging sites into one
 * cluster. Links are applied by descending confidence, so the strongest
 * evidence forms the clusters first.
 *
 * `rank` picks the survivor (highest wins); by default the smallest id, so
 * the result never depends on input order.
 */
export function canonicalClusters(
  features: readonly LinkableFeature[],
  links: readonly FeatureLink[],
  opts: { instanceId: string; rank?: (feature: LinkableFeature) => number },
): CanonicalCluster[] {
  const byId = new Map(features.map((f) => [f.id, f]));
  const clusters = new Clusters();
  for (const f of features) clusters.add(f.id);

  const accepted = links
    .filter((l) => l.status === "accepted" && byId.has(l.aId) && byId.has(l.bId))
    .sort(
      (x, y) =>
        y.confidence - x.confidence || pairKey(x.aId, x.bId).localeCompare(pairKey(y.aId, y.bId)),
    );
  const linked = new Set(accepted.map((l) => pairKey(l.aId, l.bId)));

  for (const link of accepted) {
    const groups = clusters.members();
    const left = groups.get(clusters.root(link.aId)) ?? [link.aId];
    const right = groups.get(clusters.root(link.bId)) ?? [link.bId];
    if (clusters.root(link.aId) === clusters.root(link.bId)) continue;
    const complete = left.every((a) => right.every((b) => linked.has(pairKey(a, b))));
    if (complete) clusters.join(link.aId, link.bId);
  }

  const rank = opts.rank;
  return [...clusters.members().values()]
    .map((memberIds) => {
      const members = [...memberIds].sort();
      const survivorId =
        rank === undefined
          ? members[0]!
          : [...members].sort(
              (a, b) => rank(byId.get(b)!) - rank(byId.get(a)!) || a.localeCompare(b),
            )[0]!;
      return {
        canonicalFeatureId: formatRecordId({
          class: "feature",
          namespace: opts.instanceId,
          localId: sha256Hex(jcs(members)),
        }),
        survivorId,
        memberIds: members,
        mergedSources: members.map((id) => ({
          source: byId.get(id)!.provenance.sourceId,
          recordId: id,
        })),
      };
    })
    .sort((a, b) => a.survivorId.localeCompare(b.survivorId));
}
