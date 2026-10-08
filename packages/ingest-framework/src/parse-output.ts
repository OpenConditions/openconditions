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

/**
 * Where a live status record's reading belongs, as a format's full parse
 * placed it: the station that published the record, the charge point (and
 * connector) it names, and what else the format needs to read the status
 * without the snapshot.
 */
export interface StatusSubject {
  /** The station's own id: the reading's record id. */
  stationId: string;
  evseKey?: string;
  connectorId?: string;
  /** The station's `[lon, lat]`, which the reading is located at. */
  point?: readonly [number, number];
  /** The zone the publisher's times without an offset are in. */
  timeZone?: string;
  /**
   * The state the snapshot itself gave the record, as the source wrote it,
   * and when that state last changed: read where no status answer names the
   * record, as the full parse reads it.
   */
  snapshotStatus?: string;
  snapshotAt?: string;
  /** The site and component the parse moved the reading to, when it merged the station into one. */
  featureId?: string;
  componentKey?: string;
}

/**
 * The subjects of a feed's live status records by the record's own id (an
 * EVSE uid, a charge point id), as the format's last full parse found them.
 * A key may name several subjects where the snapshot repeats it.
 */
export type StatusIndex = ReadonlyMap<string, readonly StatusSubject[]>;

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
  /** A format that reads status alone: where its status records' readings belong. */
  statusIndex?: StatusIndex;
}

/** What a status-only poll parsed into: readings, and the status records it could not place. */
export interface StatusOutput {
  observations: RecordDraft[];
  rejected: number;
}

/** An empty parse output, to fill per class. */
export function emptyParseOutput(): ParseOutput {
  return { situations: [], features: [], observations: [], offers: [] };
}
