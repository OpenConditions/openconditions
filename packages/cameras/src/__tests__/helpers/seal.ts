import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { chargingModule } from "@openconditions/model-charging";
import { roadsModule } from "@openconditions/model-roads";

let registry: Registry | undefined;

/**
 * The kernel, the roads module, which holds the camera model and the camera
 * source formats, and the charging module, which contributes the `tdx` source
 * format cameras share: what a camera record is sealed against.
 */
function camerasRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, roadsModule, chargingModule]);
  return registry;
}

/** Seals every draft; returns the ids and issues of those that fail. */
export function sealFailures(drafts: readonly Record<string, unknown>[]) {
  return drafts.flatMap((draft) => {
    const sealed = sealRecord(camerasRegistry(), draft, {
      instanceId: "cameras.example",
      revision: 1,
      recordedAt: "2026-10-08T07:00:00Z",
    });
    return sealed.ok ? [] : [{ id: draft["id"], issues: sealed.issues }];
  });
}
