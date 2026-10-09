import type { FeedPayloads, ParseContext, ParseOutput } from "@openconditions/ingest-framework";
import type { Geometry } from "geojson";
import { capOutput } from "../cap/accounting.js";
import type { DerivedShape } from "../cap/situations.js";
import type { CapAlert, CapArea } from "../cap/types.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { DERIVED_SHAPE_TOLERANCE_DEG, derivedShape, unionPolygons } from "../geometry.js";
import { isRecord, utcInstant } from "../records.js";
import { aliasIndex, type MeteoAlarmAliasSnapshot } from "./meteoalarm-aliases.js";
import aliasSnapshot from "./snapshots/meteoalarm-aliases.json" with { type: "json" };

/**
 * How long after a poll a MeteoAlarm warning may be shown. MeteoAlarm's terms
 * allow a redistributor ten minutes behind its site; OC's share of that is
 * five minutes: a country's held answer stands in for up to two (the feed's
 * `maxPayloadAgeSec`) and a warning lives three past the poll that read it.
 */
const SERVE_WINDOW_MS = 180_000;

/**
 * The country of a MeteoAlarm warning from the ISO 3166 numeric code its
 * identifier carries (`2.49.0.0.250.0.FR.…` France, `2.49.0.1.578.0.…`
 * Norway), for every country of the feed's URL list.
 */
const COUNTRY_OF: Readonly<Record<string, string>> = {
  "20": "AD",
  "40": "AT",
  "56": "BE",
  "70": "BA",
  "100": "BG",
  "191": "HR",
  "196": "CY",
  "203": "CZ",
  "208": "DK",
  "233": "EE",
  "246": "FI",
  "250": "FR",
  "300": "GR",
  "348": "HU",
  "352": "IS",
  "372": "IE",
  "376": "IL",
  "380": "IT",
  "428": "LV",
  "440": "LT",
  "442": "LU",
  "470": "MT",
  "498": "MD",
  "499": "ME",
  "528": "NL",
  "578": "NO",
  "616": "PL",
  "620": "PT",
  "642": "RO",
  "688": "RS",
  "703": "SK",
  "705": "SI",
  "724": "ES",
  "752": "SE",
  "756": "CH",
  "804": "UA",
  "807": "MK",
  "826": "GB",
};

const IDENTIFIER_COUNTRY = /^(?:urn:oid:)?2\.49\.0\.[01]\.(\d{1,3})\./;

function countryOf(alert: CapAlert): string | undefined {
  const numeric = IDENTIFIER_COUNTRY.exec(alert.identifier)?.[1];
  const key = numeric === undefined ? undefined : String(Number(numeric));
  return key !== undefined && Object.hasOwn(COUNTRY_OF, key) ? COUNTRY_OF[key] : undefined;
}

interface MeteoAlarmDecoded {
  alerts: CapAlert[];
  /** Entries of the envelope that carry no alert. */
  unreadable: number;
}

function decodeMeteoAlarm(body: Buffer): MeteoAlarmDecoded {
  const root: unknown = JSON.parse(body.toString("utf8"));
  const warnings = isRecord(root) ? root["warnings"] : undefined;
  if (!Array.isArray(warnings)) throw new Error("MeteoAlarm answered no warnings envelope");
  const alerts: CapAlert[] = [];
  let unreadable = 0;
  for (const warning of warnings) {
    const alert = isRecord(warning) ? warning["alert"] : undefined;
    if (isRecord(alert) && typeof alert["identifier"] === "string") {
      alerts.push(alert as unknown as CapAlert);
    } else {
      unreadable++;
    }
  }
  return { alerts, unreadable };
}

/**
 * MeteoAlarm's warnings API (`{"warnings": [{"alert": …, "uuid": …}]}`) as
 * CAP messages: the `alert` is CAP written as JSON, every repeatable element
 * a list, which is the shape the CAP mapper reads. `{"warnings": []}` is a
 * country with nothing in force.
 */
export function readMeteoAlarm(body: Buffer): CapAlert[] {
  return decodeMeteoAlarm(body).alerts;
}

