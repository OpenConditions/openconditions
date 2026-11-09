import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

const fixture = (n: string) =>
  readFileSync(
    new URL(
      `../../../../packages/weather/src/__tests__/fixtures/fmi/national/${n}`,
      import.meta.url,
    ),
  );
const oracle = JSON.parse(fixture("oracle.json").toString());
test("national FMI capture survives ordinary guarded acquisition, native child, PG16, paginated API and source expiry", async () => {
  const registry = productionRegistry();
  const feed = structuredClone(repoFeed("fi-fmi-weather"));
  expect(feed.disabled).toBeUndefined();
  // Freeze the captured observation window: 304 applies only to the same URL,
  // never to a newly rendered rolling window. No source or HTTP clocks shift.
  feed.endpoints.status = {
    ...feed.endpoints.status!,
    url: JSON.parse(fixture("capture.json").toString()).find(
      (r: { name: string }) => r.name === "observations",
    ).url,
  };
  const db = await createTestDatabase();
  let child = createParseProcess({ minBytes: 0 });
  const app = Fastify();
  let clock = "2026-11-09T16:40:18.421Z";
  let mode = "cold";
  let calls = 0;
  const roles = createRoleState();
  const run = () =>
    runSource(feed, {
      sql: db.sql,
      roles,
      parseProcess: child,
      now: () => clock,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      model: { registry, instanceId: "test.local" },
      fetch: (async (url, init) => {
        calls++;
        const u = new URL(String(url));
        if (mode === "304") {
          expect(new Headers(init?.headers).get("if-modified-since")).toBeTruthy();
          return new Response(null, { status: 304 });
        }
        if (mode === "cancel") throw new DOMException("qualification cancellation", "AbortError");
        if (mode === "bad") return new Response("<broken>");
        const name = u.searchParams.has("networkid")
          ? `stations-${u.searchParams.get("networkid")}.xml`
          : "observations.xml";
        return new Response(fixture(name), {
          headers: {
            "last-modified": "Mon, 09 Nov 2026 16:40:12 GMT",
            "cache-control": "public, max-age=600",
          },
        });
      }) as typeof fetch,
    });
  const get = async (url: string) => {
    const r = await app.inject(url);
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  const pages = async (path: string) => {
    const records = [];
    let cursor: string | null = null;
    do {
      const p = await get(
        `${path}?source=fi-fmi-weather&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      records.push(...p.records);
      cursor = p.next;
    } while (cursor);
    return records;
  };
  try {
    await ensureObservationPartitions(db.sql, {
      classes: retentionClasses(registry),
      now: new Date(clock),
    });
    await syncSources(db.sql, [feed]);
    await db.sql`INSERT INTO conditions.federation_subscription (id,peer_id,filter,delivery_mode,created_at,updated_at) VALUES ('fmi-all','peer-fmi',${db.sql.json({ properties: ["weather.air_temperature", "weather.dew_point", "weather.humidity", "weather.visibility", "weather.wind_speed", "weather.wind_direction", "weather.wind_gust"] })},'pull',now(),now())`;
    registerApiRoutes(app, db.sql, { registry, now: () => new Date(clock) });
    await app.ready();
    expect((await run()).error).toBeUndefined();
    expect(calls).toBe(4);
    const features = await pages("/features");
    expect(features).toHaveLength(193);
    expect(features.map((f) => f.id.split(":").at(-1)).sort()).toEqual(
      Object.keys(oracle.stations).sort(),
    );
    const readings = await pages("/observations/latest");
    expect(readings).toHaveLength(1108);
    for (const o of readings) {
      const e =
        oracle.readings[`${o.subject.featureId.split(":").at(-1)}:${o.subject.componentKey}`];
      expect(o.result.value).toBe(e.value);
      expect(o.provenance.attribution.license).toBe("CC-BY-4.0");
      expect(o.quality).toBeUndefined();
    }
    expect((await get("/features.geojson?source=fi-fmi-weather&limit=500")).features).toHaveLength(
      193,
    );
    const journal =
      await db.sql`SELECT count(*)::int AS n FROM conditions.federation_outbox WHERE snapshot #>> '{provenance,sourceId}'=${feed.id}`;
    expect(journal[0]?.n).toBe(1301);
    const snapshots =
      await db.sql`SELECT snapshot FROM conditions.federation_outbox WHERE record_class='observation'`;
    expect(snapshots.map((r) => r.snapshot).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...readings].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const expiry = readings.map((o) => [o.id, o.freshness.expiresAt]);
    mode = "304";
    clock = "2026-11-09T16:51:00Z";
    expect((await run()).error).toBeUndefined();
    expect(calls).toBe(5);
    expect((await pages("/observations/latest")).map((o) => [o.id, o.freshness.expiresAt])).toEqual(
      expiry.filter(([, end]) => Date.parse(end) > Date.parse(clock)),
    );
    mode = "identical";
    clock = "2026-11-09T17:02:00Z";
    expect((await run()).error).toBeUndefined();
    expect((await pages("/observations/latest")).map((o) => [o.id, o.freshness.expiresAt])).toEqual(
      expiry.filter(([, end]) => Date.parse(end) > Date.parse(clock)),
    );
    const accepted = JSON.stringify(roles);
    mode = "bad";
    clock = "2026-11-09T17:13:00Z";
    expect((await run()).error).toBeDefined();
    expect(JSON.stringify(roles)).toBe(accepted);
    mode = "cancel";
    expect((await run()).error).toBeDefined();
    expect(JSON.stringify(roles)).toBe(accepted);
    await child.close();
    child = createParseProcess({ minBytes: 0 });
    mode = "identical";
    clock = "2026-11-09T17:24:00Z";
    expect((await run()).error).toBeUndefined();
    expect((await pages("/observations/latest")).map((o) => [o.id, o.freshness.expiresAt])).toEqual(
      expiry.filter(([, end]) => Date.parse(end) > Date.parse(clock)),
    );
    clock = "2026-11-09T18:00:00Z";
    expect(await pages("/observations/latest")).toEqual([]);
    expect(await pages("/features")).toHaveLength(193);
  } finally {
    await app.close();
    await child.close();
    await db.close();
  }
});
