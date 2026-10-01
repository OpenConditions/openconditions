import { z } from "zod";
import { observationId } from "../classes/observation.js";
import { canonicalIdOf } from "../kernel/identity.js";
import { kernelModule } from "../kernel/module.js";
import { buildRegistry } from "../registry/build.js";
import {
  defineDomain,
  defineKind,
  defineProperty,
  defineResultSchema,
  extendVocabulary,
  type NestedEffect,
  type RegistryModule,
} from "../registry/define.js";

/** A registry module shaped like a real domain package, for tests only. */
export const testModule: RegistryModule = {
  name: "test",
  entries: [
    defineDomain({ code: "roads", description: "test roads" }),
    extendVocabulary({ vocabulary: "source_format", values: ["datex2"] }),
    extendVocabulary({ vocabulary: "issue_code", values: ["datex_unknown_record"] }),
    defineKind({
      class: "situation",
      code: "incident",
      domain: "roads",
      version: "1.2",
      description: "test incident",
      types: { accident: ["multi_vehicle", "overturned"], breakdown: [] },
      details: () => ({ vehiclesInvolved: z.number().int().nonnegative().optional() }),
    }),
    defineKind({
      class: "situation",
      code: "roadworks",
      domain: "roads",
      version: "1.0",
      description: "test roadworks with phases",
      types: { works: ["resurfacing"] },
      details: (k) => ({
        phases: z
          .array(
            z.strictObject({ id: z.string(), validity: k.Validity, effects: z.array(k.Effect) }),
          )
          .optional(),
      }),
      nestedEffects: (d) =>
        (
          (d["phases"] as
            | {
                id: string;
                validity: NestedEffect["validity"];
                effects: NestedEffect["effect"][];
              }[]
            | undefined) ?? []
        ).flatMap((p) =>
          p.effects.map((effect) => ({ phaseId: p.id, validity: p.validity, effect })),
        ),
    }),
    defineKind({
      class: "feature",
      code: "measurement_site",
      domain: "roads",
      version: "1.0",
      description: "test site",
      types: { traffic: [], combined: [] },
      details: () => ({ measuredProperties: z.array(z.string()).min(1) }),
      components: ["sensor_channel"],
    }),
    defineKind({
      class: "offer",
      code: "toll",
      domain: "roads",
      version: "1.0",
      description: "test toll",
    }),
    defineResultSchema({
      code: "border_wait",
      version: "1.0",
      description: "test structured result",
      shape: () => ({ waitMinutes: z.number().nonnegative() }),
    }),
    defineProperty({
      code: "traffic.speed",
      domain: "roads",
      version: "1.0",
      description: "test speed",
      result: { type: "quantity", unit: "km/h" },
      subjects: [{ kind: "feature", componentKinds: ["sensor_channel"] }, { kind: "segments" }],
    }),
    defineProperty({
      code: "traffic.los",
      domain: "roads",
      version: "1.0",
      description: "test los",
      result: { type: "category", vocabulary: "los" },
      subjects: [{ kind: "feature" }],
    }),
    defineProperty({
      code: "fuel.price",
      domain: "roads",
      version: "1.0",
      description: "test money with a qualifier",
      result: { type: "money", per: ["L", "kg"] },
      subjects: [{ kind: "location" }],
      qualifiers: () => ({ product: z.enum(["e5", "diesel"]) }),
    }),
    defineProperty({
      code: "border.wait",
      domain: "roads",
      version: "1.0",
      description: "test structured",
      result: { type: "structured", schema: "border_wait" },
      subjects: [{ kind: "feature" }],
    }),
  ],
};

export const registry = buildRegistry([kernelModule, testModule]);

const NOW = "2026-09-18T10:00:00Z";

export function draftBase(cls: "situation" | "feature" | "observation" | "offer", localId: string) {
  return {
    id: `oc:${cls}:de-ndw:${localId}`,
    temporality: "live",
    location: {
      geometry: { type: "Point", coordinates: [4.9, 52.37] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
    provenance: {
      origin: "feed",
      sourceId: "de-ndw",
      sourceFormat: "datex2",
      accessMode: "bulk",
      recordId: localId,
      attribution: { provider: "NDW", license: "CC0-1.0" },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: NOW },
  };
}

/** An observation draft with its id derived from its series and phenomenon start. */
export function withObservationId<T extends { id: string }>(draft: T): T {
  const namespace = draft.id.split(":")[2]!;
  return { ...draft, id: observationId(namespace, draft as never) };
}

export function stored<T extends { id: string; provenance: object }>(draft: T, domain = "roads") {
  const [, , ns, ...rest] = draft.id.split(":");
  return {
    ...draft,
    provenance: { ...draft.provenance, instanceId: "local" },
    canonicalId: canonicalIdOf(ns!, rest.join(":")),
    domain,
    contentHash: "0".repeat(64),
    revision: 1,
    recordedAt: NOW,
  };
}

export const allVehicles = { kind: "all" } as const;

export function closure(id: string) {
  return {
    id,
    kind: "closure",
    v: 1,
    scope: "road",
    applicability: allVehicles,
    compliance: "mandatory",
    normalization: "complete",
  };
}

export function incidentDraft() {
  return {
    ...draftBase("situation", "SIT-1"),
    class: "situation",
    kind: "incident",
    type: "accident",
    subtype: "overturned",
    planned: false,
    certainty: "observed",
    severity: { label: "major", source: "declared", declaredRaw: "high" },
    validity: { status: "active", start: "2026-09-18T09:00:00Z" },
    effects: [closure("SIT-1/closure")],
    details: { kind: "incident", v: 1, vehiclesInvolved: 2 },
  };
}
