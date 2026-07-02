const VVAPAAS: Record<string, "1" | "2"> = { VVAPAAS1: "1", VVAPAAS2: "2" };

interface Constant {
  name?: unknown;
  value?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
}

/** True when MM-DD `mmdd` falls within [from, to], honoring wrap-around windows. */
function inSeason(mmdd: string, from: string, to: string): boolean {
  if (from <= to) return mmdd >= from && mmdd <= to;
  return mmdd >= from || mmdd <= to; // window wraps the year end
}

/**
 * Extract each direction's native free-flow speed (VVAPAAS1/2) from a
 * Fintraffic per-station sensor-constants payload, choosing the constant whose
 * seasonal MM-DD window contains `on`. The composite percent-of-free-flow
 * sensors (e.g. `OHITUKSET_VVAPAAS1`) live on the sensorValues endpoint, not
 * here, and are excluded by requiring an exact VVAPAAS1/VVAPAAS2 name match.
 * Returns station-relative sensor keys (`${stationId}-${dir}`); the caller
 * prefixes the feed id to form the full sensor_baseline key.
 */
export function parseFintrafficSensorConstants(
  input: string | Buffer,
  opts: { stationId: string; on: Date }
): { sensorKey: string; freeFlowKph: number }[] {
  let payload: { sensorConstantValues?: unknown };
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return [];
  }
  const values = payload.sensorConstantValues;
  if (!Array.isArray(values)) return [];
  const mmdd = `${String(opts.on.getUTCMonth() + 1).padStart(2, "0")}-${String(
    opts.on.getUTCDate()
  ).padStart(2, "0")}`;

  const chosen = new Map<string, number>();
  for (const c of values as Constant[]) {
    const dir = typeof c.name === "string" ? VVAPAAS[c.name] : undefined;
    if (!dir) continue;
    const value = typeof c.value === "number" ? c.value : NaN;
    if (!Number.isFinite(value) || value <= 0) continue;
    const from = typeof c.validFrom === "string" ? c.validFrom : "01-01";
    const to = typeof c.validTo === "string" ? c.validTo : "12-31";
    if (!inSeason(mmdd, from, to)) continue;
    chosen.set(dir, value);
  }
  return [...chosen].map(([dir, freeFlowKph]) => ({
    sensorKey: `${opts.stationId}-${dir}`,
    freeFlowKph,
  }));
}
