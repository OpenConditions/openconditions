import { type DirectionRef, subjectKey } from "@openconditions/model";
import type { FlowBaseline, FlowOutput } from "../flow-output.js";
import { type FlowGeometry, LOS, losFromSpeedRatio, QUEUING_LOS, SPEED } from "../flow-reading.js";
import type { SourceDescriptor } from "../types.js";
import { congestionDrafts } from "./assemble.js";

type Draft = Record<string, unknown>;

interface Subject {
  kind: "feature";
  featureId: string;
  componentKey?: string;
}

/**
 * Applies stored free-flow baselines, keyed by subject key, to the site
 * speeds a feed left unclassified: a site-level `traffic.speed` with no
 * baseline of its own and no level of service the source states. The
 * reading's baseline gains the free-flow speed, its method, the ratio and the
 * level the ratio gives; a level of queuing or worse drafts a derived
 * congestion situation, which replaces one of the same id.
 */
export function enrichDrafts(
  output: FlowOutput,
  baselines: ReadonlyMap<string, FlowBaseline>,
  opts: { source: SourceDescriptor; format: string },
): FlowOutput {
  const { source } = opts;
  const stated = new Set(
    output.observations
      .filter((o) => o["property"] === LOS)
      .map((o) => subjectKey(o as Parameters<typeof subjectKey>[0])),
  );
  const prefix = `oc:feature:${source.id}:`;
  const congestion: Parameters<typeof congestionDrafts>[0][number][] = [];
  let changed = false;
  const observations = output.observations.map((o) => {
    const subject = o["subject"] as Subject;
    const result = o["result"] as { type: string; value?: number };
    if (
      o["property"] !== SPEED ||
      subject.componentKey !== undefined ||
      o["baseline"] !== undefined ||
      result.type !== "quantity" ||
      result.value === undefined
    ) {
      return o;
    }
    const key = subjectKey(o as Parameters<typeof subjectKey>[0]);
    const baseline = baselines.get(key);
    if (stated.has(key) || baseline === undefined || !(baseline.freeFlowKph > 0)) return o;
    const ratio = result.value / baseline.freeFlowKph;
    const los = losFromSpeedRatio(ratio);
    changed = true;
    if (QUEUING_LOS.has(los) && subject.featureId.startsWith(prefix)) {
      const time = o["phenomenonTime"] as { instant?: string; end?: string };
      const location = o["location"] as { geometry: FlowGeometry; direction?: DirectionRef };
      congestion.push({
        site: subject.featureId.slice(prefix.length),
        geometry: location.geometry,
        at: (time.instant ?? time.end)!,
        los,
        fetchedAt: (o["freshness"] as { fetchedAt: string }).fetchedAt,
        freeFlowSource: baseline.method,
        ...(location.direction !== undefined ? { directionRef: location.direction } : {}),
      });
    }
    return {
      ...o,
      baseline: {
        freeFlow: { value: baseline.freeFlowKph, unit: "km/h" },
        source: baseline.method,
        ratio,
        los,
      },
    } as Draft;
  });
  if (!changed) return output;
  const derived = congestionDrafts(congestion, opts);
  const ids = new Set(derived.map((d) => d["id"]));
  return {
    features: output.features,
    observations,
    situations: [...output.situations.filter((s) => !ids.has(s["id"])), ...derived],
  };
}
