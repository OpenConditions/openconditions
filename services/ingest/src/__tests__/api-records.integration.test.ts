import { listCanonicalFeatures } from "@openconditions/core";
import { observationId } from "@openconditions/model";
import { refreshFused, writeSnapshot } from "@openconditions/storage";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import {
  facilitiesRegistry,
  goldenFacilities,
  INSTANCE,
  landEvseReport,
  landPlacePriceReport,
  NOW,
  type SourceDrafts,
  STATION,
  TWIN,
  writeFacilities,
} from "./helpers/facilities.js";
import { seedHourly, siteKey, speedSeriesId, writeSiteReadings } from "./helpers/flow-series.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { situationDraft, writeSituations } from "./helpers/situations.js";

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

/**
 * The API's clock: after the facilities were fetched (11:10), before the
 * on-demand prices lapse (E-Control's 15 minutes later).
 */
const READ_AT = "2026-09-22T11:20:00.000Z";

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

/**
 * E-Control and Autobahn GmbH publish no licence (NOASSERTION), so the public
 * scope withholds their records.
 */
const UNLICENSED = ["at-econtrol-fuel", "de-autobahn-events"];

/** The golden sources the public scope serves. */
const publicGolden = () =>
  [...golden.entries()]
    .filter(([source]) => !UNLICENSED.includes(source))
    .map(([, drafts]) => drafts);

const publicFeatureIds = () =>
  publicGolden()
    .flatMap((d) => d.features.map((f) => f["id"] as string))
    .sort();

