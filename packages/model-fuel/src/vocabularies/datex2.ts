/**
 * DATEX II v3.7 liquid and gaseous fuel vocabularies, verbatim from
 * `DATEXII_3_EnergyInfrastructure.xsd` (https://docs.datex2.eu/_static/data/v3.7/):
 * the grades a refill point can sell, and the units they are sold in. The
 * hydrogen list reproduces the schema's own spelling, including
 * `cryoCompressedHydrogren`.
 */
export const DATEX2_V3_FUEL = {
  version: "3.7",
  petrolTypes: [
    "all",
    "octane95",
    "octane98",
    "leaded",
    "unleaded",
    "superE5",
    "superE10",
    "other",
    "unknown",
    "_extended",
  ],
  dieselTypes: ["carDiesel", "truckDiesel", "bioDiesel", "unknown", "_extended"],
  bioethanolTypes: ["superE5", "superE10", "unknown", "other", "_extended"],
  organicGasTypes: ["all", "cng", "lng", "lpg", "biogas", "other", "unknown", "_extended"],
  refillSolutionsHydrogen: [
    "gaseousHydrogen350barCar",
    "gaseousHydrogen350barTruck",
    "gaseousHydrogen700barCar",
    "gaseousHydrogen700barTruck",
    "liquidHydrogen",
    "cryoCompressedHydrogren",
    "unknown",
    "_extended",
  ],
  hydrogenFuellingProcessProtocols: [
    "sae2601v2010",
    "sae2601v2014",
    "sae2601v2016",
    "mcMethod",
    "unknown",
    "_extended",
  ],
  deliveryUnits: [
    "litre",
    "kWh",
    "kg",
    "m3",
    "imperialGallon",
    "usGallon",
    "gasGallonEquivalent",
    "_extended",
  ],
} as const;

/**
 * The DATEX II v2.3 fuel list, verbatim from `DATEXIISchema_2_2_3.xsd`. It is
 * a vehicle propulsion vocabulary reused for stations, so it names hybrids
 * and batteries next to fuels and has no grade detail.
 */
export const DATEX2_V2_FUEL = {
  version: "2.3",
  fuelTypes: [
    "battery",
    "biodiesel",
    "diesel",
    "dieselBatteryHybrid",
    "ethanol",
    "hydrogen",
    "liquidGas",
    "lpg",
    "methane",
    "petrol",
    "petrolBatteryHybrid",
  ],
} as const;
