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
import { createRoleState, runSource } from "../pipeline/run.js";
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
const app = Fastify();
const catalog = { feeds: [feed], disabled: [], discovered: [], sources: [feed], credentials: {} };
const poll = () =>
  runSource(feed, {
    sql: db.sql,
    fetch: (async (input) => {
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

test("FMI worker/API retain coherent last-good subsets and expire by source time", async () => {
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

test.each(["identity", "namespace", "epoch", "axes", "rights", "storage"])(
  "FMI rejected %s generation preserves accepted roles and API, then recovers full and status cadence",
  async (kind) => {
    const format = formatOf(feed),
      gate = format.acquisitionBlocked;
    delete format.acquisitionBlocked;
    const roles = createRoleState();
    const originalSites = feed.endpoints.sites;
    if (kind === "rights" || kind === "storage")
      feed.endpoints.sites = {
        urls: [
          "https://opendata.fmi.fi/fixture/stations-a",
          "https://opendata.fmi.fi/fixture/stations-b",
        ],
        cadenceSec: 86400,
      };
    let reuseSites = false;
    clock = "2026-11-07T01:05:00Z";
    metadata = fixture("station-101004.xml");
    observations = fixture("observations.xml");
    const urls: string[] = [];
    const validators: (string | null)[] = [];
    let etag = "accepted-v1";
    const scheduled = () =>
      runSource(feed, {
        sql: db.sql,
        roles,
        now: () => clock,
        fetch: (async (input, init) => {
          urls.push(String(input));
          validators.push(new Headers(init?.headers).get("if-none-match"));
          if (reuseSites && String(input).includes("/stations"))
            return new Response(null, { status: 304 });
          return new Response(
            String(input).includes("/stations") ? metadata.toString() : observations.toString(),
            { headers: { etag } },
          );
        }) as typeof fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        model: { registry, instanceId: "test.local" },
      });
    try {
      expect((await scheduled()).error).toBeUndefined();
      roles.lastFetchedAt.sites = 0;
      roles.failing.sites = true;
      const accepted = JSON.stringify(roles);
      const acceptedIndex = roles.statusIndex;
      const acceptedIndexValues = JSON.stringify([...roles.statusIndex!]);
      etag = "rejected-v2";
      const before = (await get("/observations/latest?source=fi-fmi-weather")).records;
      const features = (await get("/features?source=fi-fmi-weather")).records;
      const raw = observations.toString();
      if (kind === "identity")
        observations = Buffer.from(
          raw
            .replace(">100971</gml:identifier>", ">101004</gml:identifier>")
            .replace(
              /(<gml:doubleOrNilReasonTupleList>)([\s\S]*?)(<\/gml:doubleOrNilReasonTupleList>)/,
              (_, start: string, text: string, end: string) => {
                const values = text.trim().split(/\s+/);
                for (let i = 49; i < values.length; i += 7) values[i] = "NaN";
                return start + values.join(" ") + end;
              },
            ),
        );
      if (kind === "namespace")
        observations = Buffer.from(
          raw.replace("<swe:DataRecord>", "<swe:DataRecord xmlns:swe='urn:wrong'>"),
        );
      if (kind === "epoch") observations = Buffer.from(raw.replace("1794009600", "0x6aee6800"));
      if (kind === "axes")
        observations = Buffer.from(
          raw.replace(
            "<gmlcov:SimpleMultiPoint ",
            '<gmlcov:SimpleMultiPoint axisLabels="time Lat Long" ',
          ),
        );
      if (kind === "rights")
        metadata = Buffer.from(
          metadata
            .toString()
            .replace(
              "<ef:mobile>",
              "<ef:accessConstraints>restricted</ef:accessConstraints><ef:mobile>",
            ),
        );
      if (kind === "storage") {
        await db.sql.unsafe(
          "CREATE FUNCTION conditions.fmi_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced canonical failure'; END $$",
        );
        await db.sql.unsafe(
          "CREATE TRIGGER fmi_reject BEFORE INSERT OR UPDATE ON conditions.feature FOR EACH ROW EXECUTE FUNCTION conditions.fmi_reject()",
        );
        metadata = Buffer.from(metadata.toString().replace("Helsinki Kumpula", "Rejected name"));
      }
      clock = "2026-11-07T01:16:00Z";
      expect((await scheduled()).error).toBeDefined();
      expect(JSON.stringify(roles)).toBe(accepted);
      expect(roles.statusIndex).toBe(acceptedIndex);
      expect(JSON.stringify([...roles.statusIndex!])).toBe(acceptedIndexValues);
      expect((await get("/observations/latest?source=fi-fmi-weather")).records).toEqual(before);
      expect((await get("/features?source=fi-fmi-weather")).records).toEqual(features);
      if (kind === "namespace") {
        // Reuse this accepted generation: an independent XML case would repeat its
        // setup/recovery HTTP calls and exhaust the real shared per-feed quota.
        metadata = Buffer.from(
          fixture("station-101004.xml")
            .toString()
            .replace("<gml:name ", '<gml:name probe="x<![CDATA[&bogus;]]>" ')
            .replace("Helsinki Kumpula", "Malformed accepted"),
        );
        observations = fixture("observations.xml");
        expect((await scheduled()).error).toMatch(/XML/);
        expect(JSON.stringify(roles)).toBe(accepted);
        expect(roles.statusIndex).toBe(acceptedIndex);
        expect(JSON.stringify([...roles.statusIndex!])).toBe(acceptedIndexValues);
        expect((await get("/observations/latest?source=fi-fmi-weather")).records).toEqual(before);
        expect((await get("/features?source=fi-fmi-weather")).records).toEqual(features);
      }
      if (kind === "storage") {
        await db.sql.unsafe("DROP TRIGGER fmi_reject ON conditions.feature");
        await db.sql.unsafe("DROP FUNCTION conditions.fmi_reject()");
      }
      metadata = fixture("station-101004.xml");
      observations = fixture("observations.xml");
      clock = "2026-11-07T01:27:00Z";
      urls.length = 0;
      validators.length = 0;
      etag = "recovered-v3";
      reuseSites = true;
      expect((await scheduled()).error).toBeUndefined();
      expect(validators).toEqual(
        Array(kind === "rights" || kind === "storage" ? 3 : 2).fill("accepted-v1"),
      );
      expect(urls.some((u) => u.includes("/stations"))).toBe(true);
      clock = "2026-11-07T01:38:00Z";
      urls.length = 0;
      observations = Buffer.from(observations.toString().replace("1.4 0.7 95.0", "1.9 0.7 95.0"));
      if (kind === "namespace")
        observations = Buffer.from(
          observations.toString().replaceAll('name="t2m"', 'name="t&#50;m"'),
        );
      expect((await scheduled()).error).toBeUndefined();
      expect(urls).toEqual(["https://opendata.fmi.fi/fixture/observations"]);
      const temp = (await get("/observations/latest?source=fi-fmi-weather")).records.find(
        (o: { property: string; subject: { featureId: string } }) =>
          o.property === "weather.air_temperature" && o.subject.featureId.endsWith(":101004"),
      );
      expect(temp.result.value).toBe(1.9);
      expect(temp.provenance.attribution.license).toBe("CC-BY-4.0");
    } finally {
      format.acquisitionBlocked = gate;
      feed.endpoints.sites = originalSites;
    }
  },
);
