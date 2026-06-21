import type { Severity, SourceFormat } from "./model.js";

export interface NormalisedSeverity {
  severity: Severity;
  severitySource: "declared";
}

const OPEN511_MAP: Record<string, Severity> = {
  MINOR: "low",
  MODERATE: "medium",
  MAJOR: "high",
  UNKNOWN: "unknown",
};

const DATEX2_MAP: Record<string, Severity> = {
  lowest: "low",
  low: "low",
  medium: "medium",
  high: "high",
  highest: "critical",
  unknown: "unknown",
  none: "unknown",
};

/**
 * Map a declared severity string from a feed format to the canonical Severity.
 * Returns severitySource:"declared" always — caller sets "derived" when using deriveSeverity.
 */
export function normaliseSeverity(
  raw: string,
  opts: { format: SourceFormat | string },
): NormalisedSeverity {
  let severity: Severity = "unknown";

  if (opts.format === "open511") {
    severity = OPEN511_MAP[raw.toUpperCase()] ?? "unknown";
  } else if (opts.format === "datex2") {
    severity = DATEX2_MAP[raw.toLowerCase()] ?? "unknown";
  }

  return { severity, severitySource: "declared" };
}

export interface DeriveImpact {
  roadState?: "open" | "some_lanes_closed" | "single_lane_alternating" | "closed";
  lanesAffected?: { closed?: number; total?: number };
}

/**
 * Derive severity from impact fields when the feed does not declare one.
 * Rule (from spec §4.10):
 *   closed roadState OR all lanes closed → high
 *   some lanes closed (fraction > 1/3) → medium
 *   minor lane impact (fraction ≤ 1/3) → low
 *   no signal → unknown
 */
export function deriveSeverity(impact: DeriveImpact): Severity {
  if (impact.roadState === "closed") {
    return "high";
  }

  if (impact.lanesAffected) {
    const { closed = 0, total = 0 } = impact.lanesAffected;
    if (total > 0 && closed >= total) {
      return "high";
    }
    if (total > 0 && closed > 0) {
      const fraction = closed / total;
      return fraction >= 1 / 3 ? "medium" : "low";
    }
  }

  if (
    impact.roadState === "some_lanes_closed" ||
    impact.roadState === "single_lane_alternating"
  ) {
    return "medium";
  }

  return "unknown";
}
