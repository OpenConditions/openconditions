import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCorpus, loadCorpus, type CorpusMetrics } from "../corpus.js";

const DIR = join(import.meta.dirname, "corpus");
const thresholds = JSON.parse(
  readFileSync(join(DIR, "thresholds.json"), "utf8")
) as Partial<CorpusMetrics>;
const cases = loadCorpus(DIR);
const { metrics, perCase } = evaluateCorpus(cases);
const knownResolverBug = new Map(cases.map((c) => [c.id, c.expected.knownResolverBug]));

describe("binding corpus", () => {
  it("has the minimum number of cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  for (const c of perCase.filter((p) => !knownResolverBug.get(p.id))) {
    it(`case ${c.id}`, () => {
      expect(c.ok, c.problems.join("; ")).toBe(true);
    });
  }

  // Cases whose expectation is hand-verified ground truth the resolver does not
  // yet reproduce. Asserting they still fail means fixing the resolver turns
  // these red until the marker is removed from expected.json.
  const known = perCase.filter((p) => knownResolverBug.get(p.id));
  if (known.length > 0) {
    it.each(known.map((c) => [c.id] as const))("known resolver bug: %s", (id) => {
      const c = perCase.find((p) => p.id === id)!;
      expect(
        c.ok,
        `${id} now matches its expectation — remove knownResolverBug from its expected.json`
      ).toBe(false);
    });
  }

  it.each([
    ["statusAccuracy", true],
    ["segmentPrecision", true],
    ["segmentRecall", true],
    ["wrongDirectionRate", false],
  ] as const)("%s meets its threshold and the threshold is current", (key, higherIsBetter) => {
    const min = thresholds[key];
    expect(min, `${key} missing in thresholds.json`).toBeTypeOf("number");
    const v = metrics[key];
    if (higherIsBetter) {
      expect(v).toBeGreaterThanOrEqual(min!);
      expect(
        v - min!,
        `${key} improved to ${v.toFixed(3)}; raise thresholds.json`
      ).toBeLessThanOrEqual(0.05);
    } else {
      expect(v).toBeLessThanOrEqual(min!);
      expect(
        min! - v,
        `${key} improved to ${v.toFixed(3)}; lower thresholds.json`
      ).toBeLessThanOrEqual(0.05);
    }
  });
});
