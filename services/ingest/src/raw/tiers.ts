import type { RawTier } from "@openconditions/core/server";
import type { CatalogFeed } from "@openconditions/ingest-framework";
import { formatOf } from "../domains.js";

/**
 * How long a source's raw payloads may be kept, from its rights: a source
 * whose rights forbid retention keeps none (undefined), one whose rights do
 * not say keeps the last 48 hours only (`hot`), and one that affirms
 * retention keeps its class's full tiers. A feed's responses are situation
 * or observation payloads by its format's kind, unless it says otherwise;
 * its reference data (a site table, a station registry) is a reference payload.
 */
export function rawTierFor(
  src: Pick<CatalogFeed, "id" | "domain" | "format" | "rights" | "rawRetention">,
  payload: "feed" | "reference",
): RawTier | undefined {
  const retention = src.rights.retention;
  if (retention === false) return undefined;
  if (retention !== true) return "hot";
  if (payload === "reference") return "reference";
  return src.rawRetention ?? (formatOf(src).kind === "measurements" ? "observation" : "situation");
}
