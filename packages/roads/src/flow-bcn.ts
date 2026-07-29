import type { RoadEvent, RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import type { SiteGeometry } from "./siteTable.js";
import { buildMeasuredSiteFlow, makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";

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

/** "YYYYMMDDHHMMSS" → ISO-8601 local timestamp, or undefined when malformed. */
function parseBcnTimestamp(raw: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/**
 * Parse Barcelona's live "estat del trànsit" TRAMS feed — one `#`-delimited row
 * per segment: `tramId#YYYYMMDDHHMMSS#estatActual#estatPrevist15min`, the status
 * a 0-6 congestion scale. Geometry comes from the injected TRAMS registry
 * (tram id → LineString). Categorical status only (no speed); segments with
 * status 0 (sensor down) or no resolvable geometry are skipped. los and the
 * derived congestion events come from the shared {@link buildMeasuredSiteFlow};
 * only the sourceFormat is restamped here.
 */
export function parseBcnTramsFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, SiteGeometry>
): FlowParseResult {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  if (typeof text !== "string" || text.trim() === "") {
    return { flows: [], events: [], failed: true };
  }

  const flows: RoadFlow[] = [];
  const events: RoadEvent[] = [];
  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  let sawRow = false;

  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("#");
    if (parts.length < 3) continue;
    const [tramId, ts, status] = parts;
    if (!tramId) continue;
    sawRow = true;
    const geom = siteMap?.get(tramId.trim());
    if (!geom) continue;
    const trafficStatus = status != null ? STATUS_TO_DATEX[status.trim()] : undefined;
    if (!trafficStatus) continue; // status 0 (no data) or unrecognised value
    const measuredAt = (ts ? parseBcnTimestamp(ts.trim()) : undefined) ?? now;
    const built = buildMeasuredSiteFlow(
      { siteId: tramId.trim(), measuredAt, geom, trafficStatus },
      src,
      origin,
      now
    );
    if (!built) continue;
    flows.push({ ...built.flow, sourceFormat: "bcn-trams" });
    if (built.event) events.push({ ...built.event, sourceFormat: "bcn-trams" });
  }

  // A body that parsed to zero recognizable rows is a hard failure (error page),
  // not a legitimately empty cycle — every real fetch carries ~530 segments.
  if (!sawRow) return { flows: [], events: [], failed: true };
  return { flows, events };
}
