import { observationId } from "@openconditions/model";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
  writeSnapshot,
} from "@openconditions/storage";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { registry, writeSituations } from "./helpers/situations.js";

/**
 * The reads a hazards map makes: earthquakes of the last week by time
 * window, fire perimeters by subtype and simplified for drawing, the last
 * hours' fire pixels and their density cells, in public and operator scope.
 */
let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;

type Rec = Record<string, unknown>;

const NOW = "2026-10-08T12:00:00.000Z";
const TOKEN = "operator-token-of-the-hazard-reads-suite-0123";
const OPERATOR = { authorization: `Bearer ${TOKEN}` };
const QUAKES = "usgs-quakes";
const FIRES = "us-nifc-fires";
const PIXELS = "nasa-firms-viirs-fires";
const RESTRICTED_PIXELS = "xx-restricted-fires";

const hoursBefore = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const daysBefore = (d: number) => hoursBefore(d * 24);

const provenance = (sourceId: string, format: string, recordId: string) => ({
  origin: "feed",
  sourceId,
  sourceFormat: format,
  accessMode: "bulk",
  recordId,
  attribution: { provider: sourceId, license: "CC0-1.0" },
  privacy: { class: "authoritative" },
});

function hazard(
  source: string,
  format: string,
  local: string,
  type: string,
  geometry: Rec,
  validity: Rec,
  subtype?: string,
): Rec {
  return {
    id: `oc:situation:${source}:${local}`,
    class: "situation",
    kind: "natural_hazard",
    type,
    ...(subtype === undefined ? {} : { subtype }),
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "unknown" },
    validity,
    effects: [],
    details: { kind: "natural_hazard", v: 1 },
    location: {
      geometry,
      extent: geometry["type"] === "Point" ? "point" : "area",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
    provenance: provenance(source, format, local),
    freshness: { fetchedAt: NOW },
  };
}

const quake = (local: string, at: string, status = "ended") =>
  hazard(
    QUAKES,
    "usgs",
    local,
    "earthquake",
    { type: "Point", coordinates: [-117.5, 35.7] },
    status === "ended" ? { status, start: at, end: at } : { status, start: at },
  );

/** A ring of `n` positions around `[lon, lat]`, wobbling so no position is redundant. */
function ring(lon: number, lat: number, radius: number, n: number): number[][] {
  const positions = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const r = radius * (1 + 0.002 * Math.sin(17 * a));
    return [lon + r * Math.cos(a), lat + r * Math.sin(a)];
  });
  return [...positions, positions[0]!];
}

const PERIMETER = { type: "Polygon", coordinates: [ring(-120, 38, 0.2, 400)] };

