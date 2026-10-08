import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { type EvseInput, type Lifecycle, parsePowerKw, siteDraft } from "../site.js";
import { isRecord, placeAt, positiveInteger, type Raw, text } from "./raw.js";

interface Plug {
  standard: string;
  format?: "socket" | "cable";
}

/**
 * The plug a group names. A CCS or CHAdeMO plug is always on its cable; a
 * Type 1 or Type 2 says whether it is socketed or tethered.
 */
function plugOf(name: string): Plug {
  const n = name.toLowerCase();
  if (/chademo/.test(n)) return { standard: "CHADEMO", format: "cable" };
  if (/type\s*1\s*ccs/.test(n)) return { standard: "IEC_62196_T1_COMBO", format: "cable" };
  if (/type\s*2\s*ccs/.test(n)) return { standard: "IEC_62196_T2_COMBO", format: "cable" };
  const format = /socketed/.test(n) ? "socket" : /tethered/.test(n) ? "cable" : undefined;
  const standard = /type\s*1/.test(n)
    ? "IEC_62196_T1"
    : /type\s*2/.test(n)
      ? "IEC_62196_T2"
      : "UNKNOWN";
  return { standard, ...(format === undefined ? {} : { format }) };
}

/** A group's operative state; its other values say nothing. */
const LIFECYCLES: Readonly<Record<string, Lifecycle>> = { inoperative: "temporarily_closed" };

interface Group {
  current?: "ac" | "dc";
  kw?: number;
  plug: Plug;
  status?: string;
  count?: number;
}

/**
 * `connectorsList`: `{AC, 32 kW, Type 2 Socketed, Status: Operative, Count:9},…`,
 * one group of identical charge points per brace.
 */
function groupsOf(list: string | undefined): Group[] {
  return [...(list ?? "").matchAll(/\{([^}]*)\}/g)].flatMap(([, inner]) => {
    const parts = (inner ?? "").split(",").map((p) => p.trim());
    const [current, power, type] = parts;
    if (type === undefined) return [];
    const status = parts.find((p) => /^status\s*:/i.test(p))?.replace(/^status\s*:\s*/i, "");
    const count = positiveInteger(
      parts.find((p) => /^count\s*:/i.test(p))?.replace(/^count\s*:\s*/i, ""),
    );
    const c = current?.toLowerCase();
    const kw = parsePowerKw(power?.replace(/\s+/g, " "));
    return [
      {
        ...(c === "ac" || c === "dc" ? { current: c } : {}),
        ...(kw === undefined ? {} : { kw }),
        plug: plugOf(type),
        ...(status === undefined ? {} : { status: status.toLowerCase() }),
        ...(count === undefined ? {} : { count }),
      },
    ];
  });
}

/** Lower case, accents dropped, every run of other characters one hyphen. */
const normalised = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A coordinate to four decimals (about 11 m), without trailing zeros. */
const rounded = (degrees: number) => String(Number(degrees.toFixed(4)));

const isTrue = (value: unknown) => text(value)?.toLowerCase() === "true";
const isFalse = (value: unknown) => text(value)?.toLowerCase() === "false";

function siteLifecycle(groups: Group[]): Lifecycle {
  if (groups.some((g) => g.status === "operative")) return "operational";
  if (groups.length > 0 && groups.every((g) => g.status === "inoperative")) {
    return "temporarily_closed";
  }
  return "unknown";
}

/**
 * The charge points the groups describe. A group is its own unless it is a
 * plug of a dual-head unit: DC groups of different plugs at one power, one
 * `Count` and one state (`{CCS, 75 kW, Count:2},{CHAdeMO, 75 kW, Count:2}`
 * is two units with both plugs, not four charge points) are one unit with a
 * connector for each.
 */
function unitsOf(groups: readonly Group[]): Group[][] {
  const units: Group[][] = [];
  for (const g of groups) {
    const unit =
      g.current === "dc"
        ? units.find(
            (u) =>
              u[0]?.current === "dc" &&
              u[0].kw === g.kw &&
              u[0].count === g.count &&
              u[0].status === g.status &&
              u.every((other) => other.plug.standard !== g.plug.standard),
          )
        : undefined;
    if (unit === undefined) units.push([g]);
    else unit.push(g);
  }
  return units;
}

/**
 * Waka Kotahi's EVRoam layer as GeoJSON: a feature per site, its
 * `connectorsList` groups of identical charge points, each unit one EVSE
 * standing for its `Count`. A group's state is the publisher's daily operative flag, a
 * lifecycle and never a reading. `GlobalID` and `OBJECTID` are regenerated on
 * every reload, so the site is keyed by its rounded coordinates and its
 * normalised name, and neither upstream id is kept.
 */
export function parseEvroam(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = JSON.parse(body.toString("utf8")) as unknown;
    const features = isRecord(doc) && Array.isArray(doc["features"]) ? doc["features"] : [];
    for (const feature of features.filter(isRecord)) {
      const props: Raw = isRecord(feature["properties"]) ? feature["properties"] : {};
      const geometry = isRecord(feature["geometry"]) ? feature["geometry"] : {};
      const [lon, lat] = Array.isArray(geometry["coordinates"]) ? geometry["coordinates"] : [];
      const point = placeAt(Number(lat ?? Number.NaN), Number(lon ?? Number.NaN));
      const name = text(props["name"]);
      const slug = name === undefined ? "" : normalised(name);
      if (point === undefined || slug === "") {
        rejected++;
        continue;
      }
      const stationId = `${rounded(point[1])},${rounded(point[0])},${slug}`;
      if (seen.has(stationId)) {
        rejected++;
        continue;
      }
      seen.add(stationId);

      const groups = groupsOf(text(props["connectorsList"]));
      const evses: EvseInput[] = unitsOf(groups).map((unit, i) => {
        const [g] = unit;
        const lifecycle = g?.status === undefined ? undefined : LIFECYCLES[g.status];
        return {
          key: String(i + 1),
          ...(g?.count === undefined ? {} : { quantity: g.count }),
          ...(lifecycle === undefined ? {} : { lifecycle }),
          connectors: unit.map((plug, k) => ({
            id: String(k + 1),
            ...plug.plug,
            ...(plug.current === undefined ? {} : { current: plug.current }),
            ...(plug.kw === undefined ? {} : { maxPowerKw: plug.kw }),
          })),
        };
      });
      const operator = text(props["operator"]);
      const owner = text(props["owner"]);
      out.features.push(
        siteDraft(
          feed,
          {
            stationId,
            point,
            name,
            lang: "en",
            ...(operator === undefined ? {} : { operator: { name: operator } }),
            ...(owner === undefined ? {} : { owner: { name: owner } }),
            address: { text: text(props["address"]) },
            ...(isTrue(props["is24Hours"]) ? { twentyFourSeven: true } : {}),
            // No charging cost is free charging; a cost has no price here.
            ...(isFalse(props["hasChargingCost"]) ? { payment: ["free" as const] } : {}),
            lifecycle: siteLifecycle(groups),
            evses,
          },
          ctx.fetchedAt,
        ),
      );
    }
  }
  out.rejected = rejected;
  return out;
}
