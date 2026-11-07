import { expect, test, vi } from "vitest";
import { fetchEndpoint as baseFetchEndpoint, createFetchState } from "../fetch.js";
import { geofaDigest } from "../geofa.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const fetchEndpoint = (...args: Parameters<typeof baseFetchEndpoint>) =>
  baseFetchEndpoint(args[0], args[1], args[2], args[3] ?? { state: createFetchState() });

test("GeoFA refuses unqualified acquisition before any provider traffic", async () => {
  const fetcher = vi.fn();
  const feed = catalogFeed({
    format: "geofa",
    endpoints: { main: { url: "https://example.org/wfs", cadenceSec: 86400, geofa: {} } },
  });
  await expect(fetchEndpoint(feed, "main", fetcher)).rejects.toThrow(/qualification/);
  expect(fetcher).not.toHaveBeenCalled();
});

test("GeoFA content identity ignores page and object-key order but includes versions", () => {
  const a = { properties: { objekt_id: "a", versions_id: "v1" }, geometry: null };
  const b = { geometry: null, properties: { versions_id: "v2", objekt_id: "b" } };
  expect(geofaDigest([a, b])).toBe(geofaDigest([b, a]));
  expect(geofaDigest([a])).not.toBe(
    geofaDigest([{ ...a, properties: { ...a.properties, versions_id: "v2" } }]),
  );
});

const url =
  "https://example.org/wfs?typeNames=fkg%3Afkg.t_5607_ladefacilitet&sortBy=objekt_id&srsName=EPSG%3A4326";
const rows = Array.from({ length: 501 }, (_, i) => ({
  type: "Feature",
  properties: { objekt_id: String(i).padStart(4, "0"), versions_id: "v1" },
  geometry: null,
}));
const qualified = (data: unknown[] = rows) =>
  catalogFeed({
    format: "geofa",
    endpoints: {
      main: {
        url,
        cadenceSec: 86400,
        geofa: { qualification: { count: data.length, sha256: geofaDigest(data) } },
      },
    },
  });
const response = (features: unknown[]) =>
  new Response(JSON.stringify({ type: "FeatureCollection", features }));
test("GeoFA assembles a qualified publication through sorted bounded offsets", async () => {
  const asked: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return response(asked.length === 1 ? rows.slice(0, 500) : rows.slice(500));
  }) as typeof fetch;
  const result = await fetchEndpoint(qualified(), "main", f);
  expect(result.status).toBe("fetched");
  if (result.status !== "fetched") throw new Error("not fetched");
  expect(result.buffers).toHaveLength(2);
  expect(asked.map((u) => new URL(u).searchParams.get("startIndex"))).toEqual(["0", "500"]);
});
test.each(["failed-later", "server-cap", "repeat", "generation", "empty"])(
  "GeoFA rejects %s without releasing a partial publication",
  async (mode) => {
    let calls = 0;
    const f = (async () => {
      calls++;
      if (mode === "server-cap") return response(rows.slice(0, 2));
      if (mode === "empty") return response([]);
      if (calls === 1 || mode === "repeat") return response(rows.slice(0, 500));
      if (mode === "failed-later") return new Response("busy", { status: 503 });
      return response([{ ...rows[500], properties: { objekt_id: "0500", versions_id: "v2" } }]);
    }) as typeof fetch;
    await expect(fetchEndpoint(qualified(), "main", f)).rejects.toThrow(/GeoFA/);
  },
);
test("GeoFA permits only an explicitly qualified empty generation", async () => {
  const result = await fetchEndpoint(qualified([]), "main", (async () =>
    response([])) as typeof fetch);
  expect(result.status).toBe("fetched");
  if (result.status !== "fetched") throw new Error("not fetched");
  expect(result.buffers).toHaveLength(1);
});

test("GeoFA refuses a changed response CRS despite an identical feature digest", async () => {
  const result = JSON.stringify({
    type: "FeatureCollection",
    crs: { properties: { name: "EPSG:25832" } },
    features: [],
  });
  await expect(
    fetchEndpoint(qualified([]), "main", (async () => new Response(result)) as typeof fetch),
  ).rejects.toThrow(/CRS/);
});

test("GeoFA backs off a failed qualified generation for a day without provider traffic", async () => {
  const state = createFetchState();
  const fetcher = vi.fn(async () => new Response("busy", { status: 503 }));
  await expect(fetchEndpoint(qualified(), "main", fetcher, { state, at: 0 })).rejects.toThrow(
    /HTTP 503/,
  );
  await expect(fetchEndpoint(qualified(), "main", fetcher, { state, at: 3600000 })).rejects.toThrow(
    /backoff/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    fetchEndpoint(qualified(), "main", fetcher, { state, at: 86400000 }),
  ).rejects.toThrow(/HTTP 503/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
