import { writeSnapshot } from "@openconditions/storage";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import {
  facilitiesRegistry,
  goldenFacilities,
  INSTANCE,
  landEvseReport,
  NOW,
  type SourceDrafts,
  STATION,
  TWIN,
  writeFacilities,
} from "./helpers/facilities.js";
import { seedHourly, siteKey, speedSeriesId, writeSiteReadings } from "./helpers/flow-series.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * The feature, offer and observation routes over the facilities golden
 * records, a fuel station two sources describe (one canonical feature, one
 * fused price), crowd reports on a charging site, and flow readings of
 * measurement sites.
 */
let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;
let golden: Map<string, SourceDrafts>;

type Rec = Record<string, unknown>;

/** The API's clock: after the facilities were fetched, before the on-demand prices lapse. */
const READ_AT = "2026-09-22T11:30:00.000Z";

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  app = Fastify();
  registerApiRoutes(app, sql, { registry: facilitiesRegistry, now: () => new Date(READ_AT) });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

async function reset(): Promise<void> {
  await sql`TRUNCATE conditions.feature, conditions.feature_canonical, conditions.feature_link,
    conditions.offer, conditions.observation_latest, conditions.observation,
    conditions.source, conditions.source_status, conditions.report_evidence CASCADE`;
  golden = await writeFacilities(sql);
}

async function get(url: string) {
  const res = await app.inject({ method: "GET", url });
  return { res, body: res.json() as Rec };
}

const ids = (body: Rec) => (body["records"] as Rec[]).map((r) => r["id"] as string);
const enc = encodeURIComponent;

/** Every id a walk over `path` (with `query`) returns, page by page. */
async function walk(path: string, query: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const { res, body }: { res: { statusCode: number }; body: Rec } = await get(
      `${path}?${query}&limit=${limit}${cursor ? `&cursor=${enc(cursor)}` : ""}`,
    );
    expect(res.statusCode).toBe(200);
    seen.push(...ids(body));
    cursor = body["next"] as string | null;
  } while (cursor !== null);
  return seen;
}

const allFeatureIds = () =>
  [...golden.values()].flatMap((d) => d.features.map((f) => f["id"] as string)).sort();

/** Copies of a golden car park of `source` with local ids `locals`. */
function carParks(source: string, locals: readonly string[], over: Rec = {}): Rec[] {
  const park = goldenFacilities().get("de-bw-parkapi")!.features[0]!;
  return locals.map((local, i) => ({
    ...park,
    id: `oc:feature:${source}:${local}`,
    location: {
      ...(park["location"] as Rec),
      geometry: { type: "Point", coordinates: [8.0 + i / 10, 49.0] },
    },
    provenance: { ...(park["provenance"] as Rec), sourceId: source, recordId: local },
    ...over,
  }));
}

async function writeParks(source: string, drafts: Rec[], now = NOW, license?: string) {
  const withLicense = license
    ? drafts.map((d) => ({
        ...d,
        provenance: {
          ...(d["provenance"] as Rec),
          attribution: { provider: source, license },
        },
      }))
    : drafts;
  const summary = await writeSnapshot(
    sql,
    source,
    { features: withLicense },
    { registry: facilitiesRegistry, instanceId: INSTANCE, now, complete: true },
  );
  expect(summary.rejected).toEqual([]);
}

