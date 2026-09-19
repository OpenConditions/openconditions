import type { Registry } from "./build.js";
import type { KindClass } from "./define.js";

/** Registry-governed codes a database holds, gathered at boot. */
export interface HeldCodes {
  sourceFormats?: readonly string[];
  kinds?: readonly { class: KindClass; code: string }[];
  properties?: readonly string[];
}

export class RegistryCoverageError extends Error {
  constructor(readonly gaps: readonly string[]) {
    super(
      `the database holds codes this registry does not register: ${gaps.join(", ")}. ` +
        "Deploy the domain package that registers them, or remove the rows.",
    );
  }
}

/**
 * The held codes the registry does not register. Columns whose values domain
 * modules contribute carry no CHECK constraint (a new property must not need
 * a table-locking migration), so this is the check that a database and the
 * running registry agree.
 */
export function uncoveredCodes(registry: Registry, held: HeldCodes): string[] {
  const formats = new Set(registry.vocabulary("source_format")?.values ?? []);
  return [
    ...(held.sourceFormats ?? []).filter((f) => !formats.has(f)).map((f) => `source_format "${f}"`),
    ...(held.kinds ?? [])
      .filter((k) => registry.kind(k.class, k.code) === undefined)
      .map((k) => `${k.class} kind "${k.code}"`),
    ...(held.properties ?? [])
      .filter((p) => registry.property(p) === undefined)
      .map((p) => `property "${p}"`),
  ];
}

/** Throws RegistryCoverageError when the database holds an unregistered code. */
export function assertRegistryCovers(registry: Registry, held: HeldCodes): void {
  const gaps = uncoveredCodes(registry, held);
  if (gaps.length > 0) throw new RegistryCoverageError(gaps);
}
