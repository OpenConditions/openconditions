import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { accountSituations } from "../accounting.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { polygonalGeometry } from "../geometry.js";
import { freshness, isRecord, provenance, situationId, utcInstant } from "../records.js";

/** EFFIS writes the EU's country codes: Greece is `EL`, the United Kingdom `UK`, and Kosovo its own `KS`. */
const COUNTRY: Readonly<Record<string, string>> = { EL: "GR", UK: "GB", KS: "XK" };

/** The land-cover shares and the Natura 2000 share EFFIS reports for a burnt area, by the extras key they get. */
const SHARES: Readonly<Record<string, string>> = {
  BROADLEA: "broadleavedPct",
  CONIFER: "coniferPct",
  MIXED: "mixedForestPct",
  SCLEROPH: "sclerophyllousPct",
  TRANSIT: "transitionalPct",
  OTHERNATLC: "otherNaturalPct",
  AGRIAREAS: "agriculturalPct",
  ARTIFSURF: "artificialPct",
  OTHERLC: "otherLandCoverPct",
  PERCNA2K: "natura2000Pct",
};

/** A value EFFIS filled, which writes "N.A." for what it has not. */
function given(value: unknown): string | undefined {
  const s =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return s === "" || s === "N.A." ? undefined : s;
}

/** A number EFFIS writes as a string, possibly padded. */
function numeric(value: unknown): number | undefined {
  const s = given(value);
  const n = s === undefined ? Number.NaN : Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/;

/** EFFIS's zone-less `YYYY-MM-DD HH:MM:SS[.ffffff]` as the UTC instant it is, to the second. */
function utcTime(value: unknown): string | undefined {
  const match = TIME.exec(given(value) ?? "");
  if (match === null) return undefined;
  const at = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(at.getTime()) ? undefined : utcInstant(at);
}

/** The features of a WFS GeoJSON answer; an OGC ExceptionReport, which a server may send at HTTP 200, fails the parse. */
function featuresOf(body: Buffer): unknown[] {
  const raw = body.toString("utf8");
  if (raw.trimStart().startsWith("<")) {
    const reason = /<(?:ows:)?ExceptionText[^>]*>([^<]*)</.exec(raw)?.[1]?.trim();
    throw new Error(`EFFIS answered an OGC exception${reason ? `: ${reason}` : ""}`);
  }
  const root: unknown = JSON.parse(raw);
  const features = isRecord(root) ? root["features"] : undefined;
  if (!Array.isArray(features)) throw new Error("EFFIS answered no feature collection");
  return features;
}

/**
 * The `effis` format: EFFIS's burnt areas of the last seven days (MODIS
 * burnt-area polygons) as `natural_hazard` situations of subtype
 * `burned_area`, keyed by the feature's own id, which holds from the weekly
 * to the monthly layer. The country is the ISO code of EFFIS's EU-style one,
 * "N.A." is no value, and the zone-less times are UTC. The burnt area's
 * date is when the fire was first seen, not a validity: the state is
 * unknown. EFFIS's class and land-cover shares travel as extras. A feature
 * with no id, no readable polygon or no fire date is rejected and counted;
 * an OGC ExceptionReport fails the parse.
 */
export function parseEffis(
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
    for (const feature of featuresOf(body)) {
      inputCount++;
      const p = isRecord(feature) ? feature["properties"] : undefined;
      const id = isRecord(p) ? given(p["id"]) : undefined;
      const geometry = isRecord(feature) ? polygonalGeometry(feature["geometry"]) : null;
      const firedAt = isRecord(p) ? utcTime(p["FIREDATE"]) : undefined;
      if (!isRecord(p) || id === undefined || geometry === null || firedAt === undefined) {
        rejected++;
        continue;
      }
      if (seen.has(id)) {
        duplicates++;
        continue;
      }
      seen.add(id);
      const code = given(p["COUNTRY"])?.toUpperCase();
      const country = code === undefined ? undefined : (COUNTRY[code] ?? code);
      const commune = given(p["COMMUNE"]);
      const province = given(p["PROVINCE"]);
      const area = numeric(p["AREA_HA"]);
      const klass = given(p["CLASS"]);
      const shares = Object.entries(SHARES).flatMap(([field, key]) => {
        const share = numeric(p[field]);
        return share === undefined ? [] : [[key, share] as const];
      });
      const updated = utcTime(p["UPDATED"]) ?? utcTime(p["LASTUPDATE"]);
      out.situations.push({
        id: situationId(feed, id),
        class: "situation",
        kind: "natural_hazard",
        type: "wildfire",
        subtype: "burned_area",
        temporality: "live",
        location: {
          geometry,
          extent: "area",
          geometryOrigin: "source",
          fuzziness: "exact",
          ...(country !== undefined && /^[A-Z]{2}$/.test(country)
            ? { admin: { country, ...(commune === undefined ? {} : { municipality: commune }) } }
            : {}),
        },
        provenance: provenance(feed, id, updated),
        freshness: freshness(ctx.fetchedAt),
        planned: false,
        certainty: "observed",
        severity: { label: "unknown" },
        validity: { status: "unknown", start: firedAt },
        effects: [],
        details: {
          kind: "natural_hazard",
          v: 1,
          ...(area === undefined || area < 0 ? {} : { areaHa: area }),
          discoveredAt: firedAt,
        },
        extras: {
          ...(klass === undefined ? {} : { class: klass }),
          ...(province === undefined ? {} : { province }),
          ...Object.fromEntries(shares),
        },
      });
    }
  }
  accountSituations(out, { inputCount, duplicates, rejected });
  return out;
}
