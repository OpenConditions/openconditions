import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  unzipEntries,
} from "@openconditions/ingest-framework";
import type { WeatherCatalogFeed } from "../feed-schema.js";
import { utcInstant } from "../records.js";
import { reading, stationDraft } from "../station.js";

export const DWD_PRODUCTS = {
  tu: {
    fields: {
      TT_10: ["air_temperature", "Cel", "mean"],
      TD_10: ["dew_point", "Cel", "mean"],
      RF_10: ["humidity", "%", "mean"],
    },
  },
  ff: {
    fields: { FF_10: ["wind_speed", "m/s", "mean"], DD_10: ["wind_direction", "deg", "mean"] },
  },
  fx: { fields: { FX_10: ["wind_gust", "m/s", "max"] } },
  rr: { fields: { RWS_10: ["precipitation_amount", "mm", "sum"] } },
} as const;
export const DWD_ROLES = Object.keys(DWD_PRODUCTS) as (keyof typeof DWD_PRODUCTS)[];
export const DWD_PROPERTIES = Object.values(DWD_PRODUCTS).flatMap((p) =>
  Object.values(p.fields).map((f) => `weather.${f[0]}`),
);
const identity = (s: string): string => {
  if (!/^\d{1,5}$/.test(s)) throw new Error(`DWD invalid station identity: ${s}`);
  return s.padStart(5, "0");
};

