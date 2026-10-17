/**
 * What the code does with each value a standard enumerates. A value is
 * either handled — read into the model — or listed as unsupported with the
 * reason it is not; nothing may be neither. `handled` is best a predicate
 * that runs the real parser over a record carrying the value, so the check
 * holds the parser, not a mapping table beside it.
 */
export interface CoverageSpec {
  handled: Iterable<string> | ((value: string) => boolean);
  /** Values deliberately left unread, each with the reason. */
  unsupported?: Readonly<Record<string, string>>;
}

export interface CoverageGaps {
  /** Standard values neither handled nor listed as unsupported. */
  unhandled: string[];
  /** Values listed as unsupported that the standard does not enumerate. */
  stale: string[];
  /** Values listed as unsupported that the code handles after all. */
  contradictory: string[];
}

export function coverageGaps(values: readonly string[], spec: CoverageSpec): CoverageGaps {
  const handledSet = typeof spec.handled === "function" ? undefined : new Set(spec.handled);
  const handles =
    typeof spec.handled === "function" ? spec.handled : (value: string) => handledSet!.has(value);
  const unsupported = spec.unsupported ?? {};
  const standard = new Set(values);
  const handledValues = values.filter((v) => handles(v));
  return {
    unhandled: values.filter((v) => !handledValues.includes(v) && !(v in unsupported)),
    stale: Object.keys(unsupported).filter((v) => !standard.has(v)),
    contradictory: handledValues.filter((v) => v in unsupported),
  };
}

/**
 * Throws, listing every gap, unless each of the standard's values is handled
 * or listed as unsupported, and the unsupported list holds only standard
 * values the code does not handle.
 */
export function assertCovered(label: string, values: readonly string[], spec: CoverageSpec): void {
  if (values.length === 0) throw new Error(`${label}: the standard enumerates no values`);
  const gaps = coverageGaps(values, spec);
  const lines = [
    ...(gaps.unhandled.length
      ? [`neither handled nor listed as unsupported: ${gaps.unhandled.join(", ")}`]
      : []),
    ...(gaps.stale.length
      ? [`listed as unsupported but not in the standard: ${gaps.stale.join(", ")}`]
      : []),
    ...(gaps.contradictory.length
      ? [`listed as unsupported but handled: ${gaps.contradictory.join(", ")}`]
      : []),
  ];
  if (lines.length > 0) throw new Error(`${label}:\n  ${lines.join("\n  ")}`);
}
