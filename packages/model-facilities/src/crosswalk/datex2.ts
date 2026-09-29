import type { SourceTable, TargetTable } from "@openconditions/model";

/**
 * DATEX II opening status → `facility_open_status`, keyed by the enumeration.
 * Every closed variant is closed: why it is closed (holiday, maintenance) is
 * not a status. v2's `openingTimesInForce` says the regular hours apply,
 * which is no state at all without those hours.
 */
export const DATEX2_V3_OPENING_STATUSES: SourceTable = {
  "openingStatus:open": "open",
  "openingStatus:openWithServiceLimitation": "restricted",
  "openingStatus:closed": "closed",
  "openingStatus:closedOnHoliday": "closed",
  "openingStatus:closedOnMaintenance": "closed",
  "openingStatus:temporarilyClosed": "closed",
  "openingStatus:statusUnknown": "unknown",
  "openingStatus:other": null,
  "openingStatus:_extended": null,
};

export const DATEX2_V2_OPENING_STATUSES: SourceTable = {
  "openingStatus:open": "open",
  "openingStatus:closed": "closed",
  "openingStatus:closedAbnormal": "closed",
  "openingStatus:openingTimesInForce": null,
  "openingStatus:statusUnknown": "unknown",
  "openingStatus:other": null,
};

export const DATEX2_OPENING_STATUSES_OUT: TargetTable = {
  open: "openingStatus:open",
  restricted: "openingStatus:openWithServiceLimitation",
  closed: "openingStatus:closed",
  unknown: "openingStatus:statusUnknown",
};