/** CDC now dates are UTC, with minutes. Reject rollover and future times before reading can clamp them. */
export function dwdTime(s: string, fetchedAt: string): string {
  if (!/^\d{12}$/.test(s)) throw new Error(`DWD invalid measurement time: ${s}`);
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00Z`;
  const at = Date.parse(iso);
  if (
    !Number.isFinite(at) ||
    new Date(at).toISOString().replace(/[-:T]/g, "").slice(0, 12) !== s ||
    at > Date.parse(fetchedAt)
  )
    throw new Error(`DWD invalid or future measurement time: ${s}`);
  return iso;
}
interface Site {
  id: string;
  from: string;
  until: string;
  point: readonly [number, number];
  name: string;
  free: boolean;
  distribution: string;
}
/** The body is Latin-1; name and state occupy fixed forty-character columns. */
export function dwdSites(body: Buffer): Map<string, Site> {
  const lines = body
    .toString("latin1")
    .split(/\r?\n/)
    .filter((s) => s.trim());
  if (!lines[0]?.startsWith("Stations_id von_datum bis_datum"))
    throw new Error("DWD station header missing");
  const sites = new Map<string, Site>();
  for (const line of lines.slice(2)) {
    const m =
      /^(\d{5})\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s(.{41})(.{41})(.*)$/.exec(
        line,
      );
    if (!m) throw new Error("DWD malformed station row");
    const id = identity(m[1]!);
    const lat = Number(m[5]);
    const lon = Number(m[6]);
    if (sites.has(id) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      throw new Error("DWD duplicate or invalid station");
    const from = dwdTime(`${m[2]}0000`, "9999-12-31T23:59:59Z").slice(0, 10);
    const until = dwdTime(`${m[3]}0000`, "9999-12-31T23:59:59Z").slice(0, 10);
    if (from > until || !m[7]!.trim() || !m[9]!.trim())
      throw new Error("DWD invalid station interval/name/rights");
    sites.set(id, {
      id,
      from,
      until,
      point: [lon, lat],
      name: m[7]!.trim(),
      free: m[9]!.trim() === "Frei",
      distribution: m[9]!.trim(),
    });
  }
  if (!sites.size) throw new Error("DWD empty station metadata");
  return sites;
}
/** Daily station-table coverage can lag fresh now/ archives by one UTC day. */
export function dwdMetadataEnd(until: string): string {
  return new Date(Date.parse(`${until}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
}
interface Sample {
  time: string;
  value: number;
  qn: string;
}
export function parseDwd(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  // Directory membership is not a census or deletion authority, even after every request succeeds.
  out.featuresComplete = false;
  const stations = new Map<
    string,
    {
      site: Site;
      channels: Map<
        string,
        { property: string; unit: string; aggregation: "mean" | "max" | "sum"; sample?: Sample }
      >;
    }
  >();
  let rejected = 0;
  const archiveStations = new Set<string>();
  for (const role of DWD_ROLES) {
    const meta = payloads[`${role}_stations`];
    const archives = payloads[role];
    if (meta?.length !== 1 || !archives?.length)
      throw new Error(`DWD missing required ${role} role`);
    const sites = dwdSites(meta[0]!);
    const fields = Object.entries(DWD_PRODUCTS[role].fields);
    // Metadata describes supported channels; a directory omission cannot withdraw them.
    for (const [id, site] of sites) {
      const day = ctx.fetchedAt.slice(0, 10);
      if (day < site.from || day > dwdMetadataEnd(site.until)) continue;
      const prior = stations.get(id);
      if (prior && JSON.stringify(prior.site.point) !== JSON.stringify(site.point))
        throw new Error("DWD conflicting source-epoch geography");
      if (prior && !site.free) {
        prior.site.free = false;
        prior.site.distribution = site.distribution;
      }
      const station = prior ?? { site, channels: new Map() };
      stations.set(id, station);
      for (const [field, [property, unit, aggregation]] of fields)
        station.channels.set(field, { property: `weather.${property}`, unit, aggregation });
    }
    const seen = new Set<string>();
    for (const zip of archives) {
      const entries = unzipEntries(zip, {
        entries: /^produkt_zehn_now_.*\.txt$/,
        maxEntries: 8,
        maxBytes: 2_000_000,
      });
      if (entries.length !== 1) throw new Error("DWD expected one measurement member");
      const entry = entries[0]!;
      const fileId = identity(/_(\d{5})\.txt$/.exec(entry.name)?.[1] ?? "");
      if (seen.has(fileId)) throw new Error("DWD duplicate station archive");
      seen.add(fileId);
      const site = sites.get(fileId);
      const lines = entry.data.toString("latin1").trim().split(/\r?\n/);
      const header = lines
        .shift()!
        .split(";")
        .map((s) => s.trim());
      if (
        new Set(header).size !== header.length ||
        ["STATIONS_ID", "MESS_DATUM", "QN", "eor", ...fields.map(([f]) => f)].some(
          (f) => !header.includes(f),
        )
      )
        throw new Error("DWD missing/duplicate measurement columns");
      const samples = new Map<string, Sample>();
      const clocks = new Set<string>();
      for (const line of lines) {
        const cells = line.split(";").map((s) => s.trim());
        if (cells.length !== header.length) throw new Error("DWD partial measurement row");
        const row = Object.fromEntries(header.map((h, i) => [h, cells[i]!]));
        if (identity(row.STATIONS_ID!) !== fileId || row.eor !== "eor" || !row.QN)
          throw new Error("DWD malformed measurement identity/quality/end");
        const time = dwdTime(row.MESS_DATUM!, ctx.fetchedAt);
        if (clocks.has(time)) throw new Error("DWD duplicate measurement timestamp");
        clocks.add(time);
        for (const [field, [property]] of fields) {
          const raw = row[field]!;
          if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error("DWD malformed numeric value");
          const value = Number(raw);
          if (!Number.isFinite(value)) throw new Error("DWD non-finite numeric value");
          if (value === -999) continue;
          if (
            (property === "humidity" && (value < 0 || value > 100)) ||
            (property === "wind_direction" && (value < 0 || value > 360)) ||
            (["wind_speed", "wind_gust", "precipitation_amount"].includes(property) && value < 0)
          )
            throw new Error("DWD out of range value");
          if (
            !site ||
            time.slice(0, 10) < site.from ||
            time.slice(0, 10) > dwdMetadataEnd(site.until) ||
            Date.parse(ctx.fetchedAt) - Date.parse(time) >= 3600_000
          )
            continue;
          if (!samples.has(field) || samples.get(field)!.time < time)
            samples.set(field, { time, value, qn: row.QN! });
        }
      }
      if (!site) {
        recordSkipped(feed.id, "no_geometry");
        continue;
      }
      archiveStations.add(fileId);
      const station = stations.get(fileId);
      if (station)
        for (const [field, sample] of samples) station.channels.get(field)!.sample = sample;
    }
    rejected += [...sites.keys()].filter((id) => !seen.has(id)).length;
  }
  for (const [stationId, { site, channels }] of stations) {
    const current = [...channels].filter(([, c]) => c.sample);
    if (!current.length) {
      if (archiveStations.has(stationId)) rejected++;
      continue;
    }
    out.features.push(
      stationDraft(feed, ctx.fetchedAt, {
        stationId,
        point: site.point,
        names: [{ lang: "de", text: site.name }],
        lifecycle: "unknown",
        country: "DE",
        measuredProperties: [...channels.values()].map((c) => c.property),
        channels: [...channels].map(([key, c]) => ({ key, property: c.property })),
      }),
    );
    for (const [componentKey, c] of current) {
      const draft = reading(feed, ctx.fetchedAt, {
        stationId,
        point: site.point,
        componentKey,
        property: c.property,
        result: { type: "quantity", value: c.sample!.value, unit: c.unit },
        measuredAt: c.sample!.time,
        windowSec: 600,
        aggregation: c.aggregation,
        supplierCode: `QN:${c.sample!.qn}`,
      });
      draft.freshness = {
        fetchedAt: ctx.fetchedAt,
        expiresAt: utcInstant(new Date(Date.parse(c.sample!.time) + 3600_000)),
      };
      out.observations.push(draft);
    }
  }
  for (const draft of [...out.features, ...out.observations]) {
    const provenance = draft.provenance as { recordId: string; upstream?: unknown[] };
    if (stations.get(provenance.recordId)?.site.free === false) {
      provenance.upstream = [
        {
          publisher: "DWD CDC station distribution flag",
          recordId: provenance.recordId,
          license: "NOASSERTION",
          attribution: `Abgabe: ${stations.get(provenance.recordId)?.site.distribution}`,
        },
      ];
    }
  }
  out.rejected = rejected;
  return out;
}
