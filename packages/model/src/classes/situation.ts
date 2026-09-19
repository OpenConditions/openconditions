import { z } from "zod";
import type { Kernel } from "../kernel/effect-type.js";
import { checkRecordBase, recordBaseShape, type Stage } from "../kernel/record-base.js";
import type { KindEntry, SelectorEntry } from "../registry/define.js";

export const SEVERITY_LABELS = ["minor", "moderate", "major", "critical", "unknown"] as const;
export const CERTAINTIES = ["observed", "likely", "possible", "unlikely", "unknown"] as const;
export const COMMENT_TYPES = ["public", "operator", "detour", "internal"] as const;
/** Vocabulary `cause`; crosswalks to DATEX/Road511/GTFS-RT/TraFF are registry mappings. */
export const CAUSES = [
  "accident",
  "breakdown",
  "debris",
  "spill",
  "fire",
  "police_activity",
  "animal",
  "congestion",
  "hazard",
  "weather",
  "roadworks",
  "maintenance",
  "construction",
  "public_event",
  "security",
  "infrastructure_failure",
  "equipment_failure",
  "flooding",
  "landslide",
  "avalanche",
  "wildfire",
  "strike",
  "demonstration",
  "medical_emergency",
  "obstruction",
  "abnormal_load",
  "military",
  "customs",
  "unknown",
  "other",
] as const;

export function situationSchema(
  k: Kernel,
  entry: KindEntry,
  details: z.ZodType,
  selectors: readonly SelectorEntry[],
  stage: Stage,
) {
  const types = Object.keys(entry.types ?? {});
  const affectsShape = Object.fromEntries(selectors.map((s) => [s.code, s.schema(k).optional()]));
  return z
    .strictObject({
      ...recordBaseShape(k, stage),
      class: z.literal("situation"),
      kind: z.literal(entry.code),
      type: types.length > 0 ? z.enum(types as [string, ...string[]]) : z.never(),
      subtype: z.string().min(1).optional(),
      causes: z
        .array(
          z.strictObject({
            type: k.vocab("cause"),
            text: k.Text.optional(),
            primary: z.boolean().optional(),
            situationRef: z.string().min(1).optional(),
          }),
        )
        .min(1)
        .optional(),
      planned: z.boolean(),
      certainty: z.enum(CERTAINTIES),
      severity: z.strictObject({
        label: z.enum(SEVERITY_LABELS),
        level: z
          .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
          .optional(),
        source: z.enum(["declared", "derived"]).optional(),
        declaredRaw: z.string().min(1).optional(),
      }),
      headline: k.Text.optional(),
      description: k.Text.optional(),
      instruction: k.Text.optional(),
      comments: z
        .array(z.strictObject({ type: z.enum(COMMENT_TYPES).optional(), text: k.Text }))
        .min(1)
        .optional(),
      validity: k.Validity,
      effects: z.array(k.Effect),
      affects: z.strictObject(affectsShape).optional(),
      groupId: z.string().min(1).optional(),
      details,
    })
    .superRefine((s, ctx) => {
      checkRecordBase(s, "situation", entry.domain, ctx);
      if (s.subtype !== undefined && !(entry.types?.[s.type] ?? []).includes(s.subtype)) {
        ctx.addIssue({
          code: "custom",
          path: ["subtype"],
          message: `subtype "${s.subtype}" is not registered for ${entry.code}.${s.type}`,
        });
      }
      const unknown = s.severity.label === "unknown";
      if (unknown !== (s.severity.source === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["severity", "source"],
          message: 'severity.source is absent exactly when the label is "unknown"',
        });
      }
      const nested = entry.nestedEffects?.(s.details as Record<string, unknown>) ?? [];
      const seen = new Set<string>();
      for (const effect of [...s.effects, ...nested]) {
        if (seen.has(effect.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["effects"],
            message: `duplicate effect id "${effect.id}"`,
          });
        }
        seen.add(effect.id);
      }
    });
}
