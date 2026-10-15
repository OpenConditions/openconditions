import { recordOf } from "@openconditions/core";
import { isPublicRecord } from "@openconditions/ingest-framework";
import { creditLicensingOf } from "@openconditions/model";
import { enrichReadings, type RoadFeed } from "@openconditions/roads";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { deriveBaselines } from "../pipeline/baseline-derive.js";
import { loadBaselineMap } from "../pipeline/baseline-store.js";
import { stampAttribution } from "../pipeline/publish.js";
import { repoFeed } from "./helpers/catalog.js";
import { siteKey, writeSiteReadings } from "./helpers/flow-series.js";

let db: TestDatabase;
let sql: postgres.Sql;
const NOW = new Date().toISOString();
const feed = { ...repoFeed("nl-ndw-flow"), id: "native", license: "CC0-1.0" } as RoadFeed;
beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await sql`TRUNCATE conditions.sensor_baseline,conditions.observation_latest CASCADE`;
  await syncSources(sql, [
    {
      id: "native",
      domain: "roads",
      format: "native",
      product: "flow",
      tier: "authoritative",
      operator: "Original publisher",
      license: "CC0-1.0",
      attribution: "Original credit",
      restricted: false,
      cadenceSec: 60,
      freshnessWindowSec: 900,
    },
  ]);
});
async function acquireBaseline(license: string, rich = false) {
  await writeSiteReadings(
    sql,
    "native",
    [
      {
        site: "a",
        speed: 80,
        at: NOW,
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        attribution: {
          provider: "Captured supplier",
          license: "CC0-1.0",
          ...(rich
            ? {
                name: "Original dataset",
                url: "https://source.test/original-dataset",
                licenseUrl: "https://terms.test/original",
                publisher: { name: "Actual original author", url: "https://author.test/original" },
                parentSourceId: "original-parent",
                childSourceId: "native",
                policyIds: ["original-policy"],
              }
            : {}),
        },
        upstream: [
          {
            publisher: "Historical authority",
            license,
            licensing: {
              version: 1,
              bindings: [
                {
                  scope: "data",
                  subject: "Historical measurements",
                  license: { kind: "spdx", expression: license },
                  notice: "Original historic notice",
                },
              ],
            },
          },
        ],
      },
    ],
    NOW,
  );
  await sql`INSERT INTO conditions.observation_rollup_hourly(series_id,hour_utc,sample_count,bins,counts,min,max,mean,contributor_receipt_ids,lineage_complete)
    SELECT series_id,date_trunc('hour',now()),30,ARRAY[40]::smallint[],ARRAY[30],80,80,80,ARRAY[contributor_receipt_id],true FROM conditions.observation_latest`;
  await deriveBaselines(sql, { minSamples: 1 });
}
it("keeps restricted or unknown historical-derived denominators out of fresh public enrichment", async () => {
  await acquireBaseline("ODbL-1.0");
  expect((await loadBaselineMap(sql, "native")).has(siteKey("native", "a"))).toBe(false);
  const [held] =
    await sql`SELECT free_flow_kph FROM conditions.sensor_baseline WHERE dow_bucket=-1`;
  expect(held!.free_flow_kph).toBeGreaterThan(80);
});
it("retains exact historical supplier terms in enriched observation and derived congestion after stamping", async () => {
  await acquireBaseline("CC-BY-4.0");
  const map = await loadBaselineMap(sql, "native");
  expect(map.has(siteKey("native", "a"))).toBe(true);
  const later = new Date(Date.parse(NOW) + 60000).toISOString();
  await writeSiteReadings(
    sql,
    "native",
    [
      {
        site: "a",
        speed: 5,
        at: later,
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        attribution: { provider: "Current supplier", license: "CC0-1.0" },
      },
    ],
    later,
  );
  const [row] = await sql`SELECT template,reading FROM conditions.observation_latest`;
  const enriched = enrichReadings(
    feed,
    {
      features: [],
      situations: [],
      observations: [recordOf(row!.template, row!.reading) as Record<string, unknown>],
    },
    map,
  );
  expect(enriched.situations).toHaveLength(1);
  for (const draft of [...enriched.observations, ...enriched.situations]) {
    const stamped = stampAttribution(draft as never, feed as never);
    const provenance = stamped["provenance"] as {
      upstream: { publisher: string; licensing?: unknown }[];
    };
    expect(provenance.upstream).toContainEqual(
      expect.objectContaining({ publisher: "Captured supplier", license: "CC0-1.0" }),
    );
    expect(provenance.upstream).toContainEqual(
      expect.objectContaining({
        publisher: "Historical authority",
        license: "CC-BY-4.0",
        licensing: expect.objectContaining({
          bindings: [expect.objectContaining({ notice: "Original historic notice" })],
        }),
      }),
    );
    expect(isPublicRecord(stamped as never)).toBe(true);
  }
});

