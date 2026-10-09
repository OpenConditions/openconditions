import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { accountSituations } from "../accounting.js";
import { arcgisFeatures } from "../arcgis.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { polygonalGeometry } from "../geometry.js";
import { freshness, isRecord, provenance, situationId, utcInstant } from "../records.js";

const DENSITIES = new Set(["light", "medium", "heavy"]);
const DAY_MS = 86_400_000;
const ORDINAL = /^(\d{4})(\d{3}) (\d{2})(\d{2})$/;

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** HMS's `YYYYDDD HHMM` (UTC, the day counted in the year) as an instant; day 366 exists only in a leap year. */
function ordinalTime(value: unknown): { at: string; day: string } | undefined {
  const match = typeof value === "string" ? ORDINAL.exec(value.trim()) : null;
  if (match === null || match === undefined) return undefined;
  const [year, day, hours, minutes] = [match[1], match[2], match[3], match[4]].map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (day < 1 || day > (isLeap(year) ? 366 : 365) || hours > 23 || minutes > 59) return undefined;
  return {
    at: utcInstant(new Date(Date.UTC(year, 0, day, hours, minutes))),
    day: `${match[1]}${match[2]}`,
  };
}

/**
 * The `hms` format: NOAA's Hazard Mapping System smoke polygons as
 * `natural_hazard` situations of type `smoke`. The layer holds one day's
 * analysis and its `FID` restarts each day, so the local id is the day of
 * `Start` and the `FID`. A polygon is graded `Light`, `Medium` or `Heavy`.
 *
 * The image sequence a polygon was drawn from ends hours before the plume
 * does, so `Start`..`End_` is the detection window in `details.detection`,
 * and the situation stays active while the layer lists it, expiring a day
 * after `Start` should no later poll hold it. A polygon with no
 * `FID`, an unknown density, an unreadable time or shape is rejected and
 * counted. The layer is empty from early morning until the first analysis;
 * that is an accounted zero and ends yesterday's polygons. An `{error}`
 * document fails the parse.
 */
export function parseHms(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  let inputCount = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const body of payloads["main"] ?? []) {
    for (const feature of arcgisFeatures(body, "HMS")) {
      inputCount++;
      const p = isRecord(feature) ? feature["properties"] : undefined;
      const geometry = isRecord(feature) ? polygonalGeometry(feature["geometry"]) : null;
      const start = isRecord(p) ? ordinalTime(p["Start"]) : undefined;
      const fid = isRecord(p) && Number.isInteger(p["FID"]) ? Number(p["FID"]) : undefined;
      const density =
        isRecord(p) && typeof p["Density"] === "string" ? p["Density"].trim().toLowerCase() : "";
      if (
        !isRecord(p) ||
        geometry === null ||
        start === undefined ||
        fid === undefined ||
        !DENSITIES.has(density)
      ) {
        rejected++;
        continue;
      }
      const localId = `${start.day}-${fid}`;
      if (seen.has(localId)) {
        duplicates++;
        continue;
      }
      seen.add(localId);
      const end = ordinalTime(p["End_"]);
      const satellite = typeof p["Satellite"] === "string" ? p["Satellite"].trim() : "";
      out.situations.push({
        id: situationId(feed, localId),
        class: "situation",
        kind: "natural_hazard",
        type: "smoke",
        temporality: "live",
        location: {
          geometry,
          extent: "area",
          geometryOrigin: "source",
          fuzziness: "exact",
        },
        provenance: provenance(feed, localId),
        // A day's analysis is replaced by the next day's: a plume no poll has
        // confirmed for a day is not drawn, whatever became of the feed.
        freshness: freshness(ctx.fetchedAt, utcInstant(new Date(Date.parse(start.at) + DAY_MS))),
        planned: false,
        certainty: "observed",
        severity: { label: "unknown" },
        validity: { status: "active", start: start.at },
        effects: [],
        details: {
          kind: "natural_hazard",
          v: 1,
          density,
          detection: {
            ...(satellite === "" ? {} : { satellite }),
            start: start.at,
            ...(end === undefined ? {} : { end: end.at }),
          },
        },
      });
    }
  }
  accountSituations(out, { inputCount, duplicates, rejected });
  return out;
}
