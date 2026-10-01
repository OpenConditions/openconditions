import { CAP_1_2 } from "../vocabularies/cap.js";

/**
 * CAP crosswalks: CAP 1.2's verbatim tokens onto the snake-cased `cap_*`
 * vocabularies (`AllClear` → `all_clear`), and CAP severity and certainty
 * onto the situation's own.
 */
const snake = (tokens: readonly string[]): Readonly<Record<string, string>> =>
  Object.fromEntries(tokens.map((t) => [t, t.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()]));

export const CAP_STATUSES = snake(CAP_1_2.status);
export const CAP_MSG_TYPES = snake(CAP_1_2.msgType);
export const CAP_SCOPES = snake(CAP_1_2.scope);
export const CAP_CATEGORIES = snake(CAP_1_2.category);
export const CAP_RESPONSE_TYPES = snake(CAP_1_2.responseType);
export const CAP_URGENCIES = snake(CAP_1_2.urgency);
export const CAP_SEVERITIES = snake(CAP_1_2.severity);
/** CAP certainty, with CAP 1.0's `Very Likely` read as `Likely`. */
export const CAP_CERTAINTIES: Readonly<Record<string, string>> = {
  ...snake(CAP_1_2.certainty.filter((t) => t !== "Very Likely")),
  "Very Likely": "likely",
};

/** CAP severity → the situation's severity label, declared. */
export const CAP_SEVERITY_LABELS: Readonly<Record<string, string | null>> = {
  Extreme: "critical",
  Severe: "major",
  Moderate: "moderate",
  Minor: "minor",
  Unknown: "unknown",
};
