import { productionRegistry } from "@openconditions/model-registry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { relinkFeatures } from "../canonical-view.js";
import { createTestDatabase } from "./database.integration.js";

/**
 * Two car parks of one source on one spot, named as Mobidrom names them. In
 * code point order the upper-case id comes first; a linguistic collation such
 * as the database's default `en_US` puts the lower-case one first. The pair is
 * kept in the order the model writes it, whatever the database's collation.
 */
const UPPER = "oc:feature:mob:PH07";
const LOWER = "oc:feature:mob:parking-apcoa-14697";

let db: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  db = await createTestDatabase();
  for (const id of [UPPER, LOWER]) {
    const record = {
      id,
      kind: "parking_site",
      name: [{ lang: "de", text: "Parkhaus Bahnhof" }],
      location: {
        geometry: { type: "Point", coordinates: [7.0982, 50.7323] },
        fuzziness: "exact",
      },
      provenance: { sourceId: "mob" },
    };
    await db.sql`
      INSERT INTO conditions.feature (id, record, canonical_id, kind, domain, temporality,
        source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
        recorded_at, content_hash, fetched_at, lifecycle, geom)
      VALUES (${id}, ${db.sql.json(record)}, ${id}, 'parking_site', 'parking', 'static', 'mob',
        ${id}, 'feed', 'bulk', 'authoritative', 'local', 1, now(), 'h', now(), 'operational',
        ST_SetSRID(ST_MakePoint(7.0982, 50.7323), 4326))`;
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("a link between features whose ids collations order differently", () => {
  test("is stored in the order the model writes it", async () => {
    const [{ linguistic }] = await db.sql<{ linguistic: boolean }[]>`
      SELECT ${UPPER}::text > ${LOWER}::text AS linguistic`;
    expect(linguistic).toBe(true);

    await db.sql.begin((tx) =>
      relinkFeatures(tx, productionRegistry(), {
        featureIds: [UPPER, LOWER],
        instanceId: "local",
        now: new Date().toISOString(),
      }),
    );

    const links = await db.sql`SELECT a_id, b_id, status FROM conditions.feature_link`;
    expect(links).toEqual([{ a_id: UPPER, b_id: LOWER, status: "accepted" }]);
  }, 60_000);
});
