import {
  buildRegistry,
  kernelModule,
  type Registry,
  type RegistryModule,
} from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";

/**
 * Every registry module this build of OpenConditions runs with. Each domain
 * contributes its module from a `@openconditions/model-<domain>` package, which
 * holds definitions only, so assembling them never pulls in parsers or storage.
 */
export const productionModules: readonly RegistryModule[] = [kernelModule, roadsModule];

let registry: Registry | undefined;

/** The assembled production registry, built on first use. */
export function productionRegistry(): Registry {
  registry ??= buildRegistry(productionModules);
  return registry;
}
