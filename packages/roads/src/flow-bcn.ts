import { localTimestamp } from "./flow.js";
import type { FlowContext, FlowSites } from "./flow-output.js";
import { type FlowParse, type FlowReading, measuredReading } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Barcelona's 0-6 congestion scale → DATEX status tokens the shared flow builder
 * derives level-of-service from. 0 = sensor down (no data) → skipped entirely.
 */
const STATUS_TO_DATEX: Record<string, string> = {
  "1": "freeFlow", // molt fluid
  "2": "freeFlow", // fluid
  "3": "heavy", // dens
  "4": "congested", // molt dens
  "5": "stationary", // congestió
  "6": "blocked", // tallat
};

/** "YYYYMMDDHHMMSS" Barcelona wall-clock time → ISO instant, or undefined when malformed. */
function parseBcnTimestamp(raw: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return localTimestamp(`${y}-${mo}-${d}T${h}:${mi}:${s}`, "Europe/Madrid");
}

/**
 * Parse Barcelona's live "estat del trànsit" TRAMS feed — one `#`-delimited row
 * per segment: `tramId#YYYYMMDDHHMMSS#estatActual#estatPrevist15min`, the status
 * a 0-6 congestion scale. Geometry and name come from the TRAMS registry.
 * Categorical status only (no speed); segments with status 0 (sensor down) or
 * no resolvable geometry are skipped.
 */
export function parseBcnTramsFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  if (typeof text !== "string" || text.trim() === "") return { readings: [], failed: true };

  const readings: FlowReading[] = [];
  let sawRow = false;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("#");
    if (parts.length < 3) continue;
    const [tramId, ts, status] = parts;
    if (!tramId) continue;
    sawRow = true;
    const site = sites?.get(tramId.trim());
    if (!site) continue;
    const trafficStatus = status != null ? STATUS_TO_DATEX[status.trim()] : undefined;
    if (!trafficStatus) continue; // status 0 (no data) or unrecognised value
    const at = ts ? parseBcnTimestamp(ts.trim()) : undefined;
    const reading = measuredReading({
      site: tramId.trim(),
      geometry: site.geometry,
      ...(at !== undefined ? { at } : {}),
      trafficStatus,
      ...(site.name !== undefined ? { name: site.name, nameLang: "ca" } : {}),
    });
    if (reading) readings.push(reading);
  }

  // A body that parsed to zero recognizable rows is a hard failure (error page),
  // not a legitimately empty cycle — every real fetch carries ~530 segments.
  if (!sawRow) return { readings: [], failed: true };
  return { readings };
}