describe("GET /features", () => {
  beforeAll(reset, 120_000);

  it("walks every live feature once, page by page, without components unless asked", async () => {
    expect((await walk("/features", "", 4)).sort()).toEqual(allFeatureIds());
    const { body } = await get(`/features?source=es-minetur`);
    expect((body["records"] as Rec[]).every((r) => r["components"] === undefined)).toBe(true);
    const expanded = await get(`/features?source=es-minetur&expand=components`);
    const station = (expanded.body["records"] as Rec[]).find((r) => r["id"] === STATION)!;
    expect((station["components"] as Rec[]).map((c) => c["key"])).toContain("e5");
  });

  it("filters by box, kind, type, domain, source and origin", async () => {
    const list = async (query: string) => ids((await get(`/features?${query}`)).body).sort();
    expect(await list("bbox=-4,40,-3,41")).toEqual(
      [STATION, TWIN, "oc:feature:es-minetur:15493"].sort(),
    );
    expect(await list("kind=charging_site")).toEqual([
      "oc:feature:de-bw-ocpdb:72555",
      "oc:feature:de-bw-ocpdb:72557",
    ]);
    expect(await list("source=it-mimit,at-econtrol")).toHaveLength(3);
    expect(await list("origin=crowd")).toEqual([]);
    expect(await list("domain=roads")).toEqual([]);
    expect(await list("kind=fuel_station&type=nothing")).toEqual([]);
  });

  it("serves the canonical view: one record per cluster, carrying its members", async () => {
    const canonical = await walk("/features", "canonical=1", 3);
    expect(canonical).toHaveLength(allFeatureIds().length - 1);
    expect(canonical.every((id) => id.startsWith(`oc:feature:${INSTANCE}:`))).toBe(true);
    const { body } = await get(
      `/features?canonical=1&bbox=-3.4815,40.528,-3.4805,40.5285&expand=components`,
    );
    const [station] = body["records"] as Rec[];
    expect(body["records"]).toHaveLength(1);
    const provenance = station!["provenance"] as Rec;
    expect(provenance["sourceId"]).toBe("es-fuel-test");
    expect(provenance["mergedSources"]).toEqual([
      expect.objectContaining({ source: "es-minetur", recordId: STATION, link: "same_asset" }),
    ]);
    expect(provenance["derivedFrom"]).toEqual({
      records: [
        { class: "feature", id: TWIN },
        { class: "feature", id: STATION },
      ],
      method: "canonical_view",
      version: "1",
    });
    const keys = (station!["components"] as Rec[]).map((c) => c["key"]);
    expect(keys).toEqual(expect.arrayContaining(["e5", "es-minetur/diesel", "es-minetur/lpg"]));
    expect(keys).not.toContain("es-minetur/e5");
  });

  it("withholds share-alike records, and a share-alike member's traces in the canonical view", async () => {
    await writeParks("de-sa", carParks("de-sa", ["p1"]), NOW, "ODbL-1.0");
    const { res, body } = await get("/features?kind=parking_site");
    expect(ids(body)).not.toContain("oc:feature:de-sa:p1");
    expect(res.headers["x-data-license"]).toBe("CC-BY-4.0, CC0-1.0");
    const canonical = await get("/features?canonical=1&kind=parking_site");
    expect(
      (canonical.body["records"] as Rec[]).some(
        (r) => (r["provenance"] as Rec)["sourceId"] === "de-sa",
      ),
    ).toBe(false);
    await writeParks("de-sa", [], NOW);
  });

  it("never returns a feature twice nor skips one that exists throughout a walk under writes", async () => {
    const locals = ["k0", "k1", "k2", "k3", "k4", "k5"];
    await writeParks("de-walk", carParks("de-walk", locals));
    const first = await get("/features?source=de-walk&limit=2");
    // Between pages: one withdrawn, one changed, two new ones.
    const kept = carParks("de-walk", locals).filter((f) => f["id"] !== "oc:feature:de-walk:k2");
    const changed = kept.map((f) =>
      f["id"] === "oc:feature:de-walk:k4" ? { ...f, lifecycle: "temporarily_closed" } : f,
    );
    await writeParks(
      "de-walk",
      [...changed, ...carParks("de-walk", ["k2b", "k9"])],
      "2026-09-22T12:01:00.000Z",
    );
    const seen = [...ids(first.body)];
    let cursor = first.body["next"] as string | null;
    while (cursor !== null) {
      const { body } = await get(`/features?source=de-walk&limit=2&cursor=${enc(cursor)}`);
      seen.push(...ids(body));
      cursor = body["next"] as string | null;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const local of ["k0", "k1", "k3", "k4", "k5"]) {
      expect(seen).toContain(`oc:feature:de-walk:${local}`);
    }
    await writeParks("de-walk", [], "2026-09-22T12:02:00.000Z");
  });

  it("refuses a malformed query", async () => {
    for (const query of [
      "limit=0",
      "limit=5001",
      "bbox=1,2,3",
      "canonical=2",
      "expand=all",
      "nope=1",
    ]) {
      expect((await get(`/features?${query}`)).res.statusCode, query).toBe(400);
    }
  });
});

