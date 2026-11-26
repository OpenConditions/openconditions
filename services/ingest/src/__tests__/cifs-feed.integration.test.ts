import {
  type CatalogFeed,
  createFetchState,
  type FeedDefinition,
  type LookupFn,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { registry, situationDraft, writeSituations } from "./helpers/situations.js";

let db: TestDatabase;
let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;
const AT = "at=2026-09-06T10:00:00Z";
const TOKEN = "cifs-operator-token-01234567890123456789";

const LINE_LOCATION = {
  geometry: {
    type: "LineString",
    coordinates: [
      [9.18, 48.78],
      [9.19, 48.79],
    ],
  },
  extent: "linear",
  geometryOrigin: "source",
  fuzziness: "exact",
  roads: [{ name: [{ lang: "de", text: "B10 Stuttgart" }] }],
  direction: { value: "positive", basis: "geometry" },
};

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, { registry });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});
beforeEach(async () => {
  await sql`TRUNCATE conditions.situation CASCADE`;
});

async function seed(count: number) {
  await writeSituations(sql, "de-autobahn-events", [
    situationDraft("seed", { location: LINE_LOCATION }),
  ]);
  await sql`
    WITH copies AS MATERIALIZED (
    SELECT jsonb_populate_record(NULL::conditions.situation, to_jsonb(s) ||
      jsonb_build_object('id', n.id, 'canonical_id', n.id, 'source_record_id', n.local,
        'record', jsonb_set(jsonb_set(s.record, '{id}', to_jsonb(n.id)),
          '{provenance,recordId}', to_jsonb(n.local)))) AS row
    FROM conditions.situation s
    CROSS JOIN (SELECT 'item-' || lpad(i::text, 5, '0') AS local,
      'oc:situation:de-autobahn-events:item-' || lpad(i::text, 5, '0') AS id
      FROM generate_series(1, ${count}) i) n
    WHERE s.id = 'oc:situation:de-autobahn-events:seed')
    INSERT INTO conditions.situation SELECT (row).* FROM copies`;
  await sql`DELETE FROM conditions.situation WHERE source_record_id = 'seed'`;
}

const xmlIncidentIds = (body: string) =>
  [...body.matchAll(/<incident id="([^"]+)"/g)].map((m) => m[1]);

