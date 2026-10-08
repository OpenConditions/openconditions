import type {
  FeedPayloads,
  ParseContext,
  ParseOutput,
  RecordDraft,
  StatusOutput,
} from "@openconditions/ingest-framework";
import { chargingDomain } from "../../domain.js";
import type { ChargingCatalogFeed } from "../../feed-schema.js";

/** The roles a charging format reads status from. */
export function statusRoles(format: string): string[] {
  return Object.entries(chargingDomain.formats[format]!.endpoints)
    .filter(([, role]) => role.status === true)
    .map(([role]) => role);
}

/**
 * A full parse of `payloads`, and a status-only parse of their status roles
 * (or `status`, when given) through the index the full parse returned.
 */
export function fullAndStatus(
  format: string,
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  status?: FeedPayloads,
): { full: ParseOutput; status: StatusOutput } {
  const f = chargingDomain.formats[format]!;
  const full = f.parse(feed, payloads, ctx);
  if (full.statusIndex === undefined)
    throw new Error(`${format}: the full parse returned no index`);
  const own =
    status ??
    Object.fromEntries(
      statusRoles(format).flatMap((role) =>
        payloads[role] === undefined ? [] : [[role, payloads[role]] as const],
      ),
    );
  if (f.parseStatus === undefined) throw new Error(`${format} has no parseStatus`);
  return { full, status: f.parseStatus(feed, own, ctx, full.statusIndex) };
}

/** Readings in id order, as the comparisons read them. */
export const byReadingId = (readings: readonly RecordDraft[]): RecordDraft[] =>
  [...readings].sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));
