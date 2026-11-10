import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { contentHash } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase } from "@openconditions/test-database";
import { weatherDomain } from "@openconditions/weather";
import Fastify from "fastify";
import { expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { createRoleState, runSource } from "../pipeline/run.js";

// External immutable capture plus an independently computed oracle. No provider requests,
// timestamp edits or source-clock changes are made by this opt-in qualification.
test.runIf(Boolean(process.env["ECCC_CAPTURE_DIR"]))(
  "national captured cohort through guarded acquisition, child, PG16 and public surfaces",
  async () => {
    const dir = process.env["ECCC_CAPTURE_DIR"]!;
    const oracle = JSON.parse(readFileSync(join(dir, "oracle.json"), "utf8")) as {
      at: string;
      stations: string[];
      expected: {
        station: string;
        property: string;
        value: number;
        unit: string;
        measured: string;
        expiry: string;
        recordId: string;
        window: number;
      }[];
    };
    const root = join(import.meta.dirname, "../../../..");
    const file = readCatalogDir(join(root, "feeds"), [weatherDomain], {
      otherDomains: "ignore",
    }).files.find((f) => f.domain === "weather" && f.region === "ca")!;
    const feed = toCatalogFeed(file.feeds[0]!, {
      domain: file.domain,
      region: file.region,
      file: file.path,
      maintainers: [],
    });
    expect(file.feeds[0]!.disabled).toBeUndefined();
    expect(feed.snapshot).toBeUndefined();
    const capture = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")) as {
      requests: { name: string; url: string }[];
    };
    // Keep the exact captured query end; parsing/expiry use the actual capture receipt time.
    for (const role of ["sites", "status"])
      feed.endpoints[role]!.url = capture.requests.find((r) => r.name === role)!.url;
    const db = await createTestDatabase();
    const app = Fastify();
    let at = oracle.at;
    registerApiRoutes(app, db.sql, {
      registry: productionRegistry(),
      now: () => new Date(at),
      catalog: { sources: [feed] },
    });
    let child = createParseProcess({ minBytes: 0 });
    let calls = 0;
    let conditional = false;
    const upstream = (async (input: unknown, init?: RequestInit) => {
      calls++;
      const role = String(input).includes("swob-stations") ? "sites" : "status";
      if (conditional && new Headers(init?.headers).has("if-none-match"))
        return new Response(null, { status: 304 });
      return new Response(readFileSync(join(dir, `${role}.body`)), {
        headers: { etag: `"capture-${role}"` },
      });
    }) as typeof fetch;
    let roles = createRoleState();
    const run = () =>
      runSource(feed, {
        sql: db.sql,
        fetch: upstream,
        lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
        now: () => at,
        roles,
        parseProcess: child,
        model: { registry: productionRegistry(), instanceId: "test.local" },
      });
    const pages = async (path: string) => {
      const all: Record<string, unknown>[] = [];
      let cursor: string | null = null;
      do {
        const response = await app.inject({
          url: `${path}?source=${feed.id}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        });
        expect(response.statusCode).toBe(200);
        const body: { records: Record<string, unknown>[]; next: string | null } = response.json();
        all.push(...body.records);
        cursor = body.next;
      } while (cursor);
      return all;
    };
    try {
      await syncSources(db.sql, [feed]);
      await db.sql`INSERT INTO conditions.federation_subscription
        (id, peer_id, filter, delivery_mode, created_at, updated_at)
        VALUES ('eccc-capture', 'test-peer', ${db.sql.json({ kinds: ["weather_station"], properties: ["weather.air_temperature", "weather.humidity", "weather.wind_speed", "weather.wind_direction", "weather.precipitation_amount"] })}, 'pull', now(), now())`;
      expect((await run()).error).toBeUndefined();
      expect(child.running).toBe(true);
      expect(calls).toBe(2);
      const features = await pages("/features");
      expect(features).toHaveLength(oracle.stations.length);
      expect(new Set(features.map((f) => (f["externalIds"] as { id: string }[])[0]!.id))).toEqual(
        new Set(oracle.stations),
      );
      const readings = await pages("/observations/latest");
      expect(readings).toHaveLength(oracle.expected.length);
      const featureIds = new Map(
        features.map((f) => [(f["externalIds"] as { id: string }[])[0]!.id, f["id"]]),
      );
      const byKey = new Map(
        readings.map((r) => [
          `${(r["subject"] as { featureId: string }).featureId}/${r["property"]}`,
          r,
        ]),
      );
      for (const expected of oracle.expected) {
        const r = byKey.get(`${featureIds.get(expected.station)}/${expected.property}`)!;
        expect(r).toBeDefined();
        expect(r["result"]).toEqual({
          type: "quantity",
          value: expected.value,
          unit: expected.unit,
        });
        expect(Date.parse((r["freshness"] as { expiresAt: string }).expiresAt)).toBe(
          Date.parse(expected.expiry),
        );
        expect((r["provenance"] as { recordId: string }).recordId).toBe(expected.recordId);
        expect(r["subject"]).not.toHaveProperty("componentKey");
        const phenomenon = r["phenomenonTime"] as {
          instant?: string;
          end?: string;
          start?: string;
        };
        expect(Date.parse(phenomenon.instant ?? phenomenon.end!)).toBe(
          Date.parse(expected.measured),
        );
        if (expected.window)
          expect(Date.parse(phenomenon.start!)).toBe(
            Date.parse(expected.measured) - expected.window * 1000,
          );
      }
      for (const r of [...features, ...readings]) {
        expect(r["contentHash"]).toBe(contentHash(r));
        expect(JSON.stringify(r["provenance"])).toContain(
          "Data Source: Environment and Climate Change Canada",
        );
        expect(JSON.stringify(r["provenance"])).toContain("LicenseRef-ECCC-Data-Servers-End-use");
      }
      const expanded = await app.inject({
        url: `/features?source=${feed.id}&limit=1000&expand=latest`,
      });
      expect(expanded.statusCode).toBe(200);
      const expandedByFeature = expanded.json().latest as Record<string, Record<string, unknown>[]>;
      expect(Object.values(expandedByFeature).flat()).toHaveLength(readings.length);
      for (const r of readings) {
        const subject = r["subject"] as { featureId: string };
        const projected = expandedByFeature[subject.featureId]!.find(
          (p) => p["property"] === r["property"],
        );
        expect(projected).toMatchObject({
          property: r["property"],
          result: r["result"],
          phenomenonTime: r["phenomenonTime"],
          source: feed.id,
        });
        expect(JSON.stringify(projected!["provenance"])).toContain(
          "Data Source: Environment and Climate Change Canada",
        );
      }
      const geo = await app.inject({ url: `/features.geojson?source=${feed.id}&limit=1000` });
      expect(geo.statusCode).toBe(200);
      expect(geo.json().features).toHaveLength(oracle.stations.length);
      const journal =
        await db.sql`SELECT snapshot FROM conditions.federation_outbox WHERE snapshot #>> '{provenance,sourceId}'=${feed.id}`;
      expect(journal.length).toBeGreaterThanOrEqual(features.length + readings.length);
      for (const row of journal) expect(row.snapshot.contentHash).toBe(contentHash(row.snapshot));
      // A forced due conditional cycle exercises held bytes, not a new source lease.
      conditional = true;
      roles.lastFetchedAt["sites"] = 0;
      roles.lastFetchedAt["status"] = 0;
      expect((await run()).error).toBeUndefined();
      expect(await pages("/observations/latest")).toEqual(readings);
      // Cold restart is explicitly bounded to two requests; persisted authority stays in PG.
      await child.close();
      child = createParseProcess({ minBytes: 0 });
      conditional = false;
      roles = createRoleState();
      expect((await run()).error).toBeUndefined();
      expect(child.running).toBe(true);
      expect(await pages("/observations/latest")).toEqual(readings);
      at = new Date(Date.parse(oracle.at) + 3600000).toISOString();
      expect(await pages("/observations/latest")).toHaveLength(0);

      console.log(
        "ECCC_CAPTURE_QUALIFIED",
        JSON.stringify({
          at: oracle.at,
          features: features.length,
          readings: readings.length,
          journal: journal.length,
          calls,
        }),
      );
    } finally {
      await child.close();
      await app.close();
      await db.close();
    }
  },
);