describe("GET /features.geojson and .jsonld", () => {
  beforeAll(reset, 120_000);

  it("wraps each feature as a GeoJSON feature, components inline only when asked", async () => {
    const { res, body } = await get("/features.geojson?kind=charging_site&limit=1");
    expect(res.headers["content-type"]).toContain("application/geo+json");
    expect(body).toMatchObject({ type: "FeatureCollection", next: "oc:feature:de-bw-ocpdb:72555" });
    const [feature] = body["features"] as Rec[];
    expect(feature).toMatchObject({
      type: "Feature",
      id: "oc:feature:de-bw-ocpdb:72555",
      geometry: { type: "Point", coordinates: [7.522998, 51.608953] },
    });
    expect((feature!["properties"] as Rec)["components"]).toBeUndefined();
    const expanded = await get("/features.geojson?kind=charging_site&limit=1&expand=components");
    const props = (expanded.body["features"] as Rec[])[0]!["properties"] as Rec;
    expect(props["components"]).toHaveLength(4);
    const ld = await get("/features.jsonld?kind=charging_site&limit=1");
    expect(ld.res.headers["content-type"]).toContain("application/ld+json");
    expect(JSON.stringify(ld.body["@context"])).toContain("http://www.w3.org/ns/sosa/");
    expect((ld.body["features"] as Rec[])[0]).toMatchObject({
      "@id": `https://openconditions.org/id/${enc("oc:feature:de-bw-ocpdb:72555")}`,
      "@type": "schema:Place",
    });
  });
});

describe("GET /features/{id}", () => {
  beforeAll(reset, 120_000);

  it("serves one feature with its components and its canonical cluster", async () => {
    const { body } = await get(`/features/${enc(STATION)}`);
    expect((body["record"] as Rec)["id"]).toBe(STATION);
    expect(((body["record"] as Rec)["components"] as Rec[]).length).toBe(5);
    expect(body["canonical"]).toMatchObject({
      survivorId: TWIN,
      memberIds: [TWIN, STATION],
    });
    const canonicalId = (body["canonical"] as Rec)["canonicalFeatureId"] as string;
    const cluster = await get(`/features/${enc(canonicalId)}`);
    expect((cluster.body["record"] as Rec)["id"]).toBe(canonicalId);
    expect(cluster.body["canonical"]).toEqual(body["canonical"]);
    expect((await get(`/features/${enc("oc:feature:es-minetur:none")}`)).res.statusCode).toBe(404);
  });
});

describe("GET /offers and /offers/{id}", () => {
  beforeAll(reset, 120_000);

  it("walks the live offers and filters them", async () => {
    expect((await walk("/offers", "", 1)).sort()).toEqual([
      "oc:offer:de-bw-ocpdb:138586",
      "oc:offer:de-bw-ocpdb:138587",
    ]);
    expect(ids((await get("/offers?source=es-minetur")).body)).toEqual([]);
    expect(ids((await get("/offers?bbox=7.5,51.6,7.6,51.7")).body)).toHaveLength(2);
    expect(ids((await get("/offers?kind=energy_tariff")).body)).toHaveLength(2);
    expect((await get("/offers?canonical=1")).res.statusCode).toBe(400);
  });

  it("serves one offer, 404 for an unknown one", async () => {
    const { res, body } = await get(`/offers/${enc("oc:offer:de-bw-ocpdb:138586")}`);
    expect(res.headers["x-data-license"]).toBe("CC-BY-4.0");
    expect((body["record"] as Rec)["id"]).toBe("oc:offer:de-bw-ocpdb:138586");
    expect((await get(`/offers/${enc("oc:offer:de-bw-ocpdb:0")}`)).res.statusCode).toBe(404);
  });
});

