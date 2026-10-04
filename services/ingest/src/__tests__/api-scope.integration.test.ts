import type { Catalog } from "@openconditions/ingest-framework";
import { RESOLVER_VERSION } from "@openconditions/roads";
import { syncSources } from "@openconditions/storage";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { operatorTokenFromEnv, registerScope } from "../api/scope.js";
import { FeedStatusStore } from "../feed-status.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { REPO_CATALOG, testFeed } from "./helpers/catalog.js";
import { facilitiesRegistry, STATION, TWIN, writeFacilities } from "./helpers/facilities.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { bindSituation, situationDraft, writeSituations } from "./helpers/situations.js";

/**
 * Who a request reads for: the public by default, the operator with the
 * instance's bearer token. Situations of a public, a restricted and a
 * share-alike source; facilities whose twin fuel station comes from a
 * restricted source; and bound closures of a public and a restricted feed
 * on one segment for the routing outputs.
 */
let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

type Rec = Record<string, unknown>;

const TOKEN = "operator-token-of-the-scope-suite-0123456789";
const OPERATOR = { authorization: `Bearer ${TOKEN}` };

const PUBLIC_SOURCE = "de-autobahn-events";
const RESTRICTED_SOURCE = "de-restricted-events";
const SHARE_ALIKE_SOURCE = "de-sharealike-events";
const situationId = (source: string, local: string) => `oc:situation:${source}:${local}`;

const SEG_PUBLIC = "xx-public-events";
const SEG_RESTRICTED = "xx-restricted-events";
/** Restricted in `conditions.source`, absent from the catalogue (dropped by a release). */
const SEG_STORED_RESTRICTED = "xx-dropped-events";
const GENERATION = "graph-scope-test";
const NOW = "2026-09-06T00:00:00.000Z";
const AT_10 = "at=2026-09-06T10:00:00Z";

/** A situation of `source` under `license`. */
function licensed(source: string, local: string, license: string): Rec {
  const draft = situationDraft(local, {}, source);
  return {
    ...draft,
    provenance: {
      ...(draft["provenance"] as Rec),
      attribution: { provider: source, license },
    },
  };
}

