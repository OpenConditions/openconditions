import { buildRegistry, kernelModule, type Registry, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { weatherModule } from "@openconditions/model-weather";

let registry: Registry | undefined;

/**
 * The kernel, the weather module, which holds the station model and its
 * source formats, and the roads module, which holds `device.status`, the
 * operating state of every field device a station is.
 */
export function weatherRegistry(): Registry {
  registry ??= buildRegistry([kernelModule, weatherModule, roadsModule]);
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
