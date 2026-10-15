import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { vehiclesModule } from "@openconditions/model-vehicles";

let registry: Registry | undefined;

/**
 * The kernel, the vehicles module, and the roads module, which holds the
 * `digitraffic` source format the maintenance tracking shares: what a vehicle
 * record is sealed against.
 */
export function vehiclesRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, roadsModule, vehiclesModule]);
  return registry;
}

/** Seals every draft; returns the ids and issues of those that fail. */
export function sealFailures(drafts: readonly Record<string, unknown>[]) {
  return drafts.flatMap((draft) => {
    const sealed = sealRecord(vehiclesRegistry(), draft, {
      instanceId: "vehicles.example",
      revision: 1,
      recordedAt: "2026-10-14T23:25:00Z",
    });
    return sealed.ok ? [] : [{ id: draft["id"], issues: sealed.issues }];
  });
}