/** A point closure of `source` on the test segment, valid 06:00 to 18:00. */
function closure(source: string, local: string): Rec {
  const draft = situationDraft(
    local,
    {
      validity: {
        status: "active",
        start: "2026-09-06T06:00:00.000Z",
        end: "2026-09-06T18:00:00.000Z",
      },
    },
    source,
  );
  return {
    ...draft,
    location: {
      geometry: { type: "Point", coordinates: [6.85, 51.2] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      admin: { country: "DE" },
    },
    provenance: {
      ...(draft["provenance"] as Rec),
      attribution: { provider: source, license: "CC0-1.0" },
    },
  };
}

/** A catalogue scheduling both segment feeds, one restricted. */
const CATALOG: Catalog = {
  ...REPO_CATALOG,
  feeds: [SEG_PUBLIC, SEG_RESTRICTED].map((id) =>
    testFeed({
      id,
      name: id,
      cadenceSec: 60,
      freshnessWindowSec: 3600,
      license: "CC0-1.0",
      attribution: id,
      terms: { note: "test grant", reviewedAt: NOW },
      restricted: id === SEG_RESTRICTED,
    }),
  ),
};

const source = (id: string, restricted: boolean) => ({
  id,
  domain: "roads",
  format: "autobahn",
  product: "events",
  tier: "authoritative",
  country: "DE",
  operator: id,
  license: "CC0-1.0",
  attribution: id,
  restricted,
  cadenceSec: 60,
  freshnessWindowSec: 3600,
});

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  // The situation sources first: the facilities seed then marks them
  // inactive, which must not change what each scope reads.
  await syncSources(sql, [
    source(PUBLIC_SOURCE, false),
    source(RESTRICTED_SOURCE, true),
    source(SEG_PUBLIC, false),
    source(SEG_RESTRICTED, true),
    source(SEG_STORED_RESTRICTED, true),
  ]);
  await writeFacilities(sql);
  await sql`UPDATE conditions.source SET restricted = true WHERE id = 'es-fuel-test'`;

  await writeSituations(sql, PUBLIC_SOURCE, [licensed(PUBLIC_SOURCE, "open", "DL-DE-BY-2.0")]);
  await writeSituations(sql, RESTRICTED_SOURCE, [
    licensed(RESTRICTED_SOURCE, "kept-home", "CC-BY-4.0"),
  ]);
  await writeSituations(sql, SHARE_ALIKE_SOURCE, [
    licensed(SHARE_ALIKE_SOURCE, "share-alike", "ODbL-1.0"),
  ]);

  await sql`INSERT INTO conditions.road_graph_state
    (singleton,generation,regions,highway_classes,pbf_provenance,imported_at,activated_at)
    VALUES (true,${GENERATION},'[]','["motorway"]','[]',${NOW},${NOW})`;
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES ('10:f', 10, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.8 51.2, 6.9 51.2)'), 4326),
      'motorway', 'A57', 7000, 5, 100, ${NOW})`;
  for (const feed of [SEG_PUBLIC, SEG_RESTRICTED, SEG_STORED_RESTRICTED]) {
    await sql`INSERT INTO conditions.source_status
      (source,last_success_at,last_network_success_at,freshness_deadline,freshness_window_sec,updated_at)
      VALUES (${feed},${NOW},${NOW},'2030-01-01T00:00:00Z',3600,${NOW})`;
    await writeSituations(sql, feed, [closure(feed, "c1")]);
    await bindSituation(sql, situationId(feed, "c1"), {
      status: "exact",
      confidence: 0.9,
      spans: [{ segmentId: "10:f", wayId: 10, start: 0, end: 1 }],
      generation: GENERATION,
      resolverVersion: RESOLVER_VERSION,
    });
  }
  // With no catalogue feed, routing reads the grant the record was stamped with.
  await sql`UPDATE conditions.situation
    SET record = jsonb_set(record, '{provenance,attribution,rights}', ${sql.json({
      source_redistribution: "yes",
      derived_redistribution: "yes",
      commercial_use: "yes",
      retention: "yes",
      attribution_required: "no",
      reviewed_at: NOW,
      evidence_origin: "stored grant",
      evidence_version: "1",
    })})
    WHERE id = ${situationId(SEG_STORED_RESTRICTED, "c1")}`;
}, 180_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

/** The ingest API with the scope hook in front, configured with `token`. */
async function withApp<T>(
  token: string | undefined,
  fn: (get: (url: string, headers?: Record<string, string>) => Promise<Got>) => Promise<T>,
): Promise<T> {
  const app = Fastify();
  registerScope(app, token);
  registerApiRoutes(app, sql, { registry: facilitiesRegistry });
  registerPublishRoutes(app, sql, new FeedStatusStore(), CATALOG);
  await app.ready();
  try {
    return await fn(async (url, headers = {}) => {
      const res = await app.inject({ method: "GET", url, headers });
      return { status: res.statusCode, headers: res.headers, body: res.json() as Rec };
    });
  } finally {
    await app.close();
  }
}

interface Got {
  status: number;
  headers: Record<string, unknown>;
  body: Rec;
}

const ids = (body: Rec) => (body["records"] as Rec[]).map((r) => r["id"] as string);
const enc = encodeURIComponent;
const SITUATIONS = `/situations?source=${PUBLIC_SOURCE},${RESTRICTED_SOURCE},${SHARE_ALIKE_SOURCE}`;

describe("the request scope", () => {
  it("no Authorization header reads in public scope", async () => {
    await withApp(TOKEN, async (get) => {
      const { status, headers, body } = await get(SITUATIONS);
      expect(status).toBe(200);
      expect(ids(body)).toEqual([situationId(PUBLIC_SOURCE, "open")]);
      expect(headers["x-data-license"]).toBe("DL-DE-BY-2.0");
      expect(
        (await get(`/situations/${enc(situationId(RESTRICTED_SOURCE, "kept-home"))}`)).status,
      ).toBe(404);
    });
  });

  it("the operator token reads restricted sources", async () => {
    await withApp(TOKEN, async (get) => {
      const { status, headers, body } = await get(SITUATIONS, OPERATOR);
      expect(status).toBe(200);
      // The operator scope withholds nothing: neither a restricted source
      // nor a licence that is not public.
      expect(ids(body).sort()).toEqual(
        [
          situationId(PUBLIC_SOURCE, "open"),
          situationId(RESTRICTED_SOURCE, "kept-home"),
          situationId(SHARE_ALIKE_SOURCE, "share-alike"),
        ].sort(),
      );
      expect(headers["x-data-license"]).toBe("CC-BY-4.0, DL-DE-BY-2.0, ODbL-1.0");
      const one = await get(
        `/situations/${enc(situationId(RESTRICTED_SOURCE, "kept-home"))}`,
        OPERATOR,
      );
      expect(one.status).toBe(200);
      expect(one.headers["x-data-license"]).toBe("CC-BY-4.0");
      const history = await get(
        `/history/situation/${enc(situationId(RESTRICTED_SOURCE, "kept-home"))}`,
        OPERATOR,
      );
      expect(history.status).toBe(200);
      expect(
        (await get(`/history/situation/${enc(situationId(RESTRICTED_SOURCE, "kept-home"))}`))
          .status,
      ).toBe(404);
    });
  });

  it("a bearer token that differs from the configured one is 401", async () => {
    await withApp(TOKEN, async (get) => {
      for (const value of ["Bearer nope", `Bearer ${TOKEN}x`, "Bearer "]) {
        const res = await get(SITUATIONS, { authorization: value });
        expect(res.status, value).toBe(401);
        expect(res.body).toEqual({ error: "invalid operator token" });
      }
    });
  });

  it("any bearer token reads in public scope while no token is configured", async () => {
    await withApp(undefined, async (get) => {
      for (const value of [OPERATOR.authorization, "Bearer nope", "Bearer "]) {
        const { status, headers, body } = await get(SITUATIONS, { authorization: value });
        expect(status, value).toBe(200);
        expect(ids(body), value).toEqual([situationId(PUBLIC_SOURCE, "open")]);
        expect(headers["cache-control"], value).not.toBe("private, no-store");
      }
    });
  });

  it("warns once at registration that operator scope is disabled while no token is configured", () => {
    for (const [token, warnings] of [
      [undefined, 1],
      [TOKEN, 0],
    ] as const) {
      const app = Fastify();
      const warn = vi.spyOn(app.log, "warn");
      registerScope(app, token);
      expect(warn).toHaveBeenCalledTimes(warnings);
      if (warnings > 0) {
        expect(warn).toHaveBeenCalledWith(
          "operator scope disabled: restricted sources are not served",
        );
      }
      warn.mockRestore();
    }
  });

  it("public emitters stay public with the operator token", async () => {
    await withApp(TOKEN, async (get) => {
      const query = `source=${PUBLIC_SOURCE},${RESTRICTED_SOURCE},${SHARE_ALIKE_SOURCE}`;
      const geojson = await get(`/situations.geojson?${query}`, OPERATOR);
      expect(geojson.status).toBe(200);
      const featureIds = (geojson.body["features"] as Rec[]).map((f) => f["id"]);
      expect(featureIds).toEqual([situationId(PUBLIC_SOURCE, "open")]);
      expect(geojson.headers["x-data-license"]).toBe("DL-DE-BY-2.0");
      const ld = await get(`/situations.jsonld?${query}`, OPERATOR);
      expect(JSON.stringify(ld.body)).not.toContain("kept-home");
      expect(JSON.stringify(ld.body)).not.toContain("share-alike");
      const features = await get(`/features.geojson?source=es-fuel-test`, OPERATOR);
      expect(features.body["features"]).toEqual([]);
    });
  });

  it("serves a restricted source's feature, and its share in a canonical feature, only to the operator", async () => {
    await withApp(TOKEN, async (get) => {
      expect((await get(`/features/${enc(TWIN)}`)).status).toBe(404);
      expect((await get(`/features/${enc(TWIN)}`, OPERATOR)).status).toBe(200);

      const station = await get(`/features/${enc(STATION)}`);
      expect(station.status).toBe(200);
      // The restricted member is not even named in the public cluster.
      expect(station.body["canonical"]).toMatchObject({
        survivorId: STATION,
        memberIds: [STATION],
      });
      const canonicalId = (station.body["canonical"] as Rec)["canonicalFeatureId"] as string;

      const shown = await get(`/features/${enc(canonicalId)}`);
      expect(shown.status).toBe(200);
      const record = shown.body["record"] as Rec;
      const provenance = record["provenance"] as Rec;
      expect(provenance["sourceId"]).toBe("es-minetur-fuel");
      expect(JSON.stringify(record)).not.toContain("es-fuel-test");

      const operator = await get(`/features/${enc(canonicalId)}`, OPERATOR);
      expect(operator.status).toBe(200);
      expect(((operator.body["record"] as Rec)["provenance"] as Rec)["sourceId"]).toBe(
        "es-fuel-test",
      );
      expect(operator.body["canonical"]).toMatchObject({
        survivorId: TWIN,
        memberIds: [TWIN, STATION],
      });

      const listed = await get("/features?source=es-fuel-test");
      expect(ids(listed.body)).toEqual([]);
      expect(ids((await get("/features?source=es-fuel-test", OPERATOR)).body)).toEqual([TWIN]);
    });
  });

  it("segment conditions serve restricted sources only to the operator", async () => {
    await withApp(TOKEN, async (get) => {
      const conditionSources = (body: Rec) =>
        (body["conditions"] as Rec[]).map((c) => c["source"] as string).sort();
      const exclusionSources = (body: Rec) => conditionSources(body["routing_evidence"] as Rec);

      // The dropped source is restricted in `conditions.source` only: the
      // catalogue no longer knows it, and the public still never sees it.
      const all = [SEG_STORED_RESTRICTED, SEG_PUBLIC, SEG_RESTRICTED];
      const url = `/segments/conditions.json?${AT_10}`;
      expect(conditionSources((await get(url)).body)).toEqual([SEG_PUBLIC]);
      expect(conditionSources((await get(url, OPERATOR)).body)).toEqual(all);

      const exclusions = `/valhalla/exclusions.json?bbox=6.8,51.1,6.9,51.3&${AT_10}`;
      expect(exclusionSources((await get(exclusions)).body)).toEqual([SEG_PUBLIC]);
      expect(exclusionSources((await get(exclusions, OPERATOR)).body)).toEqual(all);
    });
  });

  it("keeps operator responses out of shared caches, and varies every response on Authorization", async () => {
    await withApp(TOKEN, async (get) => {
      for (const url of [SITUATIONS, `/segments/conditions.json?${AT_10}`]) {
        const operator = await get(url, OPERATOR);
        expect(operator.headers["cache-control"], url).toBe("private, no-store");
        expect(operator.headers["vary"], url).toMatch(/\bAuthorization\b/);
        const anonymous = await get(url);
        expect(anonymous.headers["cache-control"], url).toMatch(/^public, max-age=\d+$/);
        expect(anonymous.headers["vary"], url).toMatch(/\bAuthorization\b/);
      }
      const rejected = await get(SITUATIONS, { authorization: "Bearer nope" });
      expect(rejected.headers["vary"]).toMatch(/\bAuthorization\b/);
    });
  });

  it("leaves restricted sources out of the public coverage, entries and counts", async () => {
    await withApp(TOKEN, async (get) => {
      const sourcesOf = (body: Rec) =>
        new Set((body["coverage"] as Rec[]).flatMap((c) => c["sources"] as string[]));
      const featuresOf = (body: Rec) =>
        (body["coverage"] as Rec[])
          .filter((c) => c["class"] === "feature" && c["kind"] === "fuel_station")
          .reduce((n, c) => n + (c["records"] as number), 0);
      const anonymous = await get("/coverage");
      expect(anonymous.status).toBe(200);
      const operator = await get("/coverage", OPERATOR);
      expect(operator.headers["cache-control"]).toBe("private, no-store");
      for (const restricted of [RESTRICTED_SOURCE, "es-fuel-test"]) {
        expect(sourcesOf(anonymous.body).has(restricted), restricted).toBe(false);
        expect(sourcesOf(operator.body).has(restricted), restricted).toBe(true);
      }
      expect(sourcesOf(anonymous.body).has(PUBLIC_SOURCE)).toBe(true);
      // The restricted twin station counts for the operator only.
      expect(featuresOf(operator.body)).toBe(featuresOf(anonymous.body) + 1);
    });
  });

  it("reads a non-Bearer Authorization header in the public scope", async () => {
    await withApp(TOKEN, async (get) => {
      for (const authorization of ["Basic dXNlcjpwYXNz", `Bearerxyz${TOKEN}`]) {
        const { status, body } = await get(SITUATIONS, { authorization });
        expect(status, authorization).toBe(200);
        expect(ids(body), authorization).toEqual([situationId(PUBLIC_SOURCE, "open")]);
      }
    });
  });
});

describe("the operator token's configuration", () => {
  it("a short operator token fails boot", () => {
    expect(() => operatorTokenFromEnv({ OPENCONDITIONS_OPERATOR_TOKEN: "short" })).toThrow(/32/);
  });

  it("is unset when absent or blank, and trimmed when set", () => {
    expect(operatorTokenFromEnv({})).toBeUndefined();
    expect(operatorTokenFromEnv({ OPENCONDITIONS_OPERATOR_TOKEN: "   " })).toBeUndefined();
    expect(operatorTokenFromEnv({ OPENCONDITIONS_OPERATOR_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN);
  });
});
