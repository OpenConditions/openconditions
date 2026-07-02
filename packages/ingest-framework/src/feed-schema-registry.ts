import type { ZodTypeAny } from "zod";

// Per-domain feed schemas, registered by each domain owner at import time so the
// framework can validate loaded/mounted/remote descriptors without depending on
// any domain package.
const schemas = new Map<string, ZodTypeAny>();

export function registerFeedSchema(domain: string, schema: ZodTypeAny): void {
  schemas.set(domain, schema);
}

export function feedSchemaFor(domain: string): ZodTypeAny {
  const s = schemas.get(domain);
  if (!s) throw new Error(`No feed schema registered for domain "${domain}"`);
  return s;
}
