/**
 * Streaming parser for a DATEX II MeasurementSiteTablePublication — the static
 * site registry that pairs with a MeasuredDataPublication. Many real feeds
 * (notably NDW) ship measurements in one document keyed only by a site id, and
 * the geometry for those sites in a separate, slowly-changing table document.
 * This parser turns that table into an id→Geometry map the measured-data parser
 * can join against.
 *
 * The table document is large — NDW's is ~362 MB uncompressed — so it is parsed
 * with a streaming SAX scanner rather than a full DOM. Memory is bounded to the
 * output Map (tens of MB) plus a few small per-record accumulators, regardless
 * of input size: at no point is the whole document, or even a whole record's
 * subtree, materialised.
 *
 * NDW sites are point loop-detectors carrying a `measurementSiteLocation`
 * with either an `xsi:type="Point"` (a single `locationForDisplay` lat/lon) or
 * an `xsi:type="ItineraryByIndexedLocations"` wrapping a `Linear` location
 * (start/end `pointCoordinates`). Records with no resolvable location are
 * skipped. A `posList` (gml linear) wins over a coordinate pair, which wins over
 * a display point — the same priority the DOM parser used.
 */
import type { LineString, Point } from "geojson";
import { SaxesParser } from "saxes";
import { flattenString, stripXmlNamespace } from "./xml.js";

/** Geometry shapes a measurement site can resolve to. */
export type SiteGeometry = Point | LineString;

/** Incremental, streaming DATEX site-table parser. */
export interface SiteTableParser {
  /** Feed a chunk of decoded XML text. Chunks may split mid-element. */
  write(chunk: string): void;
  /** Finalise parsing and return the accumulated id→Geometry map. */
  close(): Map<string, SiteGeometry>;
}

function finiteOrNaN(raw: string | undefined): number {
  return raw != null && raw.trim() !== "" ? Number(raw) : NaN;
}

/**
 * Per-record accumulator for the streaming state machine. Only the small set of
 * lat/lon values and the current text-capture target are held; the surrounding
 * subtree is discarded as it streams past.
 */
interface RecordState {
  id?: string;
  // Display point (lowest priority).
  displayLat?: number;
  displayLon?: number;
  // Coordinate-pair endpoints (middle priority).
  startLat?: number;
  startLon?: number;
  endLat?: number;
  endLon?: number;
  // posList linear coordinates (highest priority): [lon, lat] pairs.
  posListCoords: [number, number][];
}

function freshRecord(id: string | undefined): RecordState {
  return { ...(id != null ? { id } : {}), posListCoords: [] };
}

/**
 * Resolve a finished record's geometry, preferring a `posList` LineString, then
 * a start/end coordinate-pair LineString, then a display Point. Returns null
 * when nothing resolves.
 */
function geometryForRecord(r: RecordState): SiteGeometry | null {
  if (r.posListCoords.length >= 2) {
    return { type: "LineString", coordinates: r.posListCoords };
  }

  if (
    Number.isFinite(r.startLat) &&
    Number.isFinite(r.startLon) &&
    Number.isFinite(r.endLat) &&
    Number.isFinite(r.endLon)
  ) {
    return {
      type: "LineString",
      coordinates: [
        [r.startLon!, r.startLat!],
        [r.endLon!, r.endLat!],
      ],
    };
  }

  if (Number.isFinite(r.displayLat) && Number.isFinite(r.displayLon)) {
    return { type: "Point", coordinates: [r.displayLon!, r.displayLat!] };
  }

  return null;
}

/**
 * Creates a streaming DATEX site-table parser. The returned object accepts
 * decoded XML in arbitrary chunks (which may split mid-element) and, on
 * `close()`, returns an id→Geometry map. Malformed input is tolerated: a SAX
 * error stops further accumulation and `close()` returns whatever resolved
 * before the error rather than throwing.
 *
 * The scanner tracks only the local names on a small stack and the lat/lon
 * fields of the record currently open, so peak memory is the output Map plus a
 * constant-ish per-record overhead — never a DOM.
 */
