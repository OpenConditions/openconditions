/**
 * The histories production properties kept before every property but
 * `traffic.speed` became latest-only. Storage still supports each of these
 * modes; tests of the history machinery use them through real property
 * definitions.
 */
const FORMER_RETENTIONS: Record<string, Retention | undefined> = {
  "traffic.speed": {
    rawDays: 2,
    componentHistory: false,
    rollup: { period: "hourly", histogram: { binWidth: 2 } },
  },
  "traffic.volume": { rawDays: 1, componentHistory: false, rollup: { period: "hourly" } },
  "traffic.occupancy": { rawDays: 2, componentHistory: false, rollup: { period: "hourly" } },
  "traffic.los": { changeOnly: true, rawDays: 7, componentHistory: false },
  "traffic.vehicle_class_speed": { rawDays: 2, componentHistory: false },
  "traffic.travel_time": { rawDays: 7, rollup: { period: "hourly" } },
  "vms.display": { changeOnly: true, rawDays: 30 },
  "camera.image": { changeOnly: true, componentHistory: false },
  "device.status": { changeOnly: true },
  "pass.status": { changeOnly: true },
  "winter.chain_level": { changeOnly: true },
  "toll.price": { changeOnly: true, rawDays: 30 },
  "weather.wind_direction": { rawDays: 7 },
  "weather.precipitation_type": { changeOnly: true },
  "road.surface_state": { changeOnly: true },
  "road.condition_forecast": { rawDays: 2 },
  "vehicle.position": { rawDays: 2 },
  "parking.available": { changeOnly: true, rollup: { period: "hourly" } },
  "parking.occupied": { changeOnly: true, rollup: { period: "hourly" } },
  "parking.occupancy_pct": { rollup: { period: "hourly" } },
  "parking.status": { changeOnly: true },
  "parking.trend": { changeOnly: true },
  "charging.evse_status": { changeOnly: true },
  "charging.connector_status": { changeOnly: true },
  "charging.site_status": { changeOnly: true },
  "charging.waiting_time": { rawDays: 7 },
  "fuel.price": { rawDays: 30, changeOnly: true, rollup: { period: "daily" } },
  "fuel.price_cap": undefined,
  "fuel.product_available": { changeOnly: true },
  "facility.open_status": { changeOnly: true },
  "border.wait": { rawDays: 30 },
  "ferry.status": { changeOnly: true },
  "ferry.vehicle_space": { changeOnly: true, rawDays: 7 },
  "fire.frp": { rawDays: 7 },
};

/** Weather and road quantities rolled up hourly after a week of raw readings. */
const FORMER_QUANTITY: Retention = { rawDays: 7, rollup: { period: "hourly" } };

/**
 * A property's registry retention, as plain data: this package sits below the
 * model in the build, so it describes the shapes it rewrites instead of
 * importing them.
 */
type Retention = Record<string, unknown>;
interface Module {
  readonly entries: readonly { readonly entry: string }[];
}

/** `modules` with some properties' retention replaced (`undefined`: keep everything). */
export function modulesWithRetentions<M extends Module>(
  modules: readonly M[],
  retentions: Record<string, Retention | undefined>,
): M[] {
  return modules.map((module) => ({
    ...module,
    entries: module.entries.map((entry) => {
      const code = (entry as { code?: string }).code;
      if (entry.entry !== "property" || code === undefined || !(code in retentions)) return entry;
      const { retention: _, ...rest } = entry as { retention?: unknown };
      const retention = retentions[code];
      return retention === undefined ? rest : { ...rest, retention };
    }),
  }));
}

/**
 * The production modules as they were when every property kept a history
 * (pass `productionModules`): what the tests of history, rollups and
 * change-only series run on.
 */
export function historyModules<M extends Module>(modules: readonly M[]): M[] {
  const retentions: Record<string, Retention | undefined> = { ...FORMER_RETENTIONS };
  for (const module of modules) {
    for (const entry of module.entries) {
      const code = (entry as { code?: string }).code;
      if (entry.entry !== "property" || code === undefined || code in retentions) continue;
      if (/^(weather|road)\./.test(code)) retentions[code] = FORMER_QUANTITY;
    }
  }
  return modulesWithRetentions(modules, retentions);
}
