import { readFileSync } from "node:fs";
import { type CamerasCatalogFeed, camerasDomain } from "@openconditions/cameras";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources, writeSnapshot } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

const source = repoFeed("ca-bc-drivebc-cameras");
const feed = {
  ...source,
  disabled: undefined,
  snapshot: { ...source.snapshot!, qualification: "qualified" as const, minimumRecords: 1 },
};
const capturedBytes = readFileSync(
  new URL("../../../../packages/cameras/src/__tests__/fixtures/ca-bc-drivebc.csv", import.meta.url),
);
// Keep the captured inventory intact; distinguish credits in this synthetic lifecycle variant.
const bytes = Buffer.from(
  capturedBytes
    .toString("utf8")
    .replace(/^(521,520,.*?),,Lower Mainland/m, "$1,Synthetic north-view credit,Lower Mainland"),
);
const FEATURE = "oc:feature:ca-bc-drivebc-cameras:520";
type Component = { key: string; details: Record<string, unknown> };
type Reading = {
  componentKey: string;
  property: string;
  result: { value: Record<string, unknown> };
  provenance: { attribution: Record<string, unknown> };
};
type Body = {
  records: {
    id: string;
    components: Component[];
    provenance: { attribution: Record<string, unknown> };
  }[];
  latest: Record<string, Reading[]>;
};
const currentCanonical = async (): Promise<Body> => {
  const res = await app.inject({
    url: "/features?kind=camera&canonical=1&expand=components,latest&bbox=-140,48,-114,61",
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
function assertViews(body: Body, featureId: string, prefix: string, ids: string[]) {
  const feature = body.records.find((r) => r.id === featureId)!;
  expect(feature).toBeDefined();
  const components = new Map(feature.components.map((c) => [c.key, c]));
  const readings = new Map(body.latest[featureId]!.map((r) => [r.componentKey, r]));
  for (const id of ids) {
    const credit = id === "521" ? "Synthetic north-view credit" : undefined;
    const details = components.get(prefix + id)!.details;
    expect(details).toMatchObject({
      detailUrl: `https://www.drivebc.ca/cameras/${id}`,
      imageRedistribution: "allowed",
    });
    expect(details.credit).toBe(credit);
    expect(details).not.toHaveProperty("refreshSec");
    const reading = readings.get(prefix + id)!;
    expect(reading.property).toBe("camera.image");
    expect(reading.result.value).toEqual({
      v: 1,
      status: "unknown",
      imageUrl: `https://www.drivebc.ca/images/${id}.jpg`,
    });
    expect(reading.provenance.attribution).toMatchObject({
      provider: feed.attribution,
      license: "LicenseRef-OGL-BC",
      licenseUrl: "https://pub.data.gov.bc.ca/license/OGL-vbc2.0.pdf",
      publisher: { name: credit ?? feed.attribution, url: `https://www.drivebc.ca/cameras/${id}` },
    });
  }
}
let db: TestDatabase;
let app: FastifyInstance;
let now = "2026-11-07T01:00:00Z";
const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const serve = (body: Buffer) =>
  (async () =>
    new Response(new Uint8Array(body), {
      headers: { "content-type": "text/csv" },
    })) as typeof fetch;
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [feed]);
  app = Fastify();
  registerScope(app, "test-token");
  registerApiRoutes(app, db.sql, {
    catalog: { sources: [feed] },
    registry: productionRegistry(),
    now: () => new Date(now),
  });
  await app.ready();
}, 120000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

test("actual pipeline publishes public view credits and keeps last good inventory on qualification failure", async () => {
  const deps = { sql: db.sql, lookup, now: () => now, fetch: serve(bytes) };
  const first = await runSource(feed, deps);
  expect(first.error).toBeUndefined();
  const response = await app.inject({
    url: "/features?kind=camera&expand=components,latest&bbox=-140,48,-114,61",
  });
  expect(response.statusCode, response.body).toBe(200);
  assertViews(response.json(), FEATURE, "", ["520", "521"]);
  const publicFeature = (response.json() as Body).records.find((r) => r.id === FEATURE)!;
  expect(publicFeature.provenance.attribution.rights).toMatchObject({
    source_redistribution: "yes",
    derived_redistribution: "yes",
    commercial_use: "yes",
    attribution_required: "yes",
    retention: "yes",
    evidence_version: "LicenseRef-OGL-BC",
  });
  const sources = await app.inject({ url: "/sources" });
  expect(sources.statusCode).toBe(200);
  expect(sources.body).toContain("LicenseRef-OGL-BC");
  const held =
    await db.sql`SELECT id, revision, content_hash FROM conditions.feature WHERE source_id = ${feed.id} ORDER BY id`;
  const pending = await runSource({ ...feed, snapshot: source.snapshot }, deps);
  expect(pending.error).toMatch(/qualification pending/);
  const empty = await runSource(feed, { ...deps, fetch: serve(Buffer.from("id,cam_group\n")) });
  expect(empty.error).toBeDefined();
  const truncated = await runSource(feed, {
    ...deps,
    fetch: serve(Buffer.from('id,cam_group\n1,"unterminated')),
  });
  expect(truncated.error).toMatch(/CSV/);
  const unavailable = await runSource(feed, {
    ...deps,
    fetch: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
  });
  expect(unavailable.error).toBeDefined();
  const after = await app.inject({
    url: "/features?kind=camera&expand=components,latest&bbox=-140,48,-114,61",
  });
  expect(after.statusCode).toBe(200);
  expect(
    await db.sql`SELECT id, revision, content_hash FROM conditions.feature WHERE source_id = ${feed.id} ORDER BY id`,
  ).toEqual(held);
  // Synthetic independent CSV publisher at the same site, with a distinct view.
  // Equal rank falls back to lexical feature id, making DriveBC the non-survivor.
  const peer = { ...feed, id: "aa-camera-peer" };
  await syncSources(db.sql, [feed, peer]);
  const lines = bytes.toString("utf8").split("\n");
  const peerBytes = Buffer.from(
    [lines[0], lines.find((line) => line.startsWith("520,"))!.replace(/^520,/, "9000,")].join("\n"),
  );
  expect((await runSource(peer, { ...deps, fetch: serve(peerBytes) })).error).toBeUndefined();
  const [cluster] =
    await db.sql`SELECT * FROM conditions.feature_canonical WHERE ${FEATURE} = ANY(member_ids)`;
  expect(cluster!.member_ids.slice().sort()).toEqual(["oc:feature:aa-camera-peer:520", FEATURE]);
  expect(cluster!.survivor_id).toBe("oc:feature:aa-camera-peer:520");
  const canonicalId = cluster!.canonical_feature_id as string;
  const canonical = await currentCanonical();
  assertViews(canonical, canonicalId, `${feed.id}/`, ["520", "521"]);

  now = "2026-11-07T02:00:00Z";
  const oneView = Buffer.from(lines.filter((line) => !line.startsWith("521,")).join("\n"));
  expect((await runSource(feed, { ...deps, fetch: serve(oneView) })).error).toBeUndefined();
  const [surviving] =
    await db.sql`SELECT tombstone_reason, record FROM conditions.feature WHERE id = ${FEATURE}`;
  expect(surviving!.tombstone_reason).toBeNull();
  expect(surviving!.record.components.map((c: { key: string }) => c.key)).toEqual(["520"]);
  const ended =
    await db.sql`SELECT reading FROM conditions.observation_latest WHERE feature_id = ${FEATURE} AND component_key = '521' AND source_id = ${feed.id}`;
  expect(ended).toHaveLength(1);
  expect(new Date(ended[0]!.reading.validUntil).getTime()).toBe(new Date(now).getTime());
  const current = await currentCanonical();
  assertViews(current, canonicalId, `${feed.id}/`, ["520"]);
  expect(
    current.records.find((r) => r.id === canonicalId)!.components.map((c) => c.key),
  ).not.toContain(`${feed.id}/521`);
  expect(current.latest[canonicalId]!.map((r) => r.componentKey)).not.toContain(`${feed.id}/521`);

  const shortened = Buffer.from(
    bytes
      .toString("utf8")
      .split("\n")
      .filter((line) => line.split(",")[1] !== "520")
      .join("\n"),
  );
  const withdrawn = await runSource(feed, { ...deps, fetch: serve(shortened) });
  expect(withdrawn.error).toBeUndefined();
  const rows =
    await db.sql`SELECT tombstone_reason FROM conditions.feature WHERE source_id = ${feed.id} AND id = 'oc:feature:ca-bc-drivebc-cameras:520'`;
  expect(rows[0]?.tombstone_reason).toBe("withdrawn");
});

test("an explicit unapproved upstream licence is retained for operators but rejected publicly", async () => {
  const restricted = { ...feed, id: "zz-unapproved-camera" } as CamerasCatalogFeed;
  await syncSources(db.sql, [feed, restricted]);
  const parsed = camerasDomain.formats.csv!.parse(
    restricted,
    { main: [bytes] },
    {
      fetchedAt: now,
      cadenceSec: 86400,
      reference: {},
    },
  );
  for (const record of [...parsed.features, ...parsed.observations]) {
    (record.provenance as Record<string, unknown>).upstream = [
      { publisher: "Synthetic unapproved upstream", license: "NOASSERTION" },
    ];
  }
  const written = await writeSnapshot(db.sql, restricted.id, parsed, {
    registry: productionRegistry(),
    instanceId: "test.local",
    now,
    complete: false,
  });
  expect(written.rejected).toEqual([]);
  const url = "/features?kind=camera&expand=components,latest&bbox=-140,48,-114,61";
  const publicResponse = await app.inject({ url });
  expect(publicResponse.statusCode).toBe(200);
  expect(
    (publicResponse.json() as Body).records.some((r) =>
      r.id.startsWith(`oc:feature:${restricted.id}:`),
    ),
  ).toBe(false);
  const operator = await app.inject({ url, headers: { authorization: "Bearer test-token" } });
  expect(operator.statusCode).toBe(200);
  const body = operator.json() as Body;
  const id = `oc:feature:${restricted.id}:520`;
  expect(body.records.find((r) => r.id === id)).toBeDefined();
  expect(body.latest[id]).toHaveLength(2);
});
