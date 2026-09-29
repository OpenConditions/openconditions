/**
 * DATEX II opening statuses, verbatim from the official schemas: 3.7
 * `fac:OpeningStatusEnum` in `DATEXII_3_Facilities.xsd`
 * (https://docs.datex2.eu/_static/data/v3.7/) and 2.3 `OpeningStatusEnum` in
 * `DATEXIISchema_2_2_3.xsd`
 * (https://docs.datex2.eu/_static/data/v2.3/DATEXIISchema_2_2_3_0.zip).
 */
export const DATEX2_OPENING_STATUSES = {
  v3: [
    "open",
    "openWithServiceLimitation",
    "closed",
    "closedOnHoliday",
    "closedOnMaintenance",
    "temporarilyClosed",
    "statusUnknown",
    "other",
    "_extended",
  ],
  v2: ["open", "closed", "closedAbnormal", "openingTimesInForce", "statusUnknown", "other"],
} as const;
