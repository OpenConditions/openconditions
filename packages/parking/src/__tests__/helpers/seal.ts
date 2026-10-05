import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { parkingModule } from "@openconditions/model-parking";

let registry: Registry | undefined;

/** The kernel and the parking module: what a parking record is sealed against. */
function parkingRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, parkingModule]);
  return registry;
}

/** Seals every draft; returns the ids and issues of those that fail. */
export function sealFailures(drafts: readonly Record<string, unknown>[]) {
  return drafts.flatMap((draft) => {
    const sealed = sealRecord(parkingRegistry(), draft, {
      instanceId: "parking.example",
      revision: 1,
      recordedAt: "2026-10-05T06:00:00Z",
    });
    return sealed.ok ? [] : [{ id: draft["id"], issues: sealed.issues }];
  });
}
