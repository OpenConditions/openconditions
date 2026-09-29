/**
 * The `part_of` graph of features: a service area and the car park, filling
 * station and charging site inside it, a border crossing and its lorry park.
 * Each feature names at most one parent; the parent is a whole feature, never
 * one of its components.
 */
interface PartOfRecord {
  id: string;
  relations?: readonly { relation: string; ref: { class: string; id: string } }[];
}

/** The feature a feature is part of, when it names one. */
export function partOfParent(record: PartOfRecord): string | undefined {
  return record.relations?.find((r) => r.relation === "part_of")?.ref.id;
}

export interface PartOfIssue {
  id: string;
  problem: "missing_parent" | "cycle";
  parent: string;
}

export interface PartOfTree {
  /** Features that are part of nothing, in input order. */
  roots: readonly string[];
  /** Parent id → the ids of its parts, in input order. */
  parts: ReadonlyMap<string, readonly string[]>;
  /** Parts whose parent is not among the features, and every feature on a cycle. */
  issues: readonly PartOfIssue[];
}

/**
 * Builds the tree of one set of features (a source's snapshot, a canonical
 * cluster's members). A feature whose parent is missing from the set stays
 * a root and is reported, since its parent may simply be another source's;
 * a feature on a cycle is reported and belongs to no tree.
 */
export function partOfTree(features: readonly PartOfRecord[]): PartOfTree {
  const ids = new Set(features.map((f) => f.id));
  const parentOf = new Map<string, string>();
  for (const f of features) {
    const parent = partOfParent(f);
    if (parent !== undefined) parentOf.set(f.id, parent);
  }
  const onCycle = new Set<string>();
  for (const start of parentOf.keys()) {
    const seen = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at);
    }
    if (at === start) for (const id of seen) onCycle.add(id);
  }
  const issues: PartOfIssue[] = [];
  const roots: string[] = [];
  const parts = new Map<string, string[]>();
  for (const f of features) {
    const parent = parentOf.get(f.id);
    if (onCycle.has(f.id)) {
      issues.push({ id: f.id, problem: "cycle", parent: parent! });
    } else if (parent === undefined) {
      roots.push(f.id);
    } else if (!ids.has(parent)) {
      issues.push({ id: f.id, problem: "missing_parent", parent });
      roots.push(f.id);
    } else {
      parts.set(parent, [...(parts.get(parent) ?? []), f.id]);
    }
  }
  return { roots, parts, issues };
}