/** Copies of a golden car park of `source` with local ids `locals`. */
function carParks(source: string, locals: readonly string[], over: Rec = {}): Rec[] {
  const park = goldenFacilities().get("de-bw-mobidata-parking")!.features[0]!;
  return locals.map((local, i) => ({
    ...park,
    id: `oc:feature:${source}:${local}`,
    externalIds: [{ scheme: "provider", id: local, authority: source }],
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
    expect((await walk("/features", "", 4)).sort()).toEqual(publicFeatureIds());
    const { body } = await get(`/features?source=es-minetur-fuel`);
    expect((body["records"] as Rec[]).every((r) => r["components"] === undefined)).toBe(true);
    const expanded = await get(`/features?source=es-minetur-fuel&expand=components`);
    const station = (expanded.body["records"] as Rec[]).find((r) => r["id"] === STATION)!;
    expect((station["components"] as Rec[]).map((c) => c["key"])).toContain("e5");
  });

  it("filters by box, kind, type, domain, source and origin", async () => {
    const list = async (query: string) => ids((await get(`/features?${query}`)).body).sort();
    expect(await list("bbox=-4,40,-3,41")).toEqual(
      [STATION, TWIN, "oc:feature:es-minetur-fuel:15493"].sort(),
    );
    expect(await list("kind=charging_site")).toEqual([
      "oc:feature:de-bw-ocpdb:72555",
      "oc:feature:de-bw-ocpdb:72557",
    ]);
    expect(await list("source=it-mimit,es-minetur-fuel")).toHaveLength(3);
    expect(await list(`source=${UNLICENSED.join(",")}`)).toEqual([]);
    expect(await list("origin=crowd")).toEqual([]);
    expect(await list("domain=roads")).toEqual([]);
    expect(await list("kind=fuel_station&type=nothing")).toEqual([]);
  });

  it("finds the canonical clusters of a box through the spatial index, not a scan of every cluster", async () => {
    const plans: string[] = [];
    const explaining = {
      execute: async <T>(query: string, params?: unknown[]): Promise<T> => {
        await sql.begin(async (tx) => {
          // Rule out the scan the planner prefers on a table this small, so
          // the plan shows whether an index path exists at all.
          await tx`SET LOCAL enable_seqscan = off`;
          const rows = await tx.unsafe(`EXPLAIN ${query}`, params as never);
          plans.push(rows.map((r) => r["QUERY PLAN"]).join("\n"));
        });
        return [] as T;
      },
    };
    await listCanonicalFeatures(explaining, {
      scope: "public",
      bbox: [-4, 40, -3, 41],
      limit: 10,
    });
    // The box picks the features, and each one's cluster is looked up by
    // member: no walk over every cluster in id order.
    expect(plans[0]).toMatch(/idx_feature_geom/);
    expect(plans[0]).toMatch(/idx_feature_canonical_members/);
  });

  it("serves the canonical view: one record per cluster, carrying its members", async () => {
    const canonical = await walk("/features", "canonical=1", 3);
    expect(canonical).toHaveLength(publicFeatureIds().length - 1);
    expect(canonical.every((id) => id.startsWith(`oc:feature:${INSTANCE}:`))).toBe(true);
    const { body } = await get(
      `/features?canonical=1&bbox=-3.4815,40.528,-3.4805,40.5285&expand=components`,
    );
    const [station] = body["records"] as Rec[];
    expect(body["records"]).toHaveLength(1);
    const provenance = station!["provenance"] as Rec;
    expect(provenance["sourceId"]).toBe("es-fuel-test");
    expect(provenance["mergedSources"]).toEqual([
      expect.objectContaining({ source: "es-minetur-fuel", recordId: STATION, link: "same_asset" }),
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
    expect(keys).toEqual(
      expect.arrayContaining(["e5", "es-minetur-fuel/diesel", "es-minetur-fuel/lpg"]),
    );
    expect(keys).not.toContain("es-minetur-fuel/e5");
  });

  it("withholds share-alike records, and a share-alike member's traces in the canonical view", async () => {
    await writeParks("de-sa", carParks("de-sa", ["p1"]), NOW, "ODbL-1.0");
    const { res, body } = await get("/features?kind=parking_site");
    expect(ids(body)).not.toContain("oc:feature:de-sa:p1");
    expect(res.headers["x-data-license"]).toBe("CC0-1.0, DL-DE-BY-2.0");
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

describe("GET /features with expand=latest and offers", () => {
  const TOKEN = "operator-token-of-the-expand-suite-0123456789";
  let scoped: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await reset();
    scoped = Fastify();
    registerScope(scoped, TOKEN);
    registerApiRoutes(scoped, sql, { registry: facilitiesRegistry, now: () => new Date(READ_AT) });
    await scoped.ready();
  }, 120_000);

  afterAll(async () => {
    await scoped?.close();
  });

  const as = async (url: string, operator: boolean) => {
    const res = await scoped.inject({
      method: "GET",
      url,
      ...(operator ? { headers: { authorization: `Bearer ${TOKEN}` } } : {}),
    });
    return { res, body: res.json() as Rec };
  };
  const latestOf = (body: Rec, id: string) => (body["latest"] as Record<string, Rec[]>)[id]!;
  const byKey = (readings: Rec[]) =>
    Object.fromEntries(readings.map((r) => [(r["componentKey"] as string | undefined) ?? "", r]));
  const STATION_BOX = "bbox=-3.4815,40.528,-3.4805,40.5285";

  it("expand=latest returns each feature's latest readings, component keys included", async () => {
    const { res, body } = await get("/features?source=es-minetur-fuel&expand=latest");
    expect(res.statusCode).toBe(200);
    expect(body["offers"]).toBeUndefined();
    expect((body["records"] as Rec[]).every((r) => r["components"] === undefined)).toBe(true);
    expect(Object.keys(body["latest"] as Rec).sort()).toEqual(ids(body).sort());
    const station = byKey(latestOf(body, STATION));
    expect(Object.keys(station).sort()).toEqual(["diesel", "e5", "hvo100", "lpg", "sp98"]);
    const e5 = golden
      .get("es-minetur-fuel")!
      .observations.find(
        (o) =>
          (o["subject"] as Rec)["featureId"] === STATION &&
          (o["subject"] as Rec)["componentKey"] === "e5",
      )!;
    expect(station["e5"]).toEqual({
      property: "fuel.price",
      componentKey: "e5",
      result: e5["result"],
      phenomenonTime: e5["phenomenonTime"],
      source: "es-minetur-fuel",
    });
    const both = await get("/features?source=es-minetur-fuel&expand=components,latest");
    expect((both.body["records"] as Rec[])[0]!["components"]).toBeDefined();
  });

  it("in canonical mode a fused reading stands in for its members' readings", async () => {
    const { body } = await get(`/features?canonical=1&${STATION_BOX}&expand=latest,components`);
    const [station] = body["records"] as Rec[];
    const readings = latestOf(body, station!["id"] as string);
    const keys = (station!["components"] as Rec[]).map((c) => c["key"] as string);
    // One reading per canonical component, keyed as the canonical record keys it.
    expect(readings.map((r) => r["componentKey"]).sort()).toEqual([...keys].sort());
    expect(new Set(readings.map((r) => r["source"]))).toEqual(new Set(["@fused"]));
    expect(byKey(readings)["es-minetur-fuel/diesel"]).toMatchObject({ property: "fuel.price" });
  });

  it("expand=offers returns the live offers of a feature and its components", async () => {
    const { body } = await get("/features?kind=charging_site&expand=offers");
    const offers = body["offers"] as Record<string, Rec[]>;
    expect(offers["oc:feature:de-bw-ocpdb:72555"]!.map((o) => o["id"]).sort()).toEqual([
      "oc:offer:de-bw-ocpdb:138586",
      "oc:offer:de-bw-ocpdb:138587",
    ]);
    expect(offers["oc:feature:de-bw-ocpdb:72557"]).toEqual([]);
    expect(body["latest"]).toBeUndefined();
    const canonical = await get("/features?canonical=1&kind=charging_site&expand=offers");
    const counts = Object.values(canonical.body["offers"] as Record<string, Rec[]>)
      .map((o) => o.length)
      .sort();
    expect(counts).toEqual([0, 2]);
  });

  it("expand honours public scope for readings and offers", async () => {
    await sql`UPDATE conditions.source SET restricted = true WHERE id = 'es-fuel-test'`;
    await sql`UPDATE conditions.offer
                 SET record = jsonb_set(record, '{provenance,attribution,license}', '"ODbL-1.0"')
               WHERE id = 'oc:offer:de-bw-ocpdb:138586'`;
    try {
      const url = `/features?canonical=1&${STATION_BOX}&expand=latest`;
      const shown = await as(url, false);
      const [station] = shown.body["records"] as Rec[];
      const readings = latestOf(shown.body, station!["id"] as string);
      // The fused E5 price has a restricted contributor: the public member's own reading stands.
      expect(byKey(readings)["e5"]).toMatchObject({ source: "es-minetur-fuel" });
      expect(readings.some((r) => r["source"] === "es-fuel-test")).toBe(false);
      // A fused reading served in public scope names public contributors only.
      const fused = readings.filter((r) => r["source"] === "@fused");
      expect(fused.length).toBeGreaterThan(0);
      for (const r of fused) expect(r["contributors"]).toEqual(["es-minetur-fuel"]);
      const operator = await as(url, true);
      const [all] = operator.body["records"] as Rec[];
      expect(byKey(latestOf(operator.body, all!["id"] as string))["e5"]).toMatchObject({
        source: "@fused",
        contributors: expect.arrayContaining(["es-minetur-fuel", "es-fuel-test"]),
      });

      const offersUrl = "/features?kind=charging_site&expand=offers";
      const offersOf = (body: Rec) =>
        (body["offers"] as Record<string, Rec[]>)["oc:feature:de-bw-ocpdb:72555"]!.map(
          (o) => o["id"],
        );
      const publicOffers = await as(offersUrl, false);
      expect(offersOf(publicOffers.body)).toEqual(["oc:offer:de-bw-ocpdb:138587"]);
      expect(publicOffers.res.headers["x-data-license"]).not.toContain("ODbL-1.0");
      expect(offersOf((await as(offersUrl, true)).body)).toHaveLength(2);
    } finally {
      await sql`UPDATE conditions.source SET restricted = false WHERE id = 'es-fuel-test'`;
      await sql`UPDATE conditions.offer
                   SET record = jsonb_set(record, '{provenance,attribution,license}', '"CC-BY-4.0"')
                 WHERE id = 'oc:offer:de-bw-ocpdb:138586'`;
    }
  });

  it("public latest readings serve the public fusion, operator the full one", async () => {
    const [cluster] = await sql<{ canonical_feature_id: string }[]>`
      SELECT canonical_feature_id FROM conditions.feature_canonical
       WHERE ${STATION} = ANY(member_ids)`;
    const canonical = cluster!.canonical_feature_id;
    const refresh = () =>
      sql.begin((tx) =>
        refreshFused(tx, facilitiesRegistry, [{ featureId: canonical }], {
          instanceId: INSTANCE,
          now: READ_AT,
        }),
      );
    await sql`UPDATE conditions.source SET restricted = true WHERE id = 'es-fuel-test'`;
    await refresh();
    try {
      const url = `/features?canonical=1&${STATION_BOX}&expand=latest`;
      const shown = await as(url, false);
      const e5 = byKey(latestOf(shown.body, canonical))["e5"];
      expect(e5).toMatchObject({ source: "@fused-public", contributors: ["es-minetur-fuel"] });
      const operator = await as(url, true);
      expect(byKey(latestOf(operator.body, canonical))["e5"]).toMatchObject({
        source: "@fused",
        contributors: expect.arrayContaining(["es-minetur-fuel", "es-fuel-test"]),
      });
      expect(JSON.stringify(operator.body)).not.toContain("@fused-public");

      const fusedE5 = async (operator: boolean) =>
        (
          (await as("/observations/latest?canonical=1&property=fuel.price&limit=5000", operator))
            .body["records"] as Rec[]
        ).filter(
          (r) =>
            (r["subject"] as Rec)["featureId"] === canonical &&
            (r["subject"] as Rec)["componentKey"] === "e5",
        );
      const publicE5 = await fusedE5(false);
      expect(publicE5.map((r) => (r["provenance"] as Rec)["sourceId"])).toEqual(["@fused-public"]);
      expect(JSON.stringify(publicE5)).not.toContain("es-fuel-test");
      const fullE5 = await fusedE5(true);
      expect(fullE5.map((r) => (r["provenance"] as Rec)["sourceId"])).toEqual(["@fused"]);
    } finally {
      await sql`UPDATE conditions.source SET restricted = false WHERE id = 'es-fuel-test'`;
      await refresh();
    }
  });

  it("a restricted member lends a public canonical feature no offers, even a public source's", async () => {
    const tariff = golden.get("de-bw-ocpdb")!.offers[0]!;
    const station = golden.get("es-minetur-fuel")!.features.find((f) => f["id"] === STATION)!;
    const { upstream: _upstream, ...provenance } = tariff["provenance"] as Rec;
    const onTwin: Rec = {
      ...tariff,
      id: "oc:offer:es-minetur-fuel:twin-card",
      location: station["location"],
      subject: { class: "feature", id: TWIN },
      provenance: {
        ...provenance,
        sourceId: "es-minetur-fuel",
        sourceFormat: "minetur",
        recordId: "twin-card",
        attribution: { provider: "MINETUR", license: "CC-BY-4.0" },
      },
    };
    const written = await writeSnapshot(
      sql,
      "es-minetur-fuel",
      { offers: [onTwin] },
      { registry: facilitiesRegistry, instanceId: INSTANCE, now: NOW, complete: false },
    );
    expect(written.rejected).toEqual([]);
    await sql`UPDATE conditions.source SET restricted = true WHERE id = 'es-fuel-test'`;
    try {
      const url = `/features?canonical=1&${STATION_BOX}&expand=offers,latest`;
      const offersOf = (body: Rec) =>
        Object.values(body["offers"] as Record<string, Rec[]>).flatMap((o) =>
          o.map((r) => r["id"]),
        );
      const shown = await as(url, false);
      expect(shown.body["records"]).toHaveLength(1);
      expect(offersOf(shown.body)).toEqual([]);
      expect(JSON.stringify(shown.body)).not.toContain(TWIN);
      expect(offersOf((await as(url, true)).body)).toEqual(["oc:offer:es-minetur-fuel:twin-card"]);
    } finally {
      await sql`UPDATE conditions.source SET restricted = false WHERE id = 'es-fuel-test'`;
      await sql`DELETE FROM conditions.offer WHERE id = 'oc:offer:es-minetur-fuel:twin-card'`;
    }
  });

  it("an unknown expand value is a 400", async () => {
    const { res, body } = await get("/features?expand=latest,prices");
    expect(res.statusCode).toBe(400);
    expect(body).toMatchObject({ error: "invalid query" });
    expect(JSON.stringify(body["issues"])).toContain("expand");
    expect((await get(`/features/${enc(STATION)}?expand=prices`)).res.statusCode).toBe(400);
    expect((await get("/features?expand=latest,latest&limit=1")).res.statusCode).toBe(200);
  });

  it("expand=latest on /features/:id returns the feature's readings", async () => {
    const { body } = await get(`/features/${enc(STATION)}?expand=latest`);
    expect((body["record"] as Rec)["id"]).toBe(STATION);
    expect(body["offers"]).toBeUndefined();
    const readings = body["latest"] as Rec[];
    expect(readings.map((r) => r["componentKey"]).sort()).toEqual([
      "diesel",
      "e5",
      "hvo100",
      "lpg",
      "sp98",
    ]);
    expect(new Set(readings.map((r) => r["source"]))).toEqual(new Set(["es-minetur-fuel"]));
    const canonicalId = (body["canonical"] as Rec)["canonicalFeatureId"] as string;
    const cluster = await get(`/features/${enc(canonicalId)}?expand=latest,offers`);
    expect(new Set((cluster.body["latest"] as Rec[]).map((r) => r["source"]))).toEqual(
      new Set(["@fused"]),
    );
    expect(cluster.body["offers"]).toEqual([]);
    const site = await get(`/features/${enc("oc:feature:de-bw-ocpdb:72555")}?expand=offers`);
    expect(site.body["offers"] as Rec[]).toHaveLength(2);
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
    expect((await get(`/features/${enc("oc:feature:es-minetur-fuel:none")}`)).res.statusCode).toBe(
      404,
    );
  });

  it("serves a feature whose source id is a URL with a fragment, as Ghent's are", async () => {
    const local = "https://stad.gent/nl/loop/mobiliteit-loop#Parkeerterreinen_Stad_Gent";
    const [park] = carParks("be-vlg-gent-parking", [local]);
    await writeParks("be-vlg-gent-parking", [park!], NOW, "CC-BY-4.0");
    const id = `oc:feature:be-vlg-gent-parking:${local}`;
    const { res, body } = await get(`/features/${enc(id)}`);
    expect(res.statusCode).toBe(200);
    expect((body["record"] as Rec)["id"]).toBe(id);
  });
});

describe("single records follow the live rules", () => {
  beforeEach(reset, 120_000);

  /** Moves a stored record's expiry, in its column and its record alike. */
  const expire = (table: "feature" | "offer", id: string, at: string) =>
    sql.unsafe(
      `UPDATE conditions.${table}
          SET expires_at = $2::timestamptz,
              record = jsonb_set(record, '{freshness,expiresAt}', to_jsonb($2::text))
        WHERE id = $1`,
      [id, at],
    );

  it("answers 404 for a feature or offer past its expiry, and drops it from its cluster", async () => {
    await expire("feature", STATION, "2026-09-22T11:15:00.000Z");
    expect((await get(`/features/${enc(STATION)}`)).res.statusCode).toBe(404);
    const twin = await get(`/features/${enc(TWIN)}`);
    expect(twin.res.statusCode).toBe(200);
    expect(twin.body["canonical"]).toMatchObject({ survivorId: TWIN, memberIds: [TWIN] });

    const offer = "oc:offer:de-bw-ocpdb:138586";
    expect((await get(`/offers/${enc(offer)}`)).res.statusCode).toBe(200);
    await expire("offer", offer, "2026-09-22T11:15:00.000Z");
    expect((await get(`/offers/${enc(offer)}`)).res.statusCode).toBe(404);
  });

  it("names only the members it serves: a member whose licence is not public is not named", async () => {
    await sql`
      UPDATE conditions.feature
         SET record = jsonb_set(record, '{provenance,attribution,license}', '"ODbL-1.0"')
       WHERE id = ${TWIN}`;
    const station = await get(`/features/${enc(STATION)}`);
    expect(station.res.statusCode).toBe(200);
    expect(station.body["canonical"]).toMatchObject({ survivorId: STATION, memberIds: [STATION] });
    const canonicalId = (station.body["canonical"] as Rec)["canonicalFeatureId"] as string;
    const cluster = await get(`/features/${enc(canonicalId)}`);
    expect(cluster.body["canonical"]).toEqual(station.body["canonical"]);
  });
});

describe("GET /offers and /offers/{id}", () => {
  beforeAll(reset, 120_000);

  it("walks the live offers and filters them", async () => {
    expect((await walk("/offers", "", 1)).sort()).toEqual([
      "oc:offer:de-bw-ocpdb:138586",
      "oc:offer:de-bw-ocpdb:138587",
      "oc:offer:nl-ndw-truck-parking:NL-12_421:1",
    ]);
    expect(ids((await get("/offers?source=es-minetur-fuel")).body)).toEqual([]);
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
    publicGolden().flatMap((d) => d.observations.map((o) => o["id"] as string));

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
        expect.objectContaining({ source: "es-minetur-fuel" }),
        expect.objectContaining({ source: "es-fuel-test" }),
      ]),
    );
    expect(records.filter((r) => r["property"] === "traffic.speed")).toHaveLength(2);
  });

  it("serves a place's readings, crowd and feed, in the canonical view: nothing fuses a place", async () => {
    const location = {
      geometry: { type: "Point", coordinates: [-3.7, 40.4] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      admin: { country: "ES" },
    };
    const average: Rec = {
      class: "observation",
      kind: "observation",
      property: "fuel.price",
      temporality: "live",
      subject: { kind: "location" },
      qualifiers: { product: "e5" },
      location,
      provenance: {
        origin: "feed",
        sourceId: "es-minetur-fuel",
        sourceFormat: "minetur",
        accessMode: "bulk",
        recordId: "avg-e5",
        attribution: { provider: "MINETUR", license: "CC-BY-4.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: "2026-09-22T11:10:00.000Z" },
      result: { type: "money", amount: "1.700", currency: "EUR", per: "L" },
      phenomenonTime: { instant: "2026-09-22T11:00:00.000Z" },
      aggregation: "mean",
    };
    average["id"] = observationId("es-minetur-fuel", average as never);
    const summary = await writeSnapshot(
      sql,
      "es-minetur-fuel",
      { observations: [average] },
      {
        registry: facilitiesRegistry,
        instanceId: INSTANCE,
        now: "2026-09-22T11:10:00.000Z",
        complete: false,
      },
    );
    expect(summary.rejected).toEqual([]);
    const crowd = await landPlacePriceReport(sql, { location, nonce: "nonce-place-00001" });
    try {
      const perSource = ids(
        (await get("/observations/latest?property=fuel.price&limit=5000")).body,
      );
      expect(perSource).toEqual(expect.arrayContaining([average["id"], crowd]));
      const canonical = ids(
        (await get("/observations/latest?canonical=1&property=fuel.price&limit=5000")).body,
      );
      expect(canonical).toEqual(expect.arrayContaining([average["id"], crowd]));
    } finally {
      await sql`DELETE FROM conditions.observation_latest
                 WHERE subject_kind = 'location' AND property = 'fuel.price'`;
    }
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

  it("says a lane keeps no history instead of answering an empty page", async () => {
    await writeSiteReadings(
      sql,
      "nl-ndw-flow",
      [
        {
          site: "h1",
          geometry: { type: "Point", coordinates: [4.5, 52.0] },
          at: T1,
          speed: 88,
          componentKey: "lane1",
        },
      ],
      T1,
    );
    const { res, body } = await get(
      `/observations?subject=${enc(site)}&component=lane1&property=traffic.speed`,
    );
    expect(res.statusCode).toBe(400);
    expect(body["error"]).toMatch(/keeps no history.*\/observations\/latest/);
  });

  it("names a series by a record id and a component too", async () => {
    const byId = await get(
      `/observations?subject=${enc(STATION)}&component=e5&property=fuel.price&from=2026-09-01T00:00:00Z&to=2026-09-23T00:00:00Z`,
    );
    expect(byId.res.statusCode).toBe(200);
    expect(byId.body["series"]).toMatchObject({
      subjectKey: `feature:${STATION}#e5`,
      sourceId: "es-minetur-fuel",
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
          sources: ["es-fuel-test", "es-minetur-fuel"],
        }),
        expect.objectContaining({ country: "AT", accessMode: "on_demand", records: 2 }),
      ]),
    );
    for (const fused of ["@fused", "@fused-public"]) {
      expect(coverage.some((c) => (c["sources"] as string[]).includes(fused))).toBe(false);
    }
  });

  it("counts a feature or a situation only until its expiry, as a reading", async () => {
    const events = "de-coverage-events";
    await writeSituations(sql, events, [situationDraft("lapsing", {}, events)]);
    await sql`UPDATE conditions.situation SET expires_at = NULL WHERE source_id = ${events}`;
    const counted = async (cls: string, source: string) =>
      ((await get("/coverage")).body["coverage"] as Rec[])
        .filter((c) => c["class"] === cls && (c["sources"] as string[]).includes(source))
        .reduce((n, c) => n + (c["records"] as number), 0);
    expect(await counted("situation", events)).toBe(1);
    expect(await counted("feature", "es-minetur-fuel")).toBeGreaterThan(0);

    const lapsed = "2026-09-22T11:00:00Z";
    await sql`UPDATE conditions.situation SET expires_at = ${lapsed} WHERE source_id = ${events}`;
    await sql`UPDATE conditions.feature SET expires_at = ${lapsed}
               WHERE source_id = 'es-minetur-fuel'`;
    expect(await counted("situation", events)).toBe(0);
    expect(await counted("feature", "es-minetur-fuel")).toBe(0);
  });
});
