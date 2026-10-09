import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { hazardsModule } from "@openconditions/model-hazards";

let registry: Registry | undefined;

/** The kernel and the hazards module: what a hazard record is sealed against. */
function hazardsRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, hazardsModule]);
  return registry;
}

/** Seals every draft; returns the ids and issues of those that fail. */
export function sealFailures(drafts: readonly Record<string, unknown>[]) {
  return drafts.flatMap((draft) => {
    const sealed = sealRecord(hazardsRegistry(), draft, {
      instanceId: "hazards.example",
      revision: 1,
      recordedAt: "2026-10-08T22:00:00Z",
    });
    return sealed.ok ? [] : [{ id: draft["id"], issues: sealed.issues }];
  });
}
