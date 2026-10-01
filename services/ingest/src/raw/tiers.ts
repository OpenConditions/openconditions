import type { RawTier } from "@openconditions/core/server";
import type { FeedSourceBase } from "@openconditions/ingest-framework";

/**
 * How long a source's raw payloads may be kept, from its terms: a source
 * whose rights forbid retention keeps none (undefined), one whose rights do
 * not say keeps the first 48 hours only (`hot`), and one that affirms
 * retention keeps its class's full tiers. A feed's responses are situation
 * or observation payloads by what it produces, unless it says otherwise;
 * its site table or station registry is a reference payload.
 */
export function rawTierFor(
  src: Pick<FeedSourceBase, "rights" | "produces" | "rawRetention">,
  payload: "feed" | "reference",
): RawTier | undefined {
  const retention = src.rights?.retention;
  if (retention === false) return undefined;
  if (retention !== true) return "hot";
  if (payload === "reference") return "reference";
  return src.rawRetention ?? (src.produces === "flow" ? "observation" : "situation");
}
