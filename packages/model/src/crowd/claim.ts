import { z } from "zod";
import type { Effect } from "../kernel/effect-type.js";
import { FUZZINESS } from "../kernel/location.js";
import type { Result } from "../kernel/result.js";
import { Iso8601, PointGeometry, type RecordRef } from "../kernel/scalars.js";
import type { LocationRef } from "../kernel/types.js";
import type { Registry, ValidationIssue, ValidationResult } from "../registry/build.js";
import { majorOf } from "../registry/define.js";

/**
 * What a reporter signs. A claim is the reporter's statement only: who they
 * are, which instance lands it and how it is trusted are added on landing and
 * never signed. The signature covers the claim's RFC 8785 bytes, so a claim
 * is plain JSON.
 */
export const CLAIM_CLASSES = ["situation", "observation"] as const;
export const SUB_CLAIM_TYPES = ["confirm", "negate", "flag"] as const;

/** Anti-replay token: 16–64 characters of [A-Za-z0-9_-]. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const Nonce = z.string().regex(NONCE_PATTERN);
const MAX_REASON_CHARS = 2000;

type Geometry = NonNullable<LocationRef["geometry"]>;
type Point = { type: "Point"; coordinates: [number, number] | [number, number, number] };
type Text = { lang: string; text: string; machine?: true }[];

/** "Something is happening here": a situation the reporter sees. */
export interface SituationClaim {
  claimClass: "situation";
  kind: string;
  type: string;
  subtype?: string;
  geometry: Geometry;
  fuzziness: (typeof FUZZINESS)[number];
  severityLevel?: 1 | 2 | 3 | 4 | 5;
  effects?: Effect[];
  /** The kind's details, for a kind that requires some (a queue's level of service). */
  details?: Record<string, unknown>;
  text?: Text;
  reportedAt: string;
  nonce: string;
}

/** "This is the value now": a reading of a property of a feature or a place. */
export interface ObservationClaim {
  claimClass: "observation";
  subject: { featureId: string; componentKey?: string } | { location: LocationRef };
  property: string;
  qualifiers?: Record<string, unknown>;
  result: Result;
  /**
   * Where the reporter stood: checked against where the subject stands on
   * landing; this field is never stored as it is (a place the claim names in
   * `subject` is its own location, not this point). A reading of a feature no public
   * source holds is placed at the centre of the area cell this point falls
   * in, at low resolution.
   */
  geometry: Point;
  reportedAt: string;
  nonce: string;
}

export type ReportClaim = SituationClaim | ObservationClaim;

/** A reporter's reaction to any record: it is still there, it is gone, or it is wrong. */
export interface SubClaimBody {
  subject: RecordRef;
  claimType: (typeof SUB_CLAIM_TYPES)[number];
  /** Why a record is flagged. */
  reason?: string;
  /** Where the reporter stood. */
  geometry?: Point;
  reportedAt: string;
  nonce: string;
}

const schemas = new WeakMap<Registry, z.ZodType>();

/**
 * The claim schema of a registry: a situation claim names a kind the crowd
 * may report, with a registered type and subtype, kernel effects and the
 * kind's own details; an observation claim names a property the crowd may
 * report, a subject the property allows, and the result and qualifiers its
 * observations carry.
 */