function pixel(source: string, lon: number, lat: number, at: string, frp: number): Rec {
  const draft: Rec = {
    class: "observation",
    kind: "observation",
    property: "fire.frp",
    subject: { kind: "location" },
    result: { type: "quantity", value: frp, unit: "MW" },
    phenomenonTime: { instant: at },
    aggregation: "instantaneous",
    temporality: "live",
    location: {
      geometry: { type: "Point", coordinates: [lon, lat] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "medium_res",
    },
    provenance: provenance(source, "firms", `N21:${lat},${lon}:${at}`),
    freshness: {
      fetchedAt: NOW,
      expiresAt: new Date(Date.parse(at) + 72 * 3_600_000).toISOString(),
    },
  };
  draft["id"] = observationId(source, draft as Parameters<typeof observationId>[1]);
  return draft;
}

/** Readings of the last hours count from here. */
const SINCE = hoursBefore(6);

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date(NOW),
  });
  const source = (id: string, format: string, product: string, restricted: boolean) => ({
    id,
    domain: "hazards",
    format,
    product,
    tier: "authoritative",
    country: "US",
    operator: id,
    license: "CC0-1.0",
    attribution: id,
    restricted,
    cadenceSec: 600,
    freshnessWindowSec: 3600,
  });
  await syncSources(sql, [
    source(QUAKES, "usgs", "quakes", false),
    source(FIRES, "wfigs", "fires", false),
    source(PIXELS, "firms", "fires", false),
    source(RESTRICTED_PIXELS, "firms", "fires", true),
  ]);
  await writeSituations(
    sql,
    QUAKES,
    [
      quake("q3", daysBefore(3)),
      quake("q10", daysBefore(10)),
      quake("qx", daysBefore(2), "cancelled"),
    ],
    NOW,
  );
  await writeSituations(
    sql,
    FIRES,
    [
      hazard(
        FIRES,
        "wfigs",
        "perimeter",
        "wildfire",
        PERIMETER,
        { status: "active", start: daysBefore(4) },
        "wildfire_perimeter",
      ),
      hazard(
        FIRES,
        "wfigs",
        "burn",
        "wildfire",
        { type: "Polygon", coordinates: [ring(-119, 37, 0.05, 8)] },
        { status: "active", start: daysBefore(1) },
        "prescribed_burn",
      ),
    ],
    NOW,
  );
  const write = (sourceId: string, observations: Rec[]) =>
    writeSnapshot(
      sql,
      sourceId,
      { observations },
      { registry, instanceId: "test.local", now: NOW, complete: true },
    );
  await write(PIXELS, [
    pixel(PIXELS, 10.3, 45.3, hoursBefore(7), 99),
    pixel(PIXELS, 10.2, 45.3, hoursBefore(5), 10),
    pixel(PIXELS, 10.5, 45.6, hoursBefore(4), 20),
    pixel(PIXELS, 10.8, 45.9, hoursBefore(3), 30),
    pixel(PIXELS, 12.1, 47.2, hoursBefore(2), 5),
  ]);
  await write(RESTRICTED_PIXELS, [pixel(RESTRICTED_PIXELS, 10.4, 45.4, hoursBefore(2), 40)]);
  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, { registry, now: () => new Date(NOW) });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "GET", url, headers });
  return { res, body: res.json() as Rec };
}

const ids = (body: Rec) => (body["records"] as Rec[]).map((r) => r["id"]);
const quakeId = (local: string) => `oc:situation:${QUAKES}:${local}`;

describe("GET /situations in a time window", () => {
  it("lists an ended earthquake of the window, which the current read does not, and never a cancelled one", async () => {
    const window = await get(`/situations?domain=hazards&from=${daysBefore(7)}&to=${NOW}&limit=50`);
    expect(window.res.statusCode).toBe(200);
    expect(ids(window.body)).toContain(quakeId("q3"));
    expect(ids(window.body)).not.toContain(quakeId("q10"));
    expect(ids(window.body)).not.toContain(quakeId("qx"));
    // `to` defaults to now.
    expect(ids((await get(`/situations?domain=hazards&from=${daysBefore(7)}`)).body)).toEqual(
      ids(window.body),
    );
    const current = ids((await get("/situations?domain=hazards")).body);
    expect(current).not.toContain(quakeId("q3"));
    expect(current).not.toContain(quakeId("qx"));
  });

  it("refuses a window with at or horizonDays, reversed, over 400 days, or a to without from", async () => {
    for (const query of [
      `from=${daysBefore(7)}&at=${NOW}`,
      `from=${daysBefore(7)}&horizonDays=3`,
      `from=${NOW}&to=${daysBefore(1)}`,
      `from=${daysBefore(401)}&to=${NOW}`,
      `from=${daysBefore(401)}`,
      `to=${NOW}`,
    ]) {
      expect((await get(`/situations?${query}`)).res.statusCode, query).toBe(400);
    }
    expect((await get(`/situations?from=${daysBefore(400)}`)).res.statusCode).toBe(200);
  });
});

