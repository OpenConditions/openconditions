import { z } from "zod";

/**
 * Resolves a registry-extensible vocabulary to the schema that validates it.
 * Kernel schemas are built through a resolver rather than at module load
 * because a domain package can add values to an extensible vocabulary: the
 * closed `z.enum` only exists once every registry module is known.
 */
export type Vocab = (code: string) => z.ZodType<string>;

/** A resolver that accepts any non-empty string, for building the kernel's static types. */
export const anyVocab: Vocab = () => z.string().min(1);

/** `z.enum` over a registry value list; an empty vocabulary accepts nothing. */
export function enumOf(values: readonly string[]): z.ZodType<string> {
  if (values.length === 0) return z.never();
  return z.enum(values as [string, ...string[]]);
}
