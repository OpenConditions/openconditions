import type { ParseOutput } from "@openconditions/ingest-framework";

/** What a situations format counted while it read its source records. */
export interface ReadCounts {
  /** Source records read, rejected, repeated and terminal ones included. */
  inputCount: number;
  /** Records whose id an earlier record of the same parse already took. */
  duplicates: number;
  /** Records that could not be used (a bad shape, a missing field), counted once per record. */
  rejected: number;
  /** Records that end here by design (a type the feed leaves to another source). */
  terminal?: number;
  /**
   * How many source records a drafted situation folds, by situation id; one
   * for each situation not listed (a fire merged from its perimeter and its
   * incident point folds two).
   */
  folded?: Readonly<Record<string, number>>;
}

/**
 * The record accounting of a complete-snapshot situations format that is not
 * CAP, written onto its output: `uniqueCount` is the records read less the
 * repeated ones (rejected and terminal records are unique), `accepted` the
 * situations emitted, and `situationRecords` the source records each folds.
 * A poll that read nothing is an accounted zero, which publishes zero
 * instead of being refused.
 */
export function accountSituations(out: ParseOutput, counts: ReadCounts): void {
  out.records = {
    inputCount: counts.inputCount,
    uniqueCount: counts.inputCount - counts.duplicates,
    duplicates: counts.duplicates,
    accepted: out.situations.length,
    terminal: counts.terminal ?? 0,
    unlocatable: 0,
    unlocatableSituations: [],
    unlocatableRecords: [],
    situationRecords: Object.fromEntries(
      out.situations.map((s) => [String(s["id"]), counts.folded?.[String(s["id"])] ?? 1]),
    ),
  };
  if (counts.rejected > 0) out.rejected = counts.rejected;
}
