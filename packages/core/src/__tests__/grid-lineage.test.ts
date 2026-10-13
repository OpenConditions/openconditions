import { expect, it } from "vitest";
import { readGrid } from "../observations.js";

it("keeps each density cell's admitted suppliers separate and retains notices sharing a source ID", async () => {
  const credit = (id: string) => ({ sourceId: id, name: id });
  const rows = [
    {
      x: 1,
      y: 1,
      source_id: "child-a",
      provenance: { attribution: { license: "CC0-1.0" } },
      contributors: [credit("parent-a"), { sourceId: "parent-a", name: "Notice" }],
      n: 1,
      sum: 10,
      max: 10,
    },
    {
      x: 2,
      y: 1,
      source_id: "b",
      provenance: { attribution: { license: "CC0-1.0" } },
      contributors: [credit("b")],
      n: 1,
      sum: 20,
      max: 20,
    },
    {
      x: 1,
      y: 1,
      source_id: "withheld",
      provenance: { attribution: { license: "NOASSERTION" } },
      contributors: [credit("withheld")],
      n: 1,
      sum: 30,
      max: 30,
    },
  ];
  // QueryRunner boundary fixture models the grouped database read; aggregation/filtering below is real.
  const db = {
    async execute<T>() {
      return rows as T;
    },
  };
  const result = await readGrid(db, {
    scope: "public",
    property: "fire.frp",
    bbox: [0, 0, 5, 5],
    cellDeg: 1,
    since: new Date(0),
    admits: (p) => p.attribution.license !== "NOASSERTION",
  });
  expect(result.cells).toEqual([
    [1.5, 1.5, 1, 10, 10],
    [2.5, 1.5, 1, 20, 20],
  ]);
  expect(result.cell_contributors).toEqual([
    {
      longitude: 1.5,
      latitude: 1.5,
      native_sources: ["child-a"],
      lineage_complete: true,
      sources: ["parent-a"],
      contributors: [credit("parent-a"), { sourceId: "parent-a", name: "Notice" }],
    },
    {
      longitude: 2.5,
      latitude: 1.5,
      native_sources: ["b"],
      lineage_complete: true,
      sources: ["b"],
      contributors: [credit("b")],
    },
  ]);
});