describe("complete public CIFS feeds", () => {
  it("reads beyond a full internal page in both XML and JSON without pagination links", async () => {
    await seed(5001);
    const xmlRes = await app.inject(`/cifs.xml?${AT}`);
    expect(xmlRes.statusCode).toBe(200);
    expect(xmlRes.headers["content-type"]).toContain("application/xml");
    const xmlIds = xmlIncidentIds(xmlRes.body);
    expect(xmlIds).toHaveLength(5001);
    expect(xmlIds.at(0)).toBe("oc:situation:de-autobahn-events:item-00001");
    expect(xmlIds.at(-1)).toBe("oc:situation:de-autobahn-events:item-05001");
    expect(xmlRes.headers["link"]).toBeUndefined();

    const jsonRes = await app.inject(`/cifs.json?${AT}`);
    expect(jsonRes.statusCode).toBe(200);
    expect(jsonRes.headers["content-type"]).toContain("application/json");
    const body = jsonRes.json() as { incidents: { id: string }[] };
    expect(body.incidents.map((i) => i.id)).toEqual(xmlIds);
  });

  it("refuses oversized selections (>20,000 candidates) with 413 JSON and Cache-Control: no-store", async () => {
    await seed(20001);
    for (const path of ["/cifs.xml", "/cifs.json"]) {
      const res = await app.inject(`${path}?${AT}`);
      expect(res.statusCode).toBe(413);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toMatchObject({ error: expect.stringMatching(/narrow/i) });
    }
  });

  it("bounds UTF-8 bytes on both /cifs.xml and /cifs.json", async () => {
    await seed(1);
    await sql`UPDATE conditions.situation SET record = jsonb_set(record, '{location,roads}',
      jsonb_build_array(jsonb_build_object('ref', repeat('é', 17 * 1024 * 1024))))`;
    for (const path of ["/cifs.xml", "/cifs.json"]) {
      const res = await app.inject(`${path}?${AT}`);
      expect(res.statusCode).toBe(413);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it.each([
    "limit=1",
    "cursor=oc%3Asituation%3Ax%3Ay",
    "simplify=0.01",
    "from=2026-09-01T00:00:00Z",
    "to=2026-09-06T00:00:00Z",
  ])("rejects unsupported query controls (%s) on /cifs.xml and /cifs.json", async (query) => {
    for (const path of ["/cifs.xml", "/cifs.json"]) {
      const res = await app.inject(`${path}?${AT}&${query}`);
      expect(res.statusCode).toBe(400);
    }
  });

  it("keeps public licence and source restrictions even with the operator token", async () => {
    const source = "de-autobahn-events";
    const saDraft = situationDraft("sa", { location: LINE_LOCATION });
    await writeSituations(sql, source, [
      situationDraft("open", { location: LINE_LOCATION }),
      {
        ...saDraft,
        provenance: {
          ...(saDraft["provenance"] as Record<string, unknown>),
          attribution: { provider: "SA", license: "CC-BY-SA-4.0" },
        },
      },
    ]);
    await writeSituations(sql, "cifs-restricted", [
      situationDraft("secret", { location: LINE_LOCATION }, "cifs-restricted"),
    ]);
    await syncSources(sql, [
      {
        id: "cifs-restricted",
        domain: "roads",
        format: "autobahn",
        product: "events",
        tier: "authoritative",
        country: "DE",
        operator: "test",
        license: "CC0-1.0",
        attribution: "test",
        restricted: true,
        cadenceSec: 60,
        freshnessWindowSec: 3600,
      },
    ]);
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}` }]) {
      const xmlRes = await app.inject({ url: `/cifs.xml?${AT}`, headers });
      expect(xmlRes.statusCode).toBe(200);
      expect(xmlIncidentIds(xmlRes.body)).toEqual(["oc:situation:de-autobahn-events:open"]);
      expect(xmlRes.headers["x-data-license"]).toBe("DL-DE-BY-2.0");

      const jsonRes = await app.inject({ url: `/cifs.json?${AT}`, headers });
      expect(jsonRes.statusCode).toBe(200);
      expect(
        (jsonRes.json() as { incidents: { id: string }[] }).incidents.map((i) => i.id),
      ).toEqual(["oc:situation:de-autobahn-events:open"]);
      expect(jsonRes.headers["x-data-license"]).toBe("DL-DE-BY-2.0");
    }
  });
});

describe("CIFS pipeline acquisition, TTL renewal, and withdrawal authority", () => {
  const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
  const CIFS_BODY = JSON.stringify({
    timestamp: "2026-09-06T09:55:00Z",
    incidents: [
      {
        id: "closure-1",
        type: "ROAD_CLOSED",
        subtype: "ROAD_CLOSED_CONSTRUCTION",
        description: "Bridge work",
        street: "B10 Stuttgart",
        polyline: "48.780000 9.180000 48.790000 9.190000",
        direction: "ONE_DIRECTION",
        starttime: "2026-09-06T08:00:00Z",
        endtime: "2026-09-07T08:00:00Z",
      },
    ],
  });

  function cifsFeed(id: string, over: Partial<CatalogFeed> = {}): CatalogFeed {
    const def: FeedDefinition = {
      operator: "test",
      qualifier: id,
      product: "events",
      name: "Test CIFS",
      format: "cifs",
      tier: "authoritative",
      license: "CC0-1.0",
      attribution: "Test CIFS",
      privacyUrl: "https://example.test/privacy",
      endpoints: { main: { url: `https://cifs.example.test/${id}.json`, cadenceSec: 60 } },
      freshnessWindowSec: 300,
    };
    return {
      ...toCatalogFeed(def, {
        domain: "roads",
        region: "de",
        file: "feeds/roads/de.jsonc",
        maintainers: [],
      }),
      id,
      ...over,
    };
  }

  it("renews retrieval TTL across HTTP 304s, fails closed on errors/malformed polls, and enforces withdrawal authority", async () => {
    const feed = cifsFeed("de-test-cifs-partial");
    const roles = createRoleState();
    const fetchState = createFetchState();
    let mode: "ok" | "not_modified" | "server_error" | "malformed" | "string_status_503" | "empty" =
      "ok";
    let lastIfNoneMatch: string | null = null;

    const fakeFetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      lastIfNoneMatch = new Headers(init?.headers).get("if-none-match");
      if (mode === "ok") {
        return new Response(CIFS_BODY, { status: 200, headers: { ETag: '"v1"' } });
      }
      if (mode === "not_modified") {
        return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
      }
      if (mode === "server_error") {
        return new Response("upstream down", { status: 500 });
      }
      if (mode === "malformed") {
        return new Response(
          JSON.stringify({
            incidents: [
              JSON.parse(CIFS_BODY).incidents[0],
              {
                id: "bad",
                type: "NO_SUCH_TYPE",
                description: "bad",
                street: "B10",
                polyline: "48.78 9.18 48.79 9.19",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (mode === "string_status_503") {
        return new Response(JSON.stringify({ status: "503", incidents: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
    };

    const pollAt = async (iso: string) =>
      runSource(feed, {
        sql,
        fetch: fakeFetch as typeof fetch,
        fetchState,
        lookup: fakeLookup,
        roles,
        now: () => iso,
      });

    // 1. Initial 200 lands closure with expiresAt = T0 + 300s (10:05:00Z)
    const r1 = await pollAt("2026-09-06T10:00:00Z");
    expect(r1.error).toBeUndefined();
    expect(r1.count).toBe(1);
    const [row1] = await sql<{ expires_at: Date; tombstoned_at: Date | null }[]>`
      SELECT expires_at, tombstoned_at FROM conditions.situation WHERE source_id = ${feed.id}`;
    expect(row1?.expires_at.toISOString()).toBe("2026-09-06T10:05:00.000Z");

    // 2. Repeated 304s crossing the original TTL (10:03 then 10:06) advance expiresAt so the closure stays visible
    mode = "not_modified";
    await pollAt("2026-09-06T10:03:00Z");
    expect(lastIfNoneMatch).toBe('"v1"');
    await pollAt("2026-09-06T10:06:00Z");
    const [row2] = await sql<{ expires_at: Date; tombstoned_at: Date | null }[]>`
      SELECT expires_at, tombstoned_at FROM conditions.situation WHERE source_id = ${feed.id}`;
    expect(row2?.expires_at.toISOString()).toBe("2026-09-06T10:11:00.000Z");
    expect(row2?.tombstoned_at).toBeNull();

    const servedAfter304 = await app.inject(
      "/cifs.json?at=2026-09-06T10:06:00Z&source=de-test-cifs-partial",
    );
    expect(servedAfter304.statusCode).toBe(200);
    expect((servedAfter304.json() as { incidents: { id: string }[] }).incidents).toHaveLength(1);

    // 3. Failed 500 poll does NOT withdraw or extend expiresAt
    mode = "server_error";
    const rFail = await pollAt("2026-09-06T10:08:00Z");
    expect(rFail.outcome).toBe("failed");
    const [rowAfterFail] = await sql<{ expires_at: Date; tombstoned_at: Date | null }[]>`
      SELECT expires_at, tombstoned_at FROM conditions.situation WHERE source_id = ${feed.id}`;
    expect(rowAfterFail?.expires_at.toISOString()).toBe("2026-09-06T10:11:00.000Z");
    expect(rowAfterFail?.tombstoned_at).toBeNull();

    // 4. Malformed mixed poll fails closed and must NOT poison the held payload for later 304s
    mode = "malformed";
    const rBad = await pollAt("2026-09-06T10:09:00Z");
    expect(rBad.error).toBeDefined();
    const [rowAfterBad] = await sql<{ expires_at: Date; tombstoned_at: Date | null }[]>`
      SELECT expires_at, tombstoned_at FROM conditions.situation WHERE source_id = ${feed.id}`;
    expect(rowAfterBad?.expires_at.toISOString()).toBe("2026-09-06T10:11:00.000Z");
    expect(rowAfterBad?.tombstoned_at).toBeNull();

    // 4b. Subsequent 304 for If-None-Match: "v1" replays the last accepted "v1" body and renews TTL
    mode = "not_modified";
    const rRecover = await pollAt("2026-09-06T10:09:30Z");
    expect(lastIfNoneMatch).toBe('"v1"');
    expect(rRecover.error).toBeUndefined();
    const [rowAfterRecover] = await sql<{ expires_at: Date; tombstoned_at: Date | null }[]>`
      SELECT expires_at, tombstoned_at FROM conditions.situation WHERE source_id = ${feed.id}`;
    expect(rowAfterRecover?.expires_at.toISOString()).toBe("2026-09-06T10:14:30.000Z");
    expect(rowAfterRecover?.tombstoned_at).toBeNull();

    // 5. Empty 200 poll on default partial CIFS does NOT withdraw existing closure
    mode = "empty";
    await pollAt("2026-09-06T10:10:00Z");
    const [rowAfterPartialEmpty] = await sql<{ tombstoned_at: Date | null }[]>`
      SELECT tombstoned_at FROM conditions.situation WHERE source_id = ${feed.id}`;
    expect(rowAfterPartialEmpty?.tombstoned_at).toBeNull();

    // 6. Qualified complete CIFS feed refuses HTTP 200 failure envelopes (including string "503")
    //    and only withdraws on a recognized empty 200 snapshot
    const completeFeed = cifsFeed("de-test-cifs-complete", {
      snapshot: { completeness: "complete" },
    });
    const completeRoles = createRoleState();
    const completeFetchState = createFetchState();
    mode = "ok";
    await runSource(completeFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      fetchState: completeFetchState,
      lookup: fakeLookup,
      roles: completeRoles,
      now: () => "2026-09-06T10:00:00Z",
    });
    mode = "string_status_503";
    const rStatus503 = await runSource(completeFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      fetchState: completeFetchState,
      lookup: fakeLookup,
      roles: completeRoles,
      now: () => "2026-09-06T10:01:00Z",
    });
    expect(rStatus503.error).toBeDefined();
    const [rowAfter503Envelope] = await sql<{ tombstoned_at: Date | null }[]>`
      SELECT tombstoned_at FROM conditions.situation WHERE source_id = ${completeFeed.id}`;
    expect(rowAfter503Envelope?.tombstoned_at).toBeNull();

    mode = "empty";
    await runSource(completeFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      fetchState: completeFetchState,
      lookup: fakeLookup,
      roles: completeRoles,
      now: () => "2026-09-06T10:02:00Z",
    });
    const [rowAfterCompleteEmpty] = await sql<{ tombstoned_at: Date | null }[]>`
      SELECT tombstoned_at FROM conditions.situation WHERE source_id = ${completeFeed.id}`;
    expect(rowAfterCompleteEmpty?.tombstoned_at).not.toBeNull();
  });
});