/** The raw shape of each EMMA region in MeteoAlarm's geocode file, by code. */
function emmaRegions(bodies: readonly Buffer[]): Map<string, unknown> {
  const regions = new Map<string, unknown>();
  for (const body of bodies) {
    try {
      const root: unknown = JSON.parse(body.toString("utf8"));
      const features = isRecord(root) ? root["features"] : undefined;
      if (!Array.isArray(features)) continue;
      for (const f of features) {
        const properties = isRecord(f) ? f["properties"] : undefined;
        const code = isRecord(properties) ? properties["code"] : undefined;
        if (typeof code === "string" && !regions.has(code) && isRecord(f)) {
          regions.set(code, f["geometry"]);
        }
      }
    } catch {
      // A geocode file that does not read leaves the areas with their codes.
    }
  }
  return regions;
}

let aliases: Map<string, string[]> | undefined;

/**
 * The EMMA regions each other code stands for, from the vendored copy of the
 * "Geocodes Aliases" CSV on MeteoAlarm's Redistribution Hub, built on first
 * use. Regenerated with `pnpm tsx scripts/gen-meteoalarm-aliases.ts` when the
 * Hub's change log lists a new file.
 */
function emmaAliases(): Map<string, string[]> {
  aliases ??= aliasIndex((aliasSnapshot as unknown as MeteoAlarmAliasSnapshot).rows);
  return aliases;
}

/**
 * The `meteoalarm` format: the warnings of each country feed as `alert`
 * situations. An area MeteoAlarm names by its `EMMA_ID` is placed at the
 * shape the geocode file gives that region (derived, simplified once, and a
 * shape that does not read is skipped). An area named only by another code
 * (NUTS, Irish FIPS 10-4, Czech CISORP, DWD's warn cells) takes the shapes of
 * the EMMA regions MeteoAlarm's alias table gives that code; an area neither
 * resolves keeps its geocodes alone.
 *
 * A warning is served for at most three minutes after the poll that read it
 * (`freshness.expiresAt` is the earlier of its `expires` and that), because
 * MeteoAlarm's terms bar showing its data later than ten minutes behind its
 * site. A country payload that is no envelope is rejected; the parse fails
 * only when every payload is.
 */
export function parseMeteoAlarm(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const bodies = payloads["alerts"] ?? [];
  const alerts: CapAlert[] = [];
  let unreadable = 0;
  let unreadablePayloads = 0;
  let firstError: unknown;
  for (const body of bodies) {
    try {
      const decoded = decodeMeteoAlarm(body);
      alerts.push(...decoded.alerts);
      unreadable += decoded.unreadable;
    } catch (error) {
      unreadablePayloads++;
      firstError ??= error;
    }
  }
  if (bodies.length > 0 && unreadablePayloads === bodies.length) throw firstError;

  const regions = emmaRegions(payloads["geocodes"] ?? []);
  const shapes = new Map<string, Geometry | null>();
  const shapeOf = (code: string): Geometry | null => {
    const known = shapes.get(code);
    if (known !== undefined) return known;
    const shape = derivedShape(regions.get(code), DERIVED_SHAPE_TOLERANCE_DEG);
    shapes.set(code, shape);
    return shape;
  };
  const aliases = emmaAliases();
  const geometryOf = (area: CapArea): DerivedShape | undefined => {
    // The hub writes the JSON, but an entry that is no name and string value is skipped, not a failed parse.
    const codes = (Array.isArray(area.geocode) ? area.geocode : []).flatMap((g: unknown) =>
      isRecord(g) && typeof g["valueName"] === "string" && typeof g["value"] === "string"
        ? [{ name: g["valueName"].trim(), value: g["value"].trim() }]
        : [],
    );
    // The EMMA ids an area names win; its other codes count only without them.
    const emma = codes.flatMap((c) => (c.name === "EMMA_ID" ? (shapeOf(c.value) ?? []) : []));
    const found =
      emma.length > 0
        ? emma
        : codes.flatMap((c) =>
            (aliases.get(`${c.name}:${c.value}`) ?? []).flatMap((id) => shapeOf(id) ?? []),
          );
    const geometry = unionPolygons(found);
    return geometry === null ? undefined : { geometry, origin: "derived" };
  };

  const horizon = Date.parse(ctx.fetchedAt) + SERVE_WINDOW_MS;
  const expiresAt = (expires: string | undefined): string => {
    const at = expires === undefined ? Number.NaN : Date.parse(expires);
    return expires !== undefined && at < horizon ? expires : utcInstant(new Date(horizon));
  };

  return capOutput(alerts, feed, {
    fetchedAt: ctx.fetchedAt,
    unreadable: unreadable + unreadablePayloads,
    geometryOf,
    expiresAt,
    countryOf,
  });
}
