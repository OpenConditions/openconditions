import type { SourceTable, TargetTable } from "@openconditions/model";

/**
 * DATEX II v3 fuel codes → the grades OpenConditions prices. DATEX splits a
 * station's products across five lists — petrol, diesel, bioethanol, organic
 * gas and hydrogen — so a grade's code only means one thing together with
 * the list it came from.
 */
export const DATEX2_V3_FUEL_GRADES: SourceTable = {
  "petrol:octane95": "e10",
  "petrol:octane98": "sp98",
  "petrol:superE5": "e5",
  "petrol:superE10": "e10",
  "petrol:unleaded": "e5",
  // A grade only in name: "all petrol", leaded petrol (no longer sold in the EU)
  // and the two catch-alls say nothing about what is in the tank.
  "petrol:all": null,
  "petrol:leaded": null,
  "petrol:other": null,
  "petrol:unknown": null,
  "petrol:_extended": null,
  "diesel:carDiesel": "diesel",
  "diesel:truckDiesel": "diesel",
  "diesel:bioDiesel": "b100",
  "diesel:unknown": null,
  "diesel:_extended": null,
  "bioethanol:superE5": "e5",
  "bioethanol:superE10": "e10",
  "bioethanol:unknown": null,
  "bioethanol:other": null,
  "bioethanol:_extended": null,
  "organicGas:cng": "cng",
  "organicGas:lng": "lng",
  "organicGas:lpg": "lpg",
  "organicGas:biogas": "cng",
  "organicGas:all": null,
  "organicGas:other": null,
  "organicGas:unknown": null,
  "organicGas:_extended": null,
  "hydrogen:gaseousHydrogen350barCar": "h2_350",
  "hydrogen:gaseousHydrogen350barTruck": "h2_350",
  "hydrogen:gaseousHydrogen700barCar": "h2_700",
  "hydrogen:gaseousHydrogen700barTruck": "h2_700",
  // Liquid and cryo-compressed hydrogen are not the 350 or 700 bar gaseous
  // product a car is filled with; the schema's own spelling is kept.
  "hydrogen:liquidHydrogen": null,
  "hydrogen:cryoCompressedHydrogren": null,
  "hydrogen:unknown": null,
  "hydrogen:_extended": null,
};

export const DATEX2_V3_FUEL_GRADES_OUT: TargetTable = {
  e5: "petrol:superE5",
  e10: "petrol:superE10",
  sp98: "petrol:octane98",
  diesel: "diesel:carDiesel",
  b100: "diesel:bioDiesel",
  cng: "organicGas:cng",
  lng: "organicGas:lng",
  lpg: "organicGas:lpg",
  h2_350: "hydrogen:gaseousHydrogen350barCar",
  h2_700: "hydrogen:gaseousHydrogen700barCar",
  // No DATEX code: the premium diesels, the drop-in renewables, the blends
  // sold by their biodiesel share, ethanol as a fuel, AdBlue and kerosene.
  diesel_premium: null,
  hvo100: null,
  b7: null,
  b10: null,
  e85: null,
  ethanol: null,
  adblue: null,
  kerosene: null,
};

/** The v2 fuel list is a vehicle propulsion vocabulary, so most of it is not a grade. */
export const DATEX2_V2_FUEL_GRADES: SourceTable = {
  diesel: "diesel",
  biodiesel: "b100",
  petrol: "e5",
  ethanol: "ethanol",
  lpg: "lpg",
  methane: "cng",
  liquidGas: "lng",
  hydrogen: "h2_700",
  // Propulsions, not products sold by the litre.
  battery: null,
  dieselBatteryHybrid: null,
  petrolBatteryHybrid: null,
};

/** The units a price is published per; OpenConditions keeps the three it can compare. */
export const DATEX2_DELIVERY_UNITS: Readonly<Record<string, string | null>> = {
  litre: "L",
  kg: "kg",
  m3: "m3",
  // Energy sold by the kilowatt hour is charging, not fuelling; the imperial
  // and US volumes and the gas-gallon equivalent are converted at ingest.
  kWh: null,
  imperialGallon: null,
  usGallon: null,
  gasGallonEquivalent: null,
  _extended: null,
};
