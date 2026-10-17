import { recordSkipped, type SkipReason } from "@openconditions/ingest-framework";

/** How a decoder is run. */
export interface DatexDecodeOptions {
  /**
   * The feed the records and values a decoder leaves unread are counted
   * under (`recordSkipped`). Without one nothing is counted.
   */
  sourceId?: string;
}

/** Count `count` skips for a reason under the options' feed, if it names one. */
export function skipped(options: DatexDecodeOptions, reason: SkipReason, count = 1): void {
  if (options.sourceId !== undefined) recordSkipped(options.sourceId, reason, count);
}
