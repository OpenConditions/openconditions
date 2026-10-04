import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { fuelModule } from "@openconditions/model-fuel";

let registry: Registry | undefined;

/** The kernel and the fuel module: what a fuel record is sealed against. */
function fuelRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, fuelModule]);
  return registry;
}

/** Seals every draft; returns the ids and issues of those that fail. */
export function sealFailures(drafts: readonly Record<string, unknown>[]) {
  return drafts.flatMap((draft) => {
    const sealed = sealRecord(fuelRegistry(), draft, {
      instanceId: "fuel.example",
      revision: 1,
      recordedAt: "2026-10-03T22:00:00Z",
    });
    return sealed.ok ? [] : [{ id: draft["id"], issues: sealed.issues }];
  });
}
