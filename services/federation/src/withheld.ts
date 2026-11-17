/**
 * The warning for a record too large to federate: a journal entry larger than
 * a whole page may be is stepped over by every page (`readOutbox`), so no peer
 * receives it. It is said once per record and process, from every place that
 * serves or pushes journal pages, so the operator learns of it without a line
 * per page.
 */
import type { WithheldEntry } from "@openconditions/federation";

const warned = new Set<string>();

/** Warns of each withheld record not warned of before in this process. */
export function warnWithheld(
  withheld: readonly WithheldEntry[],
  warn: (line: string) => void = console.warn,
): void {
  for (const { recordClass, recordId, bytes } of withheld) {
    if (warned.has(recordId)) continue;
    warned.add(recordId);
    warn(`[federation-api] ${recordClass} ${recordId} is too large to federate (${bytes} bytes)`);
  }
}
