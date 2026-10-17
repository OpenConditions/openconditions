import type { SkipReason } from "@openconditions/ingest-framework";

/**
 * The smallest poll of one format that holds exactly one record the format
 * must drop, or one value it cannot read, and the reason it must report.
 */
export interface SkipSample {
  /** The one skip the parse reports. */
  reason: SkipReason;
  /** Payload bodies by endpoint role. */
  payloads: Readonly<Record<string, string | readonly string[]>>;
  /** Feed fields the format reads beyond the minimal definition (a layout block, a mapping). */
  feed?: Readonly<Record<string, unknown>>;
  /** Decoded reference data by role (a site table, a station registry). */
  reference?: Readonly<Record<string, unknown>>;
}

/** Samples keyed `<domain>/<format>`. */
export type SkipSamples = Readonly<Record<string, SkipSample>>;

/** Formats with no sample, keyed `<domain>/<format>`, each with why it needs none. */
export type SkipExemptions = Readonly<Record<string, string>>;
