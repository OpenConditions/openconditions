import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { borderModule } from "@openconditions/model-border";
import { facilitiesModule } from "@openconditions/model-facilities";

let registry: Registry | undefined;

/** The kernel, the border module and the facilities module (the open status): what a border record is sealed against. */
export function borderRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, borderModule, facilitiesModule]);
  return registry;
}

/** Seals every draft; returns the ids and issues of those that fail. */
export function sealFailures(drafts: readonly Record<string, unknown>[]) {
  return drafts.flatMap((draft) => {
    const sealed = sealRecord(borderRegistry(), draft, {
      instanceId: "border.example",
      revision: 1,
      recordedAt: "2026-10-14T23:40:00Z",
    });
    return sealed.ok ? [] : [{ id: draft["id"], issues: sealed.issues }];
  });
}
