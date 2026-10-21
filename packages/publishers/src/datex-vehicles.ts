import type { Effect, VehicleSelector } from "@openconditions/model";

type Rec = Record<string, unknown>;

/**
 * The kernel's vehicle applicability as DATEX II v3 `VehicleCharacteristics`,
 * the group a network management measure states under
 * `forVehiclesWithCharacteristicsOf`. Only what DATEX says exactly is
 * written: one selector (DATEX groups several only with an AND/OR nobody
 * defines), no exceptions (a measure has no "except"), and within it the
 * vehicle class, usage, fuel and Euro emission class DATEX has a value for,
 * and each dimension condition with its comparison operator. Anything else
 * leaves the effect unstateable, so its situation stays withheld.
 */

/** Vehicle classes DATEX names as one `VehicleTypeEnum` value of the same meaning. */
const VEHICLE_TYPES: Readonly<Record<string, string>> = {
  car: "car",
  van: "van",
  truck: "lorry",
  hgv: "heavyGoodsVehicle",
  bus: "bus",
  motorcycle: "motorcycle",
  moped: "moped",
  bicycle: "bicycle",
  trailer: "trailer",
  caravan: "caravan",
  agricultural: "agriculturalVehicle",
};

/** Vehicle usages DATEX names as one `VehicleUsageEnum` value of the same meaning. */
const VEHICLE_USAGES: Readonly<Record<string, string>> = {
  emergency_services: "emergencyServices",
  taxi: "taxi",
  military: "military",
  agricultural: "agricultural",
  car_sharing: "carSharing",
};

/** Fuels DATEX names as one `FuelTypeEnum` value; CNG and LNG are both DATEX `methane`. */
const FUELS: Readonly<Record<string, string>> = {
  electric: "battery",
  hydrogen: "hydrogen",
  lpg: "lpg",
  diesel: "diesel",
  petrol: "petrol",
};

/** Euro emission classes DATEX names in `EmissionClassificationEuroEnum`. */
const EURO_CLASSES = new Set([
  "euro5",
  "euro5a",
  "euro5b",
  "euro6",
  "euro6a",
  "euro6b",
  "euro6c",
  "euroV",
  "euroVI",
]);

const OPERATORS: Readonly<Record<string, string>> = {
  lt: "lessThan",
  lte: "lessThanOrEqualTo",
  eq: "equalTo",
  gte: "greaterThanOrEqualTo",
  gt: "greaterThan",
};

const own = <T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

/** One dimension condition as its characteristic: element name and content, or null. */
function characteristicOf(
  when: NonNullable<VehicleSelector["when"]>[number],
): [string, Rec] | null {
  const comparisonOperator = own(OPERATORS, when.operator);
  const { value, unit } = when.value;
  if (comparisonOperator === undefined) return null;
  const tonnes = unit === "kg" ? value / 1000 : undefined;
  switch (when.dimension) {
    case "height":
      return unit === "m"
        ? ["heightCharacteristic", { comparisonOperator, vehicleHeight: value }]
        : null;
    case "width":
      return unit === "m"
        ? ["widthCharacteristic", { comparisonOperator, vehicleWidth: value }]
        : null;
    case "length":
      return unit === "m"
        ? ["lengthCharacteristic", { comparisonOperator, vehicleLength: value }]
        : null;
    case "gross_weight":
    case "laden_weight":
      return tonnes === undefined
        ? null
        : [
            "grossWeightCharacteristic",
            {
              comparisonOperator,
              grossVehicleWeight: tonnes,
              // A gross weight is the most the vehicle may weigh; a laden one what it weighs.
              typeOfWeight: when.dimension === "gross_weight" ? "maximumPermitted" : "actual",
            },
          ];
    case "axle_load":
      return tonnes === undefined
        ? null
        : ["heaviestAxleWeightCharacteristic", { comparisonOperator, heaviestAxleWeight: tonnes }];
    case "axle_count":
      return Number.isSafeInteger(value) && value >= 0
        ? ["numberOfAxlesCharacteristic", { comparisonOperator, numberOfAxles: value }]
        : null;
    default:
      return null;
  }
}

/** One selector as a DATEX vehicle characteristics group, or null where DATEX cannot say it. */
function groupOf(selector: VehicleSelector): Rec | null {
  if (selector.hazmat !== undefined || selector.hovMin !== undefined) return null;
  const type = own(VEHICLE_TYPES, selector.class);
  const usage = own(VEHICLE_USAGES, selector.usage);
  const fuel = own(FUELS, selector.fuel);
  if (
    (selector.class !== undefined && type === undefined) ||
    (selector.usage !== undefined && usage === undefined) ||
    (selector.fuel !== undefined && fuel === undefined)
  )
    return null;
  const emission = selector.emission;
  if (
    emission !== undefined &&
    (emission.scheme !== "euro" ||
      emission.values.length !== 1 ||
      !emission.values.every((v) => EURO_CLASSES.has(v)))
  )
    return null;
  const characteristics: [string, Rec][] = [];
  for (const when of selector.when ?? []) {
    const found = characteristicOf(when);
    if (found === null) return null;
    characteristics.push(found);
  }
  const byName = (name: string) =>
    characteristics
      .filter(([n]) => n === name)
      .map(([, c]) => Object.fromEntries(Object.entries(c).map(([k, v]) => [`com:${k}`, v])));
  // DATEX allows two conditions of one kind (a range), in schema order.
  const named = [
    "grossWeightCharacteristic",
    "heightCharacteristic",
    "lengthCharacteristic",
    "widthCharacteristic",
    "heaviestAxleWeightCharacteristic",
    "numberOfAxlesCharacteristic",
  ];
  if (named.some((name) => byName(name).length > 2)) return null;
  const group: Rec = {
    ...(fuel ? { "com:fuelType": fuel } : {}),
    ...(type ? { "com:vehicleType": type } : {}),
    ...(usage ? { "com:vehicleUsage": usage } : {}),
    ...Object.fromEntries(
      named.flatMap((name) => {
        const found = byName(name);
        return found.length > 0 ? [[`com:${name}`, found]] : [];
      }),
    ),
    ...(emission
      ? { "com:emissions": { "com:emissionClassificationEuro": emission.values[0] } }
      : {}),
  };
  return Object.keys(group).length > 0 ? group : null;
}

/**
 * The vehicle characteristics group an effect's measure states: undefined when
 * it applies to every vehicle, null when DATEX cannot state its vehicles.
 */
export function vehicleCharacteristicsOf(effect: Effect): Rec | null | undefined {
  const a = effect.applicability;
  if (a.except !== undefined && a.except.length > 0) return null;
  if (a.kind === "all") return undefined;
  const [only, ...more] = a.include ?? [];
  if (a.kind !== "classes" || only === undefined || more.length > 0) return null;
  return groupOf(only);
}

/** Effect kinds that are a vehicle rule in themselves, which no measure here states. */
const VEHICLE_RULES = new Set(["dimension_limit", "hazmat", "unsupported"]);

/** Whether DATEX states which vehicles an effect applies to. */
export function datexStatesVehicles(effect: Effect): boolean {
  return !VEHICLE_RULES.has(effect.kind) && vehicleCharacteristicsOf(effect) !== null;
}
