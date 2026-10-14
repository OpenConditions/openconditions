import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { weatherModule } from "@openconditions/model-weather";

let registry: Registry | undefined;

/** The kernel and the weather module, which holds the station model and its source formats. */
export function weatherRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, weatherModule]);
  return registry;
}

/** Seals every draft; returns the ids and issues of those that fail. */
export function sealFailures(drafts: readonly Record<string, unknown>[]) {
  return drafts.flatMap((draft) => {
    const sealed = sealRecord(weatherRegistry(), draft, {
      instanceId: "weather.example",
      revision: 1,
      recordedAt: "2026-10-14T23:25:19Z",
    });
    return sealed.ok ? [] : [{ id: draft["id"], issues: sealed.issues }];
  });
}
