import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { chargingModule } from "@openconditions/model-charging";
import { roadsModule } from "@openconditions/model-roads";

let registry: Registry | undefined;

/**
 * The kernel, the charging module, and the roads module, which contributes
 * the `digitraffic` source format charging shares: what a charging record is
 * sealed against.
 */
function chargingRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, roadsModule, chargingModule]);
  return registry;
}

/** Seals every draft; returns the ids and issues of those that fail. */
export function sealFailures(drafts: readonly Record<string, unknown>[]) {
  return drafts.flatMap((draft) => {
    const sealed = sealRecord(chargingRegistry(), draft, {
      instanceId: "charging.example",
      revision: 1,
      recordedAt: "2026-10-06T06:00:00Z",
    });
    return sealed.ok ? [] : [{ id: draft["id"], issues: sealed.issues }];
  });
}
