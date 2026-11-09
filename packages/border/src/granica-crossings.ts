import type { BorderCrossing } from "./crossings.js";
import snapshot from "./snapshots/granica.json" with { type: "json" };

/** Qualified official unit aliases and independent CC0 coordinate receipts. */
export interface GranicaCrossing extends BorderCrossing {
  unit: string;
  aliases: readonly string[];
  revision: string;
  retrievedAt: string;
  evidence: "entity-json" | "indexed-entity-page";
}

/** Regenerate from captured evidence with gen-border-crossings.ts --granica --offline. */
export const GRANICA_CROSSINGS = snapshot as readonly GranicaCrossing[];
