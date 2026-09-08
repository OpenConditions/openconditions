/**
 * Loader and aggregate metrics for the binding evaluation corpus. Each case
 * directory holds a real event, a frozen OSM spine and the hand-verified
 * expectation; the ratchet test and the inspect script both read them through
 * here, so the corpus stays offline and reproducible.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BindingStatus, DirectionMode } from "@openconditions/core";
import { bindEvent } from "./bind-event.js";
import type { BindInput, BindResult, SpineSubgraph } from "./types.js";

export interface CorpusExpectation {
  status: BindingStatus;
  directionMode?: DirectionMode;
  segments?: Array<{ segmentId: string; startFraction?: number; endFraction?: number }>;
  why: string;
  /**
   * Set when the resolver currently contradicts this hand-verified expectation.
   * The expectation stays ground truth; this only records that the disagreement
   * is known, and the test asserts the case still fails so that fixing the
   * resolver forces the marker to be removed. Marked cases count towards the
   * metrics like every other case.
   */
  knownResolverBug?: string;
}

export interface CorpusCase {
  id: string;
  input: BindInput;
  spine: SpineSubgraph;
  expected: CorpusExpectation;
}

export function loadCorpus(dir: string): CorpusCase[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "expected.json")))
    .map((d) => ({
      id: d.name,
      input: JSON.parse(readFileSync(join(dir, d.name, "event.json"), "utf8")) as BindInput,
      spine: JSON.parse(readFileSync(join(dir, d.name, "spine.json"), "utf8")) as SpineSubgraph,
      expected: JSON.parse(
        readFileSync(join(dir, d.name, "expected.json"), "utf8")
      ) as CorpusExpectation,
    }));
}

export interface CorpusMetrics {
  cases: number;
  statusAccuracy: number;
  segmentPrecision: number;
  segmentRecall: number;
  wrongDirectionRate: number;
}

const TOL = 0.05;

export function evaluateCorpus(cases: CorpusCase[]): {
  metrics: CorpusMetrics;
  perCase: Array<{ id: string; ok: boolean; result: BindResult; problems: string[] }>;
} {
  let statusOk = 0,
    tp = 0,
    fp = 0,
    fn = 0,
    wrongDir = 0,
    dirCases = 0;
  const perCase = cases.map((c) => {
    const result = bindEvent(c.input, c.spine);
    const problems: string[] = [];
    if (result.status !== c.expected.status)
      problems.push(`status ${result.status} != ${c.expected.status}`);
    else statusOk++;
    if (c.expected.directionMode && result.directionMode !== c.expected.directionMode)
      problems.push(`directionMode ${result.directionMode} != ${c.expected.directionMode}`);
    if (c.expected.segments) {
      const want = new Map(c.expected.segments.map((s) => [s.segmentId, s]));
      const got = new Map(result.segments.map((s) => [s.segmentId, s]));
      for (const [id, w] of want) {
        const g = got.get(id);
        if (!g) {
          fn++;
          problems.push(`missing ${id}`);
          continue;
        }
        tp++;
        if (w.startFraction != null && Math.abs(w.startFraction - g.startFraction) > TOL)
          problems.push(`${id} start ${g.startFraction.toFixed(2)} != ${w.startFraction}`);
        if (w.endFraction != null && Math.abs(w.endFraction - g.endFraction) > TOL)
          problems.push(`${id} end ${g.endFraction.toFixed(2)} != ${w.endFraction}`);
      }
      for (const id of got.keys())
        if (!want.has(id)) {
          fp++;
          problems.push(`extra ${id}`);
        }
      dirCases++;
      const flipped = [...got.keys()].some((id) => {
        const [way, dir] = id.split(":");
        return !want.has(id) && want.has(`${way}:${dir === "f" ? "b" : "f"}`);
      });
      if (flipped) {
        wrongDir++;
        problems.push("wrong direction");
      }
    }
    return { id: c.id, ok: problems.length === 0, result, problems };
  });
  return {
    metrics: {
      cases: cases.length,
      statusAccuracy: cases.length ? statusOk / cases.length : 1,
      segmentPrecision: tp + fp ? tp / (tp + fp) : 1,
      segmentRecall: tp + fn ? tp / (tp + fn) : 1,
      wrongDirectionRate: dirCases ? wrongDir / dirCases : 0,
    },
    perCase,
  };
}