it("keeps incomplete derived history internal and falls back to an independently captured OSM denominator", async () => {
  await acquireBaseline("CC-BY-4.0");
  await sql`UPDATE conditions.observation_rollup_hourly SET lineage_complete=false`;
  await deriveBaselines(sql, { minSamples: 1 });
  expect((await loadBaselineMap(sql, "native")).has(siteKey("native", "a"))).toBe(false);
  await sql`INSERT INTO conditions.sensor_baseline(subject_key,source,dow_bucket,tod_bucket,free_flow_kph,method,sample_count,computed_at)
    VALUES (${siteKey("native", "a")},'native',-1,-1,100,'osm_maxspeed',0,now())`;
  expect((await loadBaselineMap(sql, "native")).get(siteKey("native", "a"))).toEqual({
    freeFlowKph: 100,
    method: "osm_maxspeed",
  });
});

it("preserves the full historical source snapshot and original source link through enrichment, stamping and flow receipts", async () => {
  await acquireBaseline("CC-BY-4.0", true);
  const map = await loadBaselineMap(sql, "native");
  const baseline = map.get(siteKey("native", "a"))!;
  const captured = baseline.upstream!.find((u) => u.source);
  expect(captured!.publisher).toBe("Actual original author");
  expect(captured!.source).toEqual({
    sourceId: "native",
    attribution: {
      provider: "Captured supplier",
      license: "CC0-1.0",
      name: "Original dataset",
      url: "https://source.test/original-dataset",
      licenseUrl: "https://terms.test/original",
      publisher: { name: "Actual original author", url: "https://author.test/original" },
      parentSourceId: "original-parent",
      childSourceId: "native",
      policyIds: ["original-policy"],
    },
  });
  const later = new Date(Date.parse(NOW) + 60000).toISOString();
  await writeSiteReadings(
    sql,
    "native",
    [
      {
        site: "a",
        speed: 5,
        at: later,
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        attribution: {
          provider: "Current supplier",
          license: "CC0-1.0",
          url: "https://current.test/different-dataset",
        },
      },
    ],
    later,
  );
  const [row] = await sql`SELECT template,reading FROM conditions.observation_latest`;
  const enriched = enrichReadings(
    feed,
    {
      features: [],
      situations: [],
      observations: [recordOf(row!.template, row!.reading) as Record<string, unknown>],
    },
    map,
  );
  for (const draft of [...enriched.observations, ...enriched.situations]) {
    const stamped = stampAttribution(draft as never, feed as never);
    const p = stamped["provenance"] as {
      attribution: never;
      upstream: NonNullable<typeof baseline.upstream>;
    };
    expect(p.upstream.find((u) => u.source)!.source).toEqual(captured!.source);
    expect(p.upstream.find((u) => u.source)!.licensing).toBeUndefined();
    const [receipt] =
      await sql`SELECT conditions.flow_credit('native',${sql.json(p.attribution)},${sql.json(p.upstream)}) AS credits`;
    expect(receipt!.credits).toContainEqual(
      expect.objectContaining({
        sourceId: "original-parent",
        name: "Original dataset",
        url: "https://source.test/original-dataset",
        licensing: {
          version: 1,
          bindings: [],
          declarations: [{ text: "CC0-1.0", url: "https://terms.test/original" }],
        },
        publisher: { name: "Actual original author", url: "https://author.test/original" },
        attributionText: "Captured supplier",
      }),
    );
    for (const credit of receipt!.credits) expect(credit).not.toHaveProperty("licenseUrl");
    const historical = receipt!.credits.find(
      (c: { publisher?: { name: string } }) => c.publisher?.name === "Historical authority",
    );
    expect(historical).not.toHaveProperty("url");
  }
});

it("SQL canonical licensing preserves captured bindings and bounded declarations without receipt aliases", async () => {
  const declarations = Array.from({ length: 64 }, (_, i) => ({ text: `Other declaration ${i}` }));
  const cases = [
    { license: "CC-BY-4.0", licenseUrl: "https://terms.test/original" },
    {
      license: "CC-BY-4.0",
      licenseUrl: "https://terms.test/original",
      licensing: {
        version: 1 as const,
        bindings: [
          {
            scope: "data" as const,
            subject: "Original",
            license: {
              kind: "spdx" as const,
              expression: "CC-BY-4.0",
              url: "https://terms.test/original",
            },
            notice: "Original exact notice",
            conditions: ["Keep exact condition"],
          },
        ],
        declarations,
      },
    },
    {
      license: "CC-BY-4.0",
      licenseUrl: "https://terms.test/original",
      licensing: {
        version: 1 as const,
        bindings: [],
        declarations: [{ text: "CC-BY-4.0" }, ...declarations.slice(1)],
      },
    },
  ];
  for (const input of cases) {
    const [row] =
      await sql`SELECT conditions.flow_credit_licensing(${sql.json(input)}) AS licensing`;
    expect(row!.licensing).toEqual(creditLicensingOf(input));
    expect(row!.licensing.declarations).toHaveLength(input.licensing?.declarations.length ?? 1);
  }
  const overflow = {
    license: "CC-BY-4.0",
    licenseUrl: "https://terms.test/new",
    licensing: { version: 1, bindings: [], declarations },
  };
  await expect(sql`SELECT conditions.flow_credit_licensing(${sql.json(overflow)})`).rejects.toThrow(
    "portable declaration capacity",
  );
});
