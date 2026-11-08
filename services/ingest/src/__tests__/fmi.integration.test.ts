import { readFileSync } from "node:fs";
import { join } from "node:path";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { formatOf } from "../domains.js";
import { runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dirname, "../../../../packages/weather/src/__tests__/fixtures/fmi", name),
  );
const registry = productionRegistry();
const feed = structuredClone(repoFeed("fi-fmi-weather"));
// Offline fixture qualification explicitly removes catalogue scheduling disablement.
delete feed.disabled;
feed.endpoints.sites = { url: "https://opendata.fmi.fi/fixture/stations", cadenceSec: 86400 };
feed.endpoints.status = { url: "https://opendata.fmi.fi/fixture/observations", cadenceSec: 600 };
let db: TestDatabase;
let clock = "2026-11-07T01:05:00Z";
let metadata = Buffer.from("<wfs:FeatureCollection/>");
let observations = fixture("observations.xml");
let requests = 0;
const app = Fastify();
const catalog = { feeds: [feed], disabled: [], discovered: [], sources: [feed], credentials: {} };
const poll = () =>
  runSource(feed, {
    sql: db.sql,
    fetch: (async (input) => {
      requests++;
      return new Response(
        String(input).includes("/stations") ? metadata.toString() : observations.toString(),
      );
    }) as typeof fetch,
    now: () => clock,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    model: { registry, instanceId: "test.local" },
  });
const get = async (path: string) => {
  const res = await app.inject(path);
  expect(res.statusCode).toBe(200);
  return res.json();
};
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(registry),
    now: new Date(clock),
  });
  await syncSources(db.sql, [feed]);
  registerApiRoutes(app, db.sql, { registry, catalog, now: () => new Date(clock) });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db?.close();
});

test("FMI gate prevents worker requests even with catalogue disablement removed; offline worker/API retain coherent last-good subsets and expire by source time", async () => {
  await expect(poll()).rejects.toThrow(/qualification/);
  expect(requests).toBe(0);
  const format = formatOf(feed);
  const gate = format.acquisitionBlocked;
  delete format.acquisitionBlocked;
  try {
    const combine = (names: string[]) => {
      const base = fixture(names[0]!).toString();
      const members = names.map(
        (n) =>
          fixture(n)
            .toString()
            .match(/<wfs:member>[\s\S]*<\/wfs:member>/)![0],
      );
      return Buffer.from(
        base
          .replace(/<wfs:member>[\s\S]*<\/wfs:member>/, members.join("\n"))
          .replace('numberMatched="1"', 'numberMatched="' + names.length + '"')
          .replace('numberReturned="1"', 'numberReturned="' + names.length + '"'),
      );
    };
    metadata = combine(["station-101004.xml", "station-100971.xml"]);
    expect((await poll()).error).toBeUndefined();
    const features = await get("/features?source=fi-fmi-weather");
    expect(features.records).toHaveLength(2);
    const readings = await get("/observations/latest?source=fi-fmi-weather");
    expect(readings.records).toHaveLength(14);
    expect(readings.records[0].provenance.attribution.license).toBe("CC-BY-4.0");
    expect(JSON.stringify(await get("/sources"))).toContain("normalized by OpenConditions");
    const original = readings.records.find(
      (o: { property: string; subject: { featureId: string } }) =>
        o.property === "weather.air_temperature" && o.subject.featureId.endsWith(":101004"),
    );
    observations = Buffer.from(observations.toString().replace("1.4 0.7 95.0", "1.8 0.7 95.0"));
    expect((await poll()).error).toBeUndefined();
    const corrected = (await get("/observations/latest?source=fi-fmi-weather")).records.find(
      (o: { id: string }) => o.id === original.id,
    );
    expect(corrected.result.value).toBe(1.8);
    expect(corrected.quality).toBeUndefined();
    const history = await app.inject(
      "/observations?subject=" +
        encodeURIComponent(original.subject.featureId) +
        "&component=t2m&property=weather.air_temperature&source=fi-fmi-weather",
    );
    expect(history.statusCode).toBe(400);
    expect(history.json().error).toContain("keeps no history");
    // A fresh, valid partial metadata generation must not tombstone the omitted station.
    metadata = combine(["station-101004.xml"]);
    clock = "2026-11-07T01:15:00Z";
    expect((await poll()).error).toBeUndefined();
    expect((await get("/features?source=fi-fmi-weather")).records).toHaveLength(2);
    expect((await get("/observations/latest?source=fi-fmi-weather")).records).toHaveLength(14);
    metadata = Buffer.from(
      metadata
        .toString()
        .replace(
          "<ef:mobile>",
          "<ef:accessConstraints>restricted</ef:accessConstraints><ef:mobile>",
        ),
    );
    clock = "2026-11-07T01:25:00Z";
    expect((await poll()).error).toMatch(/rights/);
    expect((await get("/features?source=fi-fmi-weather")).records).toHaveLength(2);
    observations = Buffer.from("<invalid>");
    clock = "2026-11-07T01:35:00Z";
    expect((await poll()).error).toBeDefined();
    clock = "2026-11-07T02:05:00Z";
    expect((await get("/observations/latest?source=fi-fmi-weather")).records).toEqual([]);
  } finally {
    format.acquisitionBlocked = gate;
  }
});
