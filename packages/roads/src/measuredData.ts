/**
 * Streaming parser for a DATEX II MeasuredDataPublication — the recurring
 * traffic-speed/flow feed that pairs with a MeasurementSiteTablePublication.
 *
 * The production NDW trafficspeed feed is ~50 MB uncompressed and is fetched
 * every ~60 s; parsing it into a full DOM (fast-xml-parser) balloons to several
 * hundred MB and OOMs a memory-capped ingest. This parser scans the document
 * with a streaming SAX reader instead: peak memory is the output flow/event
 * arrays plus a small per-site accumulator, regardless of input size. It mirrors
 * {@link createSiteTableParser}, the streaming reader already used for the
 * (much larger) companion site table.
 *
 * Geometry resolution per site, in priority order:
 *   1. an inline `locationReference`/`gml:posList` on the measurement, then
 *   2. the external `siteMap` (the NDW layout: geometry lives in the separate,
 *      slowly-changing site-table document, joined by `measurementSiteReference id`).
 *
 * An inline `measurementSiteTable` embedded in the measured-data document is NOT
 * resolved here (no production streaming feed uses that layout); the buffered
 * {@link parseDatexMeasuredData} still covers that case for small inputs/tests.
 */
import type { LineString } from "geojson";
import { SaxesParser } from "saxes";
import { buildMeasuredSiteFlow, makeOrigin } from "./flow.js";
import type { FlowGeometry, FlowParseResult } from "./flow.js";
import type { RoadEvent, RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { flattenString, stripXmlNamespace } from "./xml.js";

/** Incremental, streaming DATEX MeasuredData parser. */
export interface MeasuredDataParser {
  /** Feed a chunk of decoded XML text. Chunks may split mid-element. */
  write(chunk: string): void;
  /** Finalise parsing and return the accumulated flows + derived events. */
  close(): FlowParseResult;
}

/** A representative speed sample weighted by its supporting input count. */
interface SpeedSample {
  speedKph: number;
  inputCount: number;
}

/**
 * Per-site accumulator. Only the small set of best-sample/status/geometry fields
 * for the open `siteMeasurements` is held; the surrounding subtree streams past
 * and is discarded.
 */
interface SiteState {
  siteId?: string;
  timeDefault?: string;
  obsTime?: string;
  trafficStatus?: string;
  freeFlowKph?: number;
  best: SpeedSample | null;
  posListCoords: [number, number][];
  // The averageVehicleSpeed sample currently being read.
  curInputCount: number;
  curSpeed?: number;
  curDataError: boolean;
}

function freshSite(): SiteState {
  return { best: null, posListCoords: [], curInputCount: 0, curDataError: false };
}

type TextTarget =
  | "avgspeed"
  | "freeflow"
  | "trafficStatus"
  | "timeDefault"
  | "obsTime"
  | "dataError"
  | "posList"
  | null;

/**
 * Creates a streaming DATEX MeasuredData parser. The returned object accepts
 * decoded XML in arbitrary chunks (which may split mid-element) and, on
 * `close()`, returns the accumulated flows and derived congestion events.
 * Malformed input is tolerated: a SAX error stops further accumulation and
 * `close()` returns whatever resolved before the error rather than throwing.
 *
 * Output is identical to {@link parseDatexMeasuredData} given the same input and
 * `siteMap` — both feed the same {@link buildMeasuredSiteFlow} builder.
 */
export function createMeasuredDataParser(
  src: SourceDescriptor,
  siteMap?: Map<string, FlowGeometry>,
  now: () => string = () => new Date().toISOString()
): MeasuredDataParser {
  const flows: RoadFlow[] = [];
  const events: RoadEvent[] = [];
  const origin = makeOrigin(src);
  const nowIso = now();

  const stack: string[] = [];
  let site: SiteState | null = null;
  let textTarget: TextTarget = null;
  let textBuffer = "";
  let failed = false;

  // No namespace resolution: tag names arrive verbatim (e.g. `gml:posList`) and
  // are normalised with stripXmlNamespace, the same way the site-table parser
  // tolerates prefixes bound by xmlns attributes it ignores.
  const parser = new SaxesParser({ position: false });

  // Entity-bomb safety: a feed shipping a DOCTYPE/internal subset is rejected.
  parser.on("doctype", () => {
    throw new Error("XML DOCTYPE/entity declarations are not allowed");
  });

  parser.on("error", () => {
    failed = true;
  });

  parser.on("opentag", (tag) => {
    const local = stripXmlNamespace(tag.name);
    stack.push(local);

    if (local === "siteMeasurements") {
      site = freshSite();
      textTarget = null;
      textBuffer = "";
      return;
    }
    if (site == null) return;

    const attrs = tag.attributes as Record<string, string>;
    switch (local) {
      case "measurementSiteReference": {
        // Flatten: the id is baked into every emitted flow's id and looked up in
        // the site map, so a sliced-string id would pin its input chunk.
        const ref = attrs["id"] ?? attrs["targetClass"];
        if (ref != null) site.siteId ??= flattenString(ref);
        break;
      }
      case "averageVehicleSpeed":
        site.curInputCount = Number(attrs["numberOfInputValuesUsed"] ?? "0") || 0;
        site.curSpeed = undefined;
        site.curDataError = false;
        break;
      case "speed": {
        // `<speed>` appears under both averageVehicleSpeed and freeFlowSpeed;
        // the parent on the stack disambiguates which value we are reading.
        const parent = stack[stack.length - 2];
        if (parent === "averageVehicleSpeed") textTarget = "avgspeed";
        else if (parent === "freeFlowSpeed") textTarget = "freeflow";
        textBuffer = "";
        break;
      }
      case "dataError":
        textTarget = "dataError";
        textBuffer = "";
        break;
      case "trafficStatus":
        textTarget = "trafficStatus";
        textBuffer = "";
        break;
      case "measurementTimeDefault":
        textTarget = "timeDefault";
        textBuffer = "";
        break;
      case "observationTime":
        textTarget = "obsTime";
        textBuffer = "";
        break;
      case "posList":
        textTarget = "posList";
        textBuffer = "";
        break;
    }
  });

  parser.on("text", (t) => {
    if (textTarget != null) textBuffer += t;
  });
  parser.on("cdata", (t) => {
    if (textTarget != null) textBuffer += t;
  });

  parser.on("closetag", (tag) => {
    const local = stripXmlNamespace(tag.name);

    if (site != null) {
      switch (local) {
        case "speed": {
          const v = Number(textBuffer.trim());
          if (textTarget === "avgspeed") {
            // A speed < 0 is NDW's no-data sentinel (e.g. -1); drop it.
            site.curSpeed = Number.isFinite(v) && v >= 0 ? v : undefined;
          } else if (textTarget === "freeflow") {
            if (Number.isFinite(v) && v > 0) site.freeFlowKph ??= v;
          }
          textTarget = null;
          break;
        }
        case "dataError":
          if (textBuffer.trim() === "true") site.curDataError = true;
          textTarget = null;
          break;
        case "averageVehicleSpeed":
          // Keep the best-supported (highest input count) valid sample.
          if (!site.curDataError && site.curSpeed != null) {
            if (site.best == null || site.curInputCount > site.best.inputCount) {
              site.best = { speedKph: site.curSpeed, inputCount: site.curInputCount };
            }
          }
          break;
        case "trafficStatus":
          site.trafficStatus ??= textBuffer.trim();
          textTarget = null;
          break;
        case "measurementTimeDefault":
          site.timeDefault = textBuffer.trim();
          textTarget = null;
          break;
        case "observationTime":
          site.obsTime = textBuffer.trim();
          textTarget = null;
          break;
        case "posList": {
          const nums = textBuffer.trim().split(/\s+/).map(Number);
          for (let i = 0; i + 1 < nums.length; i += 2) {
            const lat = nums[i]!;
            const lon = nums[i + 1]!;
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              site.posListCoords.push([lon, lat]);
            }
          }
          textTarget = null;
          break;
        }
        case "siteMeasurements": {
          const measuredAt = site.timeDefault ?? site.obsTime ?? nowIso;
          let geom: FlowGeometry | null = null;
          if (site.posListCoords.length >= 2) {
            geom = { type: "LineString", coordinates: site.posListCoords } satisfies LineString;
          } else if (site.siteId != null) {
            geom = siteMap?.get(site.siteId) ?? null;
          }

          const built = buildMeasuredSiteFlow(
            {
              siteId: site.siteId ?? `site-${flows.length + 1}`,
              measuredAt,
              geom,
              ...(site.best?.speedKph != null ? { speedKph: site.best.speedKph } : {}),
              ...(site.trafficStatus != null ? { trafficStatus: site.trafficStatus } : {}),
              ...(site.freeFlowKph != null ? { freeFlowKph: site.freeFlowKph } : {}),
            },
            src,
            origin,
            nowIso
          );
          if (built) {
            flows.push(built.flow);
            if (built.event) events.push(built.event);
          }

          site = null;
          textTarget = null;
          break;
        }
      }
    }

    stack.pop();
  });

  return {
    write(chunk: string): void {
      if (failed) return;
      try {
        parser.write(chunk);
      } catch {
        failed = true;
      }
    },
    close(): FlowParseResult {
      if (!failed) {
        try {
          parser.close();
        } catch {
          failed = true;
        }
      }
      return { flows, events };
    },
  };
}