export function createSiteTableParser(): SiteTableParser {
  const map = new Map<string, SiteGeometry>();

  // Stack of stripped local element names, used to know where text belongs.
  const stack: string[] = [];
  let record: RecordState | null = null;
  // Which coordinate-pair endpoint we are inside (start/end), if any.
  let endpoint: "start" | "end" | null = null;
  // The lat/lon leaf we are currently capturing text into.
  let textTarget: "latitude" | "longitude" | "posList" | null = null;
  let textBuffer = "";
  let failed = false;

  // No namespace resolution (xmlns defaults to false): tag names arrive verbatim
  // (e.g. `gml:posList`), which we normalise with stripXmlNamespace. This also
  // means saxes never errors on prefixes bound by xmlns attributes we ignore.
  // Not a fragment parser: the table is a complete document (it carries an XML
  // declaration), and fragment mode rejects that declaration when it straddles a
  // chunk boundary. Position tracking is off — pure overhead for our scan.
  const parser = new SaxesParser({
    position: false,
  });

  // Entity-bomb safety: reject any DOCTYPE/internal subset outright. saxes does
  // not expand custom (DTD-declared) entities anyway, but a feed shipping a
  // DOCTYPE is not a shape we accept.
  parser.on("doctype", () => {
    throw new Error("XML DOCTYPE/entity declarations are not allowed");
  });

  parser.on("error", () => {
    // Tolerate malformed input: keep what resolved so far, stop accumulating.
    failed = true;
  });

  const flushText = (): void => {
    if (textTarget == null || record == null) {
      textBuffer = "";
      return;
    }

    if (textTarget === "posList") {
      const nums = textBuffer.trim().split(/\s+/).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const lat = nums[i]!;
        const lon = nums[i + 1]!;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          record.posListCoords.push([lon, lat]);
        }
      }
    } else {
      const value = finiteOrNaN(textBuffer);
      if (Number.isFinite(value)) {
        // NDW carries a point under `locationForDisplay`; DATEX v1 feeds (e.g.
        // TII) carry it as a bare `pointCoordinates` directly under an
        // `xsi:type="Point"` location. Both are display points when not inside a
        // linear start/end endpoint (those are handled by the branches above).
        const inDisplay =
          stack.includes("locationForDisplay") || stack.includes("pointCoordinates");
        if (endpoint === "start") {
          if (textTarget === "latitude") record.startLat = value;
          else record.startLon = value;
        } else if (endpoint === "end") {
          if (textTarget === "latitude") record.endLat = value;
          else record.endLon = value;
        } else if (inDisplay) {
          if (textTarget === "latitude") record.displayLat = value;
          else record.displayLon = value;
        }
      }
    }

    textBuffer = "";
  };

  parser.on("opentag", (tag) => {
    const local = stripXmlNamespace(tag.name);
    stack.push(local);

    if (local === "measurementSiteRecord") {
      const attrs = tag.attributes as Record<string, string>;
      // Flatten the id: it becomes a long-lived Map key, and a sliced-string key
      // would pin the whole input chunk it came from (see flattenString).
      const id = attrs["id"];
      record = freshRecord(id != null ? flattenString(id) : undefined);
      endpoint = null;
      textTarget = null;
      textBuffer = "";
      return;
    }

    if (record == null) return;

    if (local === "linearCoordinatesStartPoint") endpoint = "start";
    else if (local === "linearCoordinatesEndPoint") endpoint = "end";
    else if (local === "posList") {
      textTarget = "posList";
      textBuffer = "";
    } else if (local === "latitude") {
      textTarget = "latitude";
      textBuffer = "";
    } else if (local === "longitude") {
      textTarget = "longitude";
      textBuffer = "";
    }
  });

  parser.on("text", (text) => {
    if (textTarget != null) textBuffer += text;
  });

  parser.on("cdata", (text) => {
    if (textTarget != null) textBuffer += text;
  });

  parser.on("closetag", (tag) => {
    const local = stripXmlNamespace(tag.name);

    if (local === "latitude" || local === "longitude" || local === "posList") {
      flushText();
      textTarget = null;
    }

    if (local === "linearCoordinatesStartPoint" || local === "linearCoordinatesEndPoint") {
      endpoint = null;
    }

    if (local === "measurementSiteRecord" && record != null) {
      const geom = geometryForRecord(record);
      if (record.id != null && geom != null) map.set(record.id, geom);
      record = null;
      endpoint = null;
      textTarget = null;
      textBuffer = "";
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
    close(): Map<string, SiteGeometry> {
      if (!failed) {
        try {
          parser.close();
        } catch {
          failed = true;
        }
      }
      return map;
    },
  };
}

/**
 * Parse a DATEX II MeasurementSiteTablePublication into a map of
 * `measurementSiteRecord id` → resolved geometry. The id is the join key used by
 * a MeasuredDataPublication's `measurementSiteReference id`.
 *
 * This is a thin convenience over {@link createSiteTableParser} for unit tests
 * and small in-memory inputs — it shares the exact extraction logic, just
 * feeding the whole document in one write. Production callers handling the large
 * NDW table should stream chunks through `createSiteTableParser` instead.
 */
export function parseDatexSiteTable(input: string | Buffer): Map<string, SiteGeometry> {
  const str = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const parser = createSiteTableParser();
  parser.write(str);
  return parser.close();
}