describe("GET /situations by subtype, simplified", () => {
  it("filters by subtype", async () => {
    expect(ids((await get("/situations?subtype=wildfire_perimeter")).body)).toEqual([
      `oc:situation:${FIRES}:perimeter`,
    ]);
    expect(ids((await get("/situations?subtype=prescribed_burn,burned_area")).body)).toEqual([
      `oc:situation:${FIRES}:burn`,
    ]);
  });

  it("simplify thins a perimeter's positions and keeps its envelope", async () => {
    const [record] = (await get("/situations?subtype=wildfire_perimeter&simplify=0.01")).body[
      "records"
    ] as Rec[];
    const geometry = (record!["location"] as Rec)["geometry"] as {
      type: string;
      coordinates: number[][][];
    };
    expect(geometry.type).toBe("Polygon");
    const positions = geometry.coordinates[0]!;
    expect(positions.length).toBeLessThan(PERIMETER.coordinates[0]!.length);
    expect(positions.length).toBeGreaterThanOrEqual(4);
    const envelope = (ps: number[][]) => [
      Math.min(...ps.map((p) => p[0]!)),
      Math.min(...ps.map((p) => p[1]!)),
      Math.max(...ps.map((p) => p[0]!)),
      Math.max(...ps.map((p) => p[1]!)),
    ];
    const original = envelope(PERIMETER.coordinates[0]!);
    envelope(positions).forEach((v, i) => {
      expect(Math.abs(v - original[i]!)).toBeLessThanOrEqual(0.01);
    });
    // Six decimals at most.
    for (const [lon, lat] of positions) {
      expect(Math.round(lon! * 1e6) / 1e6).toBe(lon);
      expect(Math.round(lat! * 1e6) / 1e6).toBe(lat);
    }
    expect((await get("/situations?simplify=0")).res.statusCode).toBe(400);
    expect((await get("/situations?simplify=1.5")).res.statusCode).toBe(400);
  });
});

describe("GET /observations/latest since an instant", () => {
  it("drops readings in effect before since", async () => {
    const all = (await get(`/observations/latest?property=fire.frp`)).body["records"] as Rec[];
    const since = (await get(`/observations/latest?property=fire.frp&since=${SINCE}`)).body[
      "records"
    ] as Rec[];
    const instants = (records: Rec[]) =>
      records.map((r) => (r["phenomenonTime"] as Rec)["instant"] as string).sort();
    expect(instants(all)).toContain(hoursBefore(7));
    expect(instants(since)).toEqual(
      [hoursBefore(5), hoursBefore(4), hoursBefore(3), hoursBefore(2)].sort(),
    );
  });
});

describe("GET /observations/grid", () => {
  const url = `/observations/grid?property=fire.frp&bbox=-10,30,30,60&cellDeg=1&since=${SINCE}`;

  it("sums the readings of each cell since an instant, public sources only in public scope", async () => {
    const { res, body } = await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(body).toEqual({
      cells: [
        [10.5, 45.5, 3, 60, 30],
        [12.5, 47.5, 1, 5, 5],
      ],
      sources: [PIXELS],
    });
  });

  it("counts a restricted source's readings for the operator", async () => {
    const { body } = await get(url, OPERATOR);
    expect(body).toEqual({
      cells: [
        [10.5, 45.5, 4, 100, 40],
        [12.5, 47.5, 1, 5, 5],
      ],
      sources: [PIXELS, RESTRICTED_PIXELS],
    });
  });

  it("refuses a box of more than 50,000 cells and a query without its required fields", async () => {
    const world = `/observations/grid?property=fire.frp&bbox=-180,-90,180,90&cellDeg=0.05&since=${SINCE}`;
    expect((await get(world)).res.statusCode).toBe(400);
    expect(
      (
        await get(
          `/observations/grid?property=fire.frp&bbox=-180,-90,180,90&cellDeg=2&since=${SINCE}`,
        )
      ).res.statusCode,
    ).toBe(200);
    expect((await get("/observations/grid?property=fire.frp&cellDeg=1")).res.statusCode).toBe(400);
    expect(
      (
        await get(
          `/observations/grid?property=fire.frp&bbox=-10,30,30,60&cellDeg=0.01&since=${SINCE}`,
        )
      ).res.statusCode,
    ).toBe(400);
  });
});
