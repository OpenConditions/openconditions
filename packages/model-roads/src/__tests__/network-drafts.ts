import { buildRegistry, kernelModule, observationId } from "@openconditions/model";
import { roadsModule } from "../module.js";

/** The roads module on its own, and draft builders for its network, winter, travel-time and toll kinds. */
export const registry = buildRegistry([kernelModule, roadsModule]);
const FETCHED = "2026-09-29T21:10:00Z";

export const base = (cls: "feature" | "observation" | "offer", localId: string) => ({
  id: `oc:${cls}:no-nvdb:${localId}`,
  temporality: cls === "observation" ? "live" : "static",
  location: {
    geometry: { type: "Point", coordinates: [7.0547757, 60.89309225] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  },
  provenance: {
    origin: "feed",
    sourceId: "no-nvdb",
    sourceFormat: "datex2",
    accessMode: "bulk",
    recordId: localId,
    attribution: { provider: "Statens vegvesen", license: "NLOD-2.0" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: FETCHED },
});

export const m = (value: number) => ({ value, unit: "m" });

export const feature = (kind: string, localId: string, details: object, extra: object = {}) => ({
  ...base("feature", localId),
  class: "feature",
  kind,
  lifecycle: "operational",
  details: { kind, v: 1, ...details },
  ...extra,
});

export function observation(
  subject: { id: string },
  property: string,
  result: unknown,
  qualifiers?: object,
) {
  const draft = {
    ...base("observation", "x"),
    class: "observation",
    kind: "observation",
    property,
    subject: { kind: "feature", featureId: subject.id },
    ...(qualifiers === undefined ? {} : { qualifiers }),
    result,
    phenomenonTime: { instant: "2026-09-29T21:00:00Z" },
    aggregation: "instantaneous",
  };
  return { ...draft, id: observationId("no-nvdb", draft as never) };
}

/** Validates a draft and fails with its issues, so a failing case says why. */
export const ok = (record: unknown) => {
  const result = registry.validateDraft(record);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return true;
};
