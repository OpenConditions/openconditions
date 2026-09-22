import {
  buildRegistry,
  kernelModule,
  type Registry,
  type RegistryModule,
} from "@openconditions/model";
import { chargingModule } from "@openconditions/model-charging";
import { fuelModule } from "@openconditions/model-fuel";
import { parkingModule } from "@openconditions/model-parking";
import { roadsModule } from "@openconditions/model-roads";
import { vehiclesModule } from "@openconditions/model-vehicles";
import { weatherModule } from "@openconditions/model-weather";

/**
 * Every registry module this build of OpenConditions runs with. Each domain
 * contributes its module from a `@openconditions/model-<domain>` package, which
 * holds definitions only, so assembling them never pulls in parsers or storage.
 */
export const productionModules: readonly RegistryModule[] = [
  kernelModule,
  roadsModule,
  weatherModule,
  vehiclesModule,
  parkingModule,
  chargingModule,
  fuelModule,
];

let registry: Registry | undefined;

/** The assembled production registry, built on first use. */
export function productionRegistry(): Registry {
  registry ??= buildRegistry(productionModules);
  return registry;
}
