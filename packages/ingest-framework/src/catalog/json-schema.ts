import { z } from "zod";
import type { IngestDomain } from "./domain.js";
import { LICENSES } from "./licenses.js";
import {
  credentialsFileSchema,
  endpointSchema,
  feedBaseShape,
  regionFileSchema,
} from "./schema.js";

type Override = NonNullable<Parameters<typeof z.toJSONSchema>[1]>["override"];

/**
 * Editors (VS Code, JetBrains) validate a JSONC file against its `$schema`, and
 * flag trailing commas unless the schema allows them. Every check must have a
 * JSON Schema: a domain's `z.custom` without one fails the generation rather
 * than accepting any value. `override` adds what the zod schema leaves to the
 * lint, such as the closed lists a field's value comes from.
 */
function forJsonc(schema: z.ZodType, override?: Override): object {
  return {
    ...z.toJSONSchema(schema, { io: "input", ...(override ? { override } : {}) }),
    allowTrailingCommas: true,
  };
}

/** The decoders a domain's formats name for their reference endpoints, sorted. */
function domainDecoders(domain: IngestDomain): string[] {
  const decoders = Object.values(domain.formats).flatMap((format) =>
    Object.values(format.endpoints).flatMap((role) => role.decoders ?? []),
  );
  return [...new Set(decoders)].sort();
}

/**
 * The JSON Schema of a `feeds/<domain>/<region>.jsonc` file: what a maintainer
 * writes, with the domain's products, formats and decoders and the licence
 * registry's ids as enums, so an editor completes them.
 */
export function regionFileJsonSchema(domain: IngestDomain): object {
  // Keyed by schema instance: the base fields every domain shape spreads in.
  const enums = new Map<unknown, readonly string[]>([
    [feedBaseShape.product, domain.products],
    [feedBaseShape.format, Object.keys(domain.formats).sort()],
    [feedBaseShape.license, LICENSES.map((l) => l.id)],
    [endpointSchema.shape.decoder.unwrap(), domainDecoders(domain)],
  ]);
  return forJsonc(regionFileSchema(domain.feedShape), (ctx) => {
    const values = enums.get(ctx.zodSchema);
    if (values) ctx.jsonSchema.enum = [...values];
  });
}

/** The JSON Schema of `feeds/credentials.jsonc`. */
export function credentialsFileJsonSchema(): object {
  return forJsonc(credentialsFileSchema);
}