describe("GET /observations/latest", () => {
  beforeAll(async () => {
    await reset();
    await writeSiteReadings(
      sql,
      "nl-ndw-flow",
      [
        { site: "s1", geometry: { type: "Point", coordinates: [4.5, 52.0] }, at: NOW, speed: 80 },
        { site: "s2", geometry: { type: "Point", coordinates: [4.6, 52.0] }, at: NOW, speed: 60 },
      ],
      NOW,
    );
  }, 120_000);

  const readings = () =>
    [...golden.values()].flatMap((d) => d.observations.map((o) => o["id"] as string));

  it("lists the reading in effect of every per-source series, never a fused row", async () => {
    const all = await walk("/observations/latest", "", 7);
    expect(all).toHaveLength(readings().length + 2);
    expect(all).toEqual(expect.arrayContaining(readings()));
    const { body } = await get("/observations/latest?property=traffic.speed");
    expect((body["records"] as Rec[]).map((r) => (r["result"] as Rec)["value"]).sort()).toEqual([
      60, 80,
    ]);
  });

  it("filters by property, box, source, origin and domain", async () => {
    const list = async (query: string) => ids((await get(`/observations/latest?${query}`)).body);
    expect(await list("property=fuel.price&source=es-fuel-test")).toHaveLength(1);
    expect(await list("bbox=4.4,51.9,4.55,52.1")).toHaveLength(1);
    expect(await list("domain=roads")).toHaveLength(2);
    expect(await list("origin=crowd")).toEqual([]);
    expect(
      (await get("/observations/latest?property=fuel.price,parking.available")).res.statusCode,
    ).toBe(200);
  });

  it("serves the canonical view: fused rows of fusable properties, per-source rows of the rest", async () => {
    const records = (await get("/observations/latest?canonical=1&limit=5000")).body[
      "records"
    ] as Rec[];
    const sources = new Set(records.map((r) => (r["provenance"] as Rec)["sourceId"]));
    expect([...sources].sort()).toEqual(["@fused", "nl-ndw-flow"]);
    const e5 = records.find(
      (r) =>
        r["property"] === "fuel.price" &&
        ((r["provenance"] as Rec)["mergedSources"] as Rec[]).length === 2,
    )!;
    expect((e5["provenance"] as Rec)["mergedSources"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "es-minetur" }),
        expect.objectContaining({ source: "es-fuel-test" }),
      ]),
    );
    expect(records.filter((r) => r["property"] === "traffic.speed")).toHaveLength(2);
  });

  it("strips a crowd reporter, and withholds a share-alike crowd reading", async () => {
    const site = golden.get("de-bw-ocpdb")!.features[0]!;
    const component = (site["components"] as Rec[]).find((c) => c["kind"] === "evse")!;
    const station = (await get(`/features/${enc(site["id"] as string)}`)).body;
    const canonicalId = (station["canonical"] as Rec)["canonicalFeatureId"] as string;
    const open = await landEvseReport(sql, {
      canonicalId,
      componentKey: component["key"] as string,
      location: site["location"] as Rec,
      nonce: "nonce-open-000001",
    });
    const { body } = await get("/observations/latest?origin=crowd");
    expect(ids(body)).toEqual([open]);
    const [crowd] = body["records"] as Rec[];
    expect((crowd!["provenance"] as Rec)["reporter"]).toBeUndefined();
    expect(crowd!["evidence"]).toMatchObject({ state: "self_reported" });
    await sql`DELETE FROM conditions.observation_latest WHERE source_id = 'crowd'`;
    await landEvseReport(sql, {
      canonicalId,
      componentKey: component["key"] as string,
      location: site["location"] as Rec,
      nonce: "nonce-sa-0000001",
      license: "ODbL-1.0",
    });
    expect(ids((await get("/observations/latest?origin=crowd")).body)).toEqual([]);
    await sql`DELETE FROM conditions.observation_latest WHERE source_id = 'crowd'`;
  });

  it("withholds a fused row whose winning source is share-alike", async () => {
    await sql`UPDATE conditions.observation_latest
                 SET template = jsonb_set(template, '{provenance,attribution,license}', '"CC-BY-SA-4.0"')
               WHERE source_id = '@fused' AND property = 'parking.occupied'`;
    const { body } = await get("/observations/latest?canonical=1&property=parking.occupied");
    expect(ids(body)).toEqual([]);
  });

  it("never returns a series twice nor skips one that exists throughout a walk under writes", async () => {
    const sites = (n: number, at: string, speed: number) =>
      Array.from({ length: n }, (_, i) => ({
        site: `w${i}`,
        geometry: { type: "Point" as const, coordinates: [5 + i / 100, 52] },
        at,
        speed,
      }));
    await writeSiteReadings(sql, "nl-walk-flow", sites(6, NOW, 50), NOW);
    const first = await get("/observations/latest?source=nl-walk-flow&limit=2");
    // Between pages every series moves to a newer reading and two sites join.
    const later = "2026-09-22T12:01:00.000Z";
    await writeSiteReadings(
      sql,
      "nl-walk-flow",
      [
        ...sites(6, later, 70),
        ...["n1", "n2"].map((site) => ({
          site,
          geometry: { type: "Point" as const, coordinates: [5.5, 52] },
          at: later,
          speed: 30,
        })),
      ],
      later,
    );
    const subjects = (records: Rec[]) =>
      records.map((r) => ((r["subject"] as Rec)["featureId"] as string).split(":").at(-1)!);
    const seen = subjects(first.body["records"] as Rec[]);
    let cursor = first.body["next"] as string | null;
    while (cursor !== null) {
      const { body } = await get(
        `/observations/latest?source=nl-walk-flow&limit=2&cursor=${enc(cursor)}`,
      );
      seen.push(...subjects(body["records"] as Rec[]));
      cursor = body["next"] as string | null;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (let i = 0; i < 6; i++) expect(seen).toContain(`w${i}`);
  });

  it("refuses a malformed query", async () => {
    for (const query of ["limit=0", "cursor=abc", "canonical=yes", "kind=observation"]) {
      expect((await get(`/observations/latest?${query}`)).res.statusCode, query).toBe(400);
    }
  });
});

