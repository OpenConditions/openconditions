import { readFileSync } from "node:fs";
import { publicRecords } from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import { datexRecordsOf, situationsToGeoJSON, situationsToTraff } from "@openconditions/publishers";
import { parseEvents, type RoadFeed, WA_WEBEOC_NOTICE } from "@openconditions/roads";
import Fastify from "fastify";
import type postgres from "postgres";
import { expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { stampAttribution } from "../pipeline/publish.js";
import { repoFeed } from "./helpers/catalog.js";

it("retains WA rights and conditional semantics through canonical, API and public GeoJSON seams", async () => {
  const registry = productionRegistry();
  const feed = repoFeed("au-wa-mainroads-closures-events");
  expect(feed.snapshot).toBeUndefined();
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../../../packages/roads/src/__tests__/fixtures/wa-webeoc/live.geojson",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  fixture.features = [fixture.features[0]];
  fixture.features[0].properties.ClosureTyp = "Road open with specified conditions";
  const at = "2026-11-07T01:00:00.000Z";
  const draft = parseEvents(feed as RoadFeed, [Buffer.from(JSON.stringify(fixture))], {
    fetchedAt: at,
  }).situations[0]!;
  const stamped = stampAttribution(draft, feed);
  expect(stamped["externalIds"]).toContainEqual({
    scheme: "provider",
    authority: feed.id,
    id: `Id:${fixture.features[0].properties.Id}`,
  });
  const validated = registry.validateDraft(stamped);
  expect(validated.ok ? [] : validated.issues).toEqual([]);
  expect(stamped).toMatchObject({
    freshness: { fetchedAt: at },
    provenance: {
      sourceFormat: "wa-webeoc",
      attribution: {
        license: "CC-BY-4.0",
        licensing: {
          bindings: [
            expect.objectContaining({ notice: expect.stringContaining(WA_WEBEOC_NOTICE) }),
          ],
        },
      },
    },
  });
  expect(JSON.stringify(stamped)).not.toContain('"sourceUpdatedAt"');
  const exported = situationsToGeoJSON([stamped], {}, { at: new Date(at) });
  expect(exported.features[0]!.geometry).toEqual(fixture.features[0].geometry);
  expect(JSON.stringify(exported)).toContain(WA_WEBEOC_NOTICE);
  expect(JSON.stringify(exported)).toContain('"normalization":"unsupported"');
  const provenance = stamped["provenance"] as { attribution: { license: string } };
  expect(publicRecords([{ provenance }])).toHaveLength(1);
  expect(
    publicRecords([{ provenance: { ...provenance, upstream: [{ license: "CC-BY-NC-4.0" }] } }]),
  ).toEqual([]);
  // Lossy projections must never turn partial vehicle evidence into an unrestricted road.
  expect(datexRecordsOf(stamped, new Date(at))).toEqual([]);
  expect(situationsToTraff(registry, [stamped], new Date(at))).not.toContain("<message ");
  const app = Fastify();
  registerScope(app, undefined);
  registerApiRoutes(app, {} as unknown as postgres.Sql, {
    registry,
    catalog: { sources: [feed] },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/sources" });
    expect(response.statusCode).toBe(200);
    expect(response.json().sources[0]).toMatchObject({
      id: feed.id,
      format: "wa-webeoc",
      license: "CC-BY-4.0",
      notice: expect.stringContaining(WA_WEBEOC_NOTICE),
      terms: { url: feed.terms!.url, reviewedAt: "2026-11-07" },
    });
  } finally {
    await app.close();
  }
});
