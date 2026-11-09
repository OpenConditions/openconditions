import { createHash } from "node:crypto";
import type { FeedEndpoint, FetchFn } from "./catalog/types.js";
import { digestPayload } from "./payload.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

/** Reviewed publication identity, independent of page boundaries and object-key order. */
export function geofaDigest(features: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(features.map((f) => JSON.stringify(canonical(f))).sort()))
    .digest("hex");
}

export function geofaFeatures(buffers: readonly Buffer[]): Record<string, unknown>[] {
  return buffers.flatMap((buffer) => {
    const doc = JSON.parse(buffer.toString("utf8"));
    if (doc?.type !== "FeatureCollection" || !Array.isArray(doc.features))
      throw new Error("GeoFA: invalid collection");
    return doc.features;
  });
}

/** A pinned, reviewed publication is required because WFS paging is not transaction safe. */
export async function fetchGeofa(
  url: string,
  config: NonNullable<FeedEndpoint["geofa"]>,
  fetcher: FetchFn,
) {
  const q = config.qualification;
  const pageSize = config.pageSize ?? 500;
  if (!q && !config.nonWithdrawing)
    throw new Error("GeoFA: acquisition qualification required; no provider requests made");
  const base = new URL(url);
  if (
    base.searchParams.get("typeNames") !== "fkg:fkg.t_5607_ladefacilitet" ||
    base.searchParams.get("sortBy") !== "objekt_id" ||
    base.searchParams.get("srsName") !== "EPSG:4326"
  )
    throw new Error("GeoFA: current sorted EPSG:4326 layer required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900_000);
  const buffers: Buffer[] = [];
  const urls: string[] = [];
  const payloads = [];
  let bytes = 0;
  let previous = "";
  const order = new Intl.Collator("da");
  try {
    // Hits bound traversal coverage, not transaction consistency. Only an independently
    // qualified digest may grant withdrawal authority.
    const hits = async () => {
      const u = new URL(base);
      for (const key of [
        "count",
        "startIndex",
        "propertyName",
        "outputFormat",
        "sortBy",
        "srsName",
      ])
        u.searchParams.delete(key);
      u.searchParams.set("resultType", "hits");
      const response = await fetcher(u.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`GeoFA: hits HTTP ${response.status}`);
      let text = "";
      if (!response.body) throw new Error("GeoFA: missing hits body");
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024 || text.length + chunk.length > 65536) {
          controller.abort();
          throw new Error("GeoFA: hits byte bound exceeded");
        }
        text += Buffer.from(chunk).toString("utf8");
      }
      const match = /numberMatched=["'](\d+)["']/.exec(text);
      const count = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(count) || count < 1 || count > 49000)
        throw new Error("GeoFA: invalid or empty hits count");
      return count;
    };
    const expected = q?.count ?? (await hits());
    for (let page = 0; page < 100; page++) {
      const next = new URL(base);
      next.searchParams.set("count", String(pageSize));
      next.searchParams.set("startIndex", String(page * pageSize));
      const response = await fetcher(next.toString(), { signal: controller.signal });
      if (!response.ok)
        throw new Error(`GeoFA: page failed HTTP ${response.status}; retry on next daily poll`);
      const chunks: Uint8Array[] = [];
      if (!response.body) throw new Error("GeoFA: missing body");
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) {
          controller.abort();
          throw new Error("GeoFA: byte bound exceeded");
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const crs = JSON.parse(buffer.toString("utf8")).crs?.properties?.name;
      if (crs !== undefined && crs !== "urn:ogc:def:crs:OGC:1.3:CRS84" && crs !== "EPSG:4326")
        throw new Error("GeoFA: acquisition CRS changed");
      const rows = geofaFeatures([buffer]);
      for (const row of rows) {
        const id = (row["properties"] as Record<string, unknown>)?.["objekt_id"];
        if (
          typeof id !== "string" ||
          !id ||
          order.compare(id, previous) < 0 ||
          (id === previous && !config.nonWithdrawing)
        )
          throw new Error("GeoFA: repeated or unordered identity");
        previous = id;
      }
      buffers.push(buffer);
      urls.push(next.toString());
      payloads.push(digestPayload(next.toString(), buffer));
      const count = geofaFeatures(buffers).length;
      if (count > expected) throw new Error("GeoFA: generation count changed");
      if (rows.length < pageSize) {
        if (count !== expected || (q && geofaDigest(geofaFeatures(buffers)) !== q.sha256))
          throw new Error("GeoFA: incomplete or changed qualified generation");
        if (!q && (await hits()) !== expected) throw new Error("GeoFA: hits count changed");
        return { buffers, urls, payloads };
      }
    }
    throw new Error("GeoFA: page bound exceeded");
  } finally {
    clearTimeout(timer);
  }
}
