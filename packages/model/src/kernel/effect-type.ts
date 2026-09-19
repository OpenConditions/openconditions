import type { z } from "zod";
import type { EffectEntry } from "../registry/define.js";
import type { KernelBase } from "./build.js";
import type { KERNEL_EFFECTS } from "./effect.js";

type EffectBaseShape = KernelBase["effectBaseShape"];
type VariantOf<E> =
  E extends EffectEntry<infer C, infer S>
    ? z.infer<z.ZodObject<EffectBaseShape & S & { kind: z.ZodLiteral<C>; v: z.ZodNumber }>>
    : never;

/** The kernel's effect variants as a discriminated TS union (domain variants validate at runtime). */
export type Effect = VariantOf<(typeof KERNEL_EFFECTS)[number]>;
export type EffectKind = Effect["kind"];

/** KernelBase plus the registry's assembled Effect union — what kind `details` factories receive. */
export type Kernel = KernelBase & { Effect: z.ZodType<Effect> };
