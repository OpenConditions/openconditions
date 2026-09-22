import type { SourceTable, TargetTable } from "@openconditions/model";

/**
 * DATEX II v3 energy-infrastructure codes → OpenConditions values. A DATEX
 * refill point is a charge point, so its status list maps onto the same
 * vocabulary OCPI's does — with two states OCPI has no word for: a fault the
 * operator has not classified, and a point that is out of the energy it
 * sells.
 */
export const DATEX2_REFILL_POINT_STATUSES: SourceTable = {
  available: "available",
  blocked: "blocked",
  charging: "charging",
  faulted: "out_of_order",
  inoperative: "inoperative",
  occupied: "occupied",
  outOfOrder: "out_of_order",
  outOfStock: "out_of_order",
  planned: "planned",
  removed: "removed",
  reserved: "reserved",
  unavailable: "inoperative",
  unknown: "unknown",
  _extended: null,
};

export const DATEX2_REFILL_POINT_STATUSES_OUT: TargetTable = {
  available: "available",
  blocked: "blocked",
  charging: "charging",
  occupied: "occupied",
  reserved: "reserved",
  out_of_order: "outOfOrder",
  inoperative: "inoperative",
  planned: "planned",
  removed: "removed",
  unknown: "unknown",
};

/**
 * DATEX II writes the same plugs as OCPI in its own spelling, so no value
 * string matches across the two. It also carries Tesla twice, once by market
 * and once by plug: the market values are the plug values under another name,
 * and both map to the same standard.
 */
export const DATEX2_CONNECTOR_STANDARDS: SourceTable = {
  chademo: "CHADEMO",
  cee3: "IEC_60309_2_single_16",
  cee5: "IEC_60309_2_three_16",
  yazaki: "CHADEMO",
  domestic: "UNKNOWN",
  domesticA: "DOMESTIC_A",
  domesticB: "DOMESTIC_B",
  domesticC: "DOMESTIC_C",
  domesticD: "DOMESTIC_D",
  domesticE: "DOMESTIC_E",
  domesticF: "DOMESTIC_F",
  domesticG: "DOMESTIC_G",
  domesticH: "DOMESTIC_H",
  domesticI: "DOMESTIC_I",
  domesticJ: "DOMESTIC_J",
  domesticK: "DOMESTIC_K",
  domesticL: "DOMESTIC_L",
  domesticM: "DOMESTIC_M",
  domesticN: "DOMESTIC_N",
  domesticO: "DOMESTIC_O",
  iec60309x2single16: "IEC_60309_2_single_16",
  iec60309x2three16: "IEC_60309_2_three_16",
  iec60309x2three32: "IEC_60309_2_three_32",
  iec60309x2three64: "IEC_60309_2_three_64",
  iec62196T1: "IEC_62196_T1",
  iec62196T1COMBO: "IEC_62196_T1_COMBO",
  iec62196T2: "IEC_62196_T2",
  iec62196T2COMBO: "IEC_62196_T2_COMBO",
  iec62196T3A: "IEC_62196_T3A",
  iec62196T3C: "IEC_62196_T3C",
  pantographBottomUp: "PANTOGRAPH_BOTTOM_UP",
  pantographTopDown: "PANTOGRAPH_TOP_DOWN",
  teslaConnectorEurope: "TESLA_S",
  teslaConnectorAmerica: "TESLA_R",
  teslaR: "TESLA_R",
  teslaS: "TESLA_S",
  other: "UNKNOWN",
  _extended: null,
};

/**
 * What DATEX can say back. Its `other` is already the code its own `other`
 * arrives under, so a standard DATEX cannot name emits nothing rather than
 * collapsing several standards into one ambiguous code.
 */
export const DATEX2_CONNECTOR_STANDARDS_OUT: TargetTable = {
  CHADEMO: "chademo",
  CHAOJI: null,
  DOMESTIC_A: "domesticA",
  DOMESTIC_B: "domesticB",
  DOMESTIC_C: "domesticC",
  DOMESTIC_D: "domesticD",
  DOMESTIC_E: "domesticE",
  DOMESTIC_F: "domesticF",
  DOMESTIC_G: "domesticG",
  DOMESTIC_H: "domesticH",
  DOMESTIC_I: "domesticI",
  DOMESTIC_J: "domesticJ",
  DOMESTIC_K: "domesticK",
  DOMESTIC_L: "domesticL",
  DOMESTIC_M: "domesticM",
  DOMESTIC_N: "domesticN",
  DOMESTIC_O: "domesticO",
  GBT_AC: null,
  GBT_DC: null,
  IEC_60309_2_single_16: "iec60309x2single16",
  IEC_60309_2_three_16: "iec60309x2three16",
  IEC_60309_2_three_32: "iec60309x2three32",
  IEC_60309_2_three_64: "iec60309x2three64",
  IEC_62196_T1: "iec62196T1",
  IEC_62196_T1_COMBO: "iec62196T1COMBO",
  IEC_62196_T2: "iec62196T2",
  IEC_62196_T2_COMBO: "iec62196T2COMBO",
  IEC_62196_T3A: "iec62196T3A",
  IEC_62196_T3C: "iec62196T3C",
  NEMA_5_20: null,
  NEMA_6_30: null,
  NEMA_6_50: null,
  NEMA_10_30: null,
  NEMA_10_50: null,
  NEMA_14_30: null,
  NEMA_14_50: null,
  PANTOGRAPH_BOTTOM_UP: "pantographBottomUp",
  PANTOGRAPH_TOP_DOWN: "pantographTopDown",
  TESLA_R: "teslaR",
  TESLA_S: "teslaS",
  MCS: null,
  UNKNOWN: null,
};

/**
 * DATEX connector formats. It distinguishes the charging mode of an attached
 * cable, which OCPI cannot express: all three collapse to one cable format.
 */
export const DATEX2_CONNECTOR_FORMATS: Readonly<Record<string, string | null>> = {
  cableMode2: "cable",
  cableMode3: "cable",
  otherCable: "cable",
  socket: "socket",
  _extended: null,
};

/** A DATEX energy site's type; a charging site is what OpenConditions registers. */
export const DATEX2_ENERGY_SITE_TYPES: SourceTable = {
  "siteType:roofedStation": "charging_site",
  "siteType:inBuilding": "charging_site",
  "siteType:openSpace": "charging_site",
  "siteType:onstreet": "charging_site",
  "siteType:onCompanySite": "charging_site",
  "siteType:other": null,
  "siteType:_extended": null,
};
