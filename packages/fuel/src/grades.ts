import type { FUEL_GRADES, FUEL_UNITS } from "@openconditions/model-fuel";

export type FuelGrade = (typeof FUEL_GRADES)[number];
export type FuelUnit = (typeof FUEL_UNITS)[number];

/**
 * The unit each grade is sold by: gases by the kilogram (methane, hydrogen,
 * ammonia), everything else, LPG included, by the litre.
 */
export const GRADE_UNIT: Readonly<Record<FuelGrade, FuelUnit>> = {
  e5: "L",
  e10: "L",
  sp98: "L",
  e85: "L",
  diesel: "L",
  diesel_premium: "L",
  hvo100: "L",
  b7: "L",
  b10: "L",
  b100: "L",
  lpg: "L",
  cng: "kg",
  lng: "kg",
  h2_350: "kg",
  h2_700: "kg",
  adblue: "L",
  ethanol: "L",
  kerosene: "L",
  e25: "L",
  renewable_petrol: "L",
  agricultural_diesel: "L",
  methanol: "L",
  ammonia: "kg",
  e5_premium: "L",
  sp98_e10: "L",
  cng_bio: "kg",
  lng_bio: "kg",
};