export function claimSchema(registry: Registry): z.ZodType<ReportClaim> {
  const cached = schemas.get(registry);
  if (cached) return cached as z.ZodType<ReportClaim>;
  const k = registry.kernel;
  const crowdKinds = registry.kinds("situation").filter((e) => e.crowd !== undefined);
  const crowdProperties = registry.properties().filter((p) => p.crowd !== undefined);
  const enumOrNever = (codes: string[]) =>
    codes.length === 0 ? z.never() : z.enum(codes as [string, ...string[]]);

  const situation = z
    .strictObject({
      claimClass: z.literal("situation"),
      kind: enumOrNever(crowdKinds.map((e) => e.code)),
      type: z.string().min(1),
      subtype: z.string().min(1).optional(),
      geometry: k.Geometry,
      fuzziness: z.enum(FUZZINESS),
      severityLevel: z.number().int().min(1).max(5).optional(),
      effects: z.array(k.Effect).min(1).optional(),
      details: z.record(z.string(), z.unknown()).optional(),
      text: k.Text.optional(),
      reportedAt: Iso8601,
      nonce: Nonce,
    })
    .superRefine((c, ctx) => {
      const entry = registry.kind("situation", c.kind)!;
      const subtypes = entry.types?.[c.type];
      if (subtypes === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["type"],
          message: `"${c.type}" is not a type of ${c.kind}`,
        });
        return;
      }
      if (c.subtype !== undefined && !subtypes.includes(c.subtype)) {
        ctx.addIssue({
          code: "custom",
          path: ["subtype"],
          message: `"${c.subtype}" is not a subtype of ${c.kind}.${c.type}`,
        });
      }
      const ids = (c.effects ?? []).map((e) => e.id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", path: ["effects"], message: "effect ids repeat" });
      }
      const details = c.details ?? { kind: c.kind, v: majorOf(entry.version) };
      const parsed = registry.detailsSchema("situation", c.kind)!.safeParse(details);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: ["details", ...issue.path.map(String)],
            message: issue.message,
          });
        }
      }
    });

  const observation = z
    .strictObject({
      claimClass: z.literal("observation"),
      subject: z.union([
        z.strictObject({
          featureId: z.string().min(1),
          componentKey: z.string().min(1).optional(),
        }),
        z.strictObject({ location: k.LocationRef }),
      ]),
      property: enumOrNever(crowdProperties.map((p) => p.code)),
      qualifiers: z.record(z.string(), z.unknown()).optional(),
      result: z.record(z.string(), z.unknown()),
      geometry: PointGeometry,
      reportedAt: Iso8601,
      nonce: Nonce,
    })
    .superRefine((c, ctx) => {
      const entry = registry.property(c.property)!;
      const kind = "featureId" in c.subject ? "feature" : "location";
      if (!entry.subjects.some((s) => s.kind === kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["subject"],
          message: `${c.property} is not observed about a ${kind}`,
        });
      }
      const parts = registry.observationParts(c.property)!;
      for (const [field, schema, value] of [
        ["result", parts.result, c.result],
        ["qualifiers", parts.qualifiers, c.qualifiers],
      ] as const) {
        const parsed = schema.safeParse(value);
        if (parsed.success) continue;
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: [field, ...issue.path.map(String)],
            message: issue.message,
          });
        }
      }
    });

  const schema = z.discriminatedUnion("claimClass", [situation, observation]);
  schemas.set(registry, schema);
  return schema as unknown as z.ZodType<ReportClaim>;
}

const issuesOf = (error: z.ZodError): ValidationIssue[] =>
  error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
    code: i.code,
    message: i.message,
  }));

/** Hard validation of a report claim against a registry. */
export function validateClaim(registry: Registry, claim: unknown): ValidationResult<ReportClaim> {
  const parsed = claimSchema(registry).safeParse(claim);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: issuesOf(parsed.error) };
}

export const SubClaimBodySchema = z.strictObject({
  subject: z
    .strictObject({
      class: z.enum(["feature", "situation", "observation", "offer"]),
      id: z.string().min(1),
      componentKey: z.string().min(1).optional(),
    })
    .refine((ref) => ref.componentKey === undefined || ref.class === "feature", {
      message: "only a feature has components",
      path: ["componentKey"],
    }),
  claimType: z.enum(SUB_CLAIM_TYPES),
  reason: z.string().min(1).max(MAX_REASON_CHARS).optional(),
  geometry: PointGeometry.optional(),
  reportedAt: Iso8601,
  nonce: Nonce,
});

/** Hard validation of a sub-claim body; it needs no registry, since it names a record, not a kind. */
export function validateSubClaim(body: unknown): ValidationResult<SubClaimBody> {
  const parsed = SubClaimBodySchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data as SubClaimBody }
    : { ok: false, issues: issuesOf(parsed.error) };
}
