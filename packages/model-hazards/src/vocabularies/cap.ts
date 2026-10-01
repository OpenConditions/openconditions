/**
 * The closed enumerations of OASIS CAP 1.2 (Common Alerting Protocol,
 * Version 1.2, OASIS Standard, 1 July 2010), verbatim. `Very Likely` is the
 * CAP 1.0 certainty 1.2 still tells receivers to accept as `Likely`.
 */
export const CAP_1_2 = {
  status: ["Actual", "Exercise", "System", "Test", "Draft"],
  msgType: ["Alert", "Update", "Cancel", "Ack", "Error"],
  scope: ["Public", "Restricted", "Private"],
  category: [
    "Geo",
    "Met",
    "Safety",
    "Security",
    "Rescue",
    "Fire",
    "Health",
    "Env",
    "Transport",
    "Infra",
    "CBRNE",
    "Other",
  ],
  responseType: [
    "Shelter",
    "Evacuate",
    "Prepare",
    "Execute",
    "Avoid",
    "Monitor",
    "Assess",
    "AllClear",
    "None",
  ],
  urgency: ["Immediate", "Expected", "Future", "Past", "Unknown"],
  severity: ["Extreme", "Severe", "Moderate", "Minor", "Unknown"],
  certainty: ["Observed", "Likely", "Possible", "Unlikely", "Unknown", "Very Likely"],
} as const;