describe("GET /observations (one series)", () => {
  const site = siteKey("nl-ndw-flow", "h1");
  const T0 = "2026-09-22T11:00:00.000Z";
  const T1 = "2026-09-22T11:30:00.000Z";

  beforeAll(async () => {
    await reset();
    for (const [at, speed] of [
      [T0, 70],
      [T1, 90],
    ] as const) {
      await writeSiteReadings(
        sql,
        "nl-ndw-flow",
        [{ site: "h1", geometry: { type: "Point", coordinates: [4.5, 52.0] }, at, speed }],
        at,
      );
    }
    const series = await speedSeriesId(sql, site);
    // Rolled-up hours from before the raw retention (3 days for speeds).
    await seedHourly(sql, series, "2026-09-10T08:00:00.000Z", [30, 40], [3, 1]);
    await seedHourly(sql, series, "2026-09-10T09:00:00.000Z", [35], [2]);
  }, 120_000);

  const url = (query: string) =>
    `/observations?subject=${enc(site)}&property=traffic.speed&${query}`;

  it("reads raw readings within the property's retention, oldest first", async () => {
    const { res, body } = await get(url(`from=2026-09-22T00:00:00Z&to=2026-09-22T12:00:00Z`));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-data-license"]).toBe("CC0-1.0");
    expect(body).toMatchObject({
      series: { subjectKey: site, property: "traffic.speed", sourceId: "nl-ndw-flow" },
      resolution: "raw",
      next: null,
    });
    expect((body["records"] as Rec[]).map((r) => (r["result"] as Rec)["value"])).toEqual([70, 90]);
  });

  it("pages raw readings by their instant", async () => {
    const first = await get(url("from=2026-09-22T00:00:00Z&to=2026-09-22T12:00:00Z&limit=1"));
    expect((first.body["records"] as Rec[]).map((r) => (r["result"] as Rec)["value"])).toEqual([
      70,
    ]);
    const second = await get(
      url(
        `from=2026-09-22T00:00:00Z&to=2026-09-22T12:00:00Z&limit=1&cursor=${enc(first.body["next"] as string)}`,
      ),
    );
    expect((second.body["records"] as Rec[]).map((r) => (r["result"] as Rec)["value"])).toEqual([
      90,
    ]);
    expect(second.body["next"]).toBeNull();
  });

  it("reads hourly rollups beyond the retention, or when asked", async () => {
    const { body } = await get(url("from=2026-09-10T00:00:00Z&to=2026-09-11T00:00:00Z"));
    expect(body["resolution"]).toBe("hourly");
    expect(body["records"]).toBeUndefined();
    expect(body["rollups"]).toEqual([
      {
        start: "2026-09-10T08:00:00.000Z",
        end: "2026-09-10T09:00:00.000Z",
        sampleCount: 4,
        min: 60,
        max: 82,
        mean: expect.any(Number),
        unit: "km/h",
        histogram: { binWidth: 2, bins: [30, 40], counts: [3, 1] },
      },
      expect.objectContaining({ start: "2026-09-10T09:00:00.000Z", sampleCount: 2 }),
    ]);
    const asked = await get(
      url("from=2026-09-22T00:00:00Z&to=2026-09-22T12:00:00Z&resolution=hourly"),
    );
    expect(asked.body["rollups"]).toEqual([]);
  });

  it("answers 404 for no series, 400 for a rollup the property does not keep or several sources", async () => {
    expect((await get(url("resolution=daily"))).res.statusCode).toBe(400);
    expect(
      (
        await get(
          `/observations?subject=${enc(siteKey("nl-ndw-flow", "none"))}&property=traffic.speed`,
        )
      ).res.statusCode,
    ).toBe(404);
    expect((await get("/observations?property=traffic.speed")).res.statusCode).toBe(400);
    expect(
      (await get(url("from=2026-09-22T12:00:00Z&to=2026-09-22T00:00:00Z"))).res.statusCode,
    ).toBe(400);
  });

  it("names a series by a record id and a component too", async () => {
    const byId = await get(
      `/observations?subject=${enc(STATION)}&component=e5&property=fuel.price&from=2026-09-01T00:00:00Z&to=2026-09-23T00:00:00Z`,
    );
    expect(byId.res.statusCode).toBe(200);
    expect(byId.body["series"]).toMatchObject({
      subjectKey: `feature:${STATION}#e5`,
      sourceId: "es-minetur",
    });
  });
});

describe("GET /coverage", () => {
  beforeAll(reset, 120_000);

  it("counts live readings per property, with the country of their source", async () => {
    const coverage = (await get("/coverage")).body["coverage"] as Rec[];
    const prices = coverage.filter(
      (c) => c["class"] === "observation" && c["property"] === "fuel.price",
    );
    expect(prices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          country: "ES",
          kind: "observation",
          property: "fuel.price",
          accessMode: "bulk",
          records: 8,
          sources: ["es-fuel-test", "es-minetur"],
        }),
        expect.objectContaining({ country: "AT", accessMode: "on_demand", records: 2 }),
      ]),
    );
    expect(coverage.some((c) => (c["sources"] as string[]).includes("@fused"))).toBe(false);
  });
});
