/** A record a parser produced, before the write seam seals it: plain data the registry validates. */
export type RecordDraft = Record<string, unknown>;

/**
 * How a complete-snapshot source accounted for every input record of one poll.
 * Counts are of source records; a record served by two partitions counts once.
 */
export interface SnapshotAccounting {
  inputCount: number;
  uniqueCount: number;
  duplicates: number;
  accepted: number;
  terminal: number;
  /** Records still published whose place could not be read this poll. */
  unlocatable: number;
  /** The situations those records belong to: a poll that cannot place them must not end them. */
  unlocatableSituations: string[];
  /** The source's local ids of those records, which their effects' ids begin with. */
  unlocatableRecords: string[];
  /** Per drafted situation id, how many accepted records it folds. */
  situationRecords: Record<string, number>;
}

/** What one poll of a feed parsed into, per record class. */
export interface ParseOutput {
  situations: RecordDraft[];
  features: RecordDraft[];
  observations: RecordDraft[];
  offers: RecordDraft[];
  /** A complete-snapshot source's record accounting. */
  records?: SnapshotAccounting;
  /** Source records the parse could not use (a station with no usable position), counted as rejected. */
  rejected?: number;
}

/** An empty parse output, to fill per class. */
export function emptyParseOutput(): ParseOutput {
  return { situations: [], features: [], observations: [], offers: [] };
}
