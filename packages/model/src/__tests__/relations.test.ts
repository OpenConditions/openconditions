import { describe, expect, it } from "vitest";
import { partOfParent, partOfTree } from "../kernel/relations.js";
import { inSeasonalWindow } from "../kernel/scalars.js";
import { draftBase, registry } from "./fixtures.js";

const partOf = (id: string) => ({
  relation: "part_of",
  ref: { class: "feature", id: `oc:feature:de-ndw:${id}` },
});
const feature = (localId: string, relations?: object[]) => ({
  ...draftBase("feature", localId),
  temporality: "static",
  class: "feature",
  kind: "measurement_site",
  type: "traffic",
  lifecycle: "operational",
  details: { kind: "measurement_site", v: 1, measuredProperties: ["traffic.speed"] },
  ...(relations === undefined ? {} : { relations }),
});
const node = (id: string, parent?: string) => ({
  id,
  ...(parent === undefined
    ? {}
    : { relations: [{ relation: "part_of", ref: { class: "feature", id: parent } }] }),
});

describe("part_of", () => {
  it("accepts a feature that is part of one other feature", () => {
    expect(registry.validateDraft(feature("child", [partOf("parent")])).ok).toBe(true);
  });

  it("rejects a feature that is part of two features", () => {
    const result = registry.validateDraft(feature("child", [partOf("a"), partOf("b")]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path.join("."))).toContain("relations.1");
  });

  it("rejects part_of a component, a situation or the feature itself", () => {
    const component = { ...partOf("parent"), ref: { ...partOf("parent").ref, componentKey: "1" } };
    const situation = { relation: "part_of", ref: { class: "situation", id: "oc:situation:x:1" } };
    for (const rel of [component, situation, partOf("self")]) {
      expect(registry.validateDraft(feature("self", [rel])).ok).toBe(false);
    }
  });

  it("names a feature's parent", () => {
    expect(partOfParent(node("child", "area"))).toBe("area");
    expect(partOfParent(node("area"))).toBeUndefined();
  });

  it("builds the tree of a snapshot: roots, and the parts under each parent", () => {
    const tree = partOfTree([
      node("area"),
      node("parking", "area"),
      node("fuel", "area"),
      node("lone"),
    ]);
    expect(tree.roots).toEqual(["area", "lone"]);
    expect(tree.parts.get("area")).toEqual(["parking", "fuel"]);
    expect(tree.issues).toEqual([]);
  });

  it("keeps a part whose parent another source publishes as a reported root", () => {
    const tree = partOfTree([node("parking", "elsewhere")]);
    expect(tree.roots).toEqual(["parking"]);
    expect(tree.issues).toEqual([
      { id: "parking", problem: "missing_parent", parent: "elsewhere" },
    ]);
  });

  it("reports every feature on a cycle and puts none of them in the tree", () => {
    const tree = partOfTree([node("a", "b"), node("b", "a"), node("c", "a")]);
    expect(tree.issues.map((i) => [i.id, i.problem])).toEqual([
      ["a", "cycle"],
      ["b", "cycle"],
    ]);
    expect(tree.roots).toEqual([]);
    expect(tree.parts.get("a")).toEqual(["c"]);
  });

  it("treats a feature that names itself as its parent as a cycle of one", () => {
    const tree = partOfTree([node("a", "a")]);
    expect(tree.issues).toEqual([{ id: "a", problem: "cycle", parent: "a" }]);
    expect(tree.roots).toEqual([]);
  });
});

describe("seasonal windows", () => {
  it("contains the days between its bounds, both included", () => {
    const summer = { from: "05-15", to: "10-15" };
    expect(inSeasonalWindow(summer, "2026-05-15")).toBe(true);
    expect(inSeasonalWindow(summer, "2026-10-15")).toBe(true);
    expect(inSeasonalWindow(summer, "2026-10-16")).toBe(false);
  });

  it("wraps the new year when it starts later than it ends", () => {
    const winter = { from: "12-01", to: "05-01" };
    expect(inSeasonalWindow(winter, "2026-12-24")).toBe(true);
    expect(inSeasonalWindow(winter, "2027-02-10")).toBe(true);
    expect(inSeasonalWindow(winter, "2026-09-29")).toBe(false);
  });

  it("holds a single day, and a leap day inside a winter window", () => {
    expect(inSeasonalWindow({ from: "12-24", to: "12-24" }, "2026-12-24")).toBe(true);
    expect(inSeasonalWindow({ from: "12-24", to: "12-24" }, "2026-12-25")).toBe(false);
    expect(inSeasonalWindow({ from: "12-01", to: "05-01" }, "2028-02-29")).toBe(true);
  });
});
