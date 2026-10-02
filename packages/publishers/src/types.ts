/** Feed-level metadata carried by every emitter (foreign members / headers). */
export interface FeedInfo {
  /** Human-readable publisher, e.g. "OpenConditions". */
  attribution?: string;
  /** SPDX or short license id for the aggregate feed. */
  license?: string;
  url?: string;
  /** Generation timestamp (ISO 8601). Pass it in — emitters are pure. */
  timestamp?: string;
}
