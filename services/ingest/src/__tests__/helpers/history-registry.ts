import { buildRegistry, type Registry } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import { historyModules } from "@openconditions/test-database/registry";

let registry: Registry | undefined;

/** The production registry with the histories its properties kept before they became latest-only. */
export function historyRegistry(): Registry {
  registry ??= buildRegistry(historyModules(productionModules));
  return registry;
}
