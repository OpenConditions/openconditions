import { recordSkipped } from "@openconditions/ingest-framework";
import type { LineString } from "geojson";
import type { FlowContext, FlowSites } from "./flow-output.js";
import type { FlowParse, FlowReading } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

interface SpeedBandRow {
  LinkID?: unknown;
  RoadName?: unknown;
  SpeedBand?: unknown;
  MinimumSpeed?: unknown;
  MaximumSpeed?: unknown;
  StartLon?: unknown;
  StartLat?: unknown;
  EndLon?: unknown;
  EndLat?: unknown;
}

function num(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the LTA DataMall Traffic Speed Bands (v2/v3) JSON — records under a
 * top-level `value` array — one reading per link. Each link carries a
 * `SpeedBand` (1–8) and a `MinimumSpeed`/`MaximumSpeed` band in km/h; the
 * representative speed is the band midpoint. Geometry is the Start→End
 * coordinate pair as a two-point LineString. los is left "unknown" (absolute
 * speed is road-class–dependent) so the baseline enrichment classifies it. The
 * feed dates nothing, so readings are dated by the poll.
 *
 * DataMall caps this resource at 500 links per call via `$skip`; the feed
 * declares `pagination` so the ingest fetch layer follows every page and this
 * parser runs once per page, its readings concatenated for full national coverage.
 *
 * A link without an id or a speed band is skipped as malformed, as is one with
 * a missing or unreadable coordinate; one with no coordinate at all as having
 * no geometry.
 */
export function parseLtaSpeedBands(
  input: string | Buffer,
  src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { readings: [], failed: true };
  }
  const rows = (doc as { value?: unknown })?.value;
  if (!Array.isArray(rows)) return { readings: [], failed: true };

  const readings: FlowReading[] = [];

  for (const raw of rows as SpeedBandRow[]) {
    try {
      const linkId = raw?.LinkID != null ? String(raw.LinkID) : null;
      if (!linkId) {
        recordSkipped(src.id, "malformed");
        continue;
      }

      const startLon = num(raw.StartLon);
      const startLat = num(raw.StartLat);
      const endLon = num(raw.EndLon);
      const endLat = num(raw.EndLat);
      if (startLon == null || startLat == null || endLon == null || endLat == null) {
        const absent = [raw.StartLon, raw.StartLat, raw.EndLon, raw.EndLat].every(
          (v) => v == null || v === "",
        );
        recordSkipped(src.id, absent ? "no_geometry" : "malformed");
        continue;
      }
      const geometry: LineString = {
        type: "LineString",
        coordinates: [
          [startLon, startLat],
          [endLon, endLat],
        ],
      };

      const min = num(raw.MinimumSpeed);
      const max = num(raw.MaximumSpeed);
      // Band midpoint; the top band (e.g. "70"/"") is open-ended, so fall back
      // to whichever bound is present.
      const speedKph = min != null && max != null ? (min + max) / 2 : (max ?? min ?? undefined);
      if (speedKph == null) {
        recordSkipped(src.id, "malformed");
        continue;
      }

      const name = typeof raw.RoadName === "string" ? raw.RoadName.trim() : "";
      readings.push({
        site: linkId,
        geometry,
        los: "unknown",
        speedKph,
        ...(name ? { name, nameLang: "en" } : {}),
      });
    } catch (err) {
      console.warn("[lta-speedbands] skipped malformed row:", err);
      recordSkipped(src.id, "malformed");
    }
  }

  return { readings };
}
