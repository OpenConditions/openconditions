import { createTestDatabase } from "@openconditions/test-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordOf } from "../observation-codec.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});
const localId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const canonicalId = "d6cc7275c8381a201684a097db3117c77609f614652f71ac81a5058715c0dbbf";
const template = {
  namespace: "publisher.test",
  class: "observation",
  kind: "observation",
  revision: 1,
  temporality: "live",
  aggregation: "mean",
  provenance: { sourceId: "publisher.test", recordId: "site" },
};
const reading = {
  id: localId,
  result: { type: "quantity", value: 52, unit: "km/h" },
  phenomenonTime: { instant: "2026-11-04T06:35:00.000Z" },
  provenance: { rawRef: { fetchId: 17 } },
  freshness: { fetchedAt: "2026-11-04T06:36:00.123Z" },
};
const expected = {
  class: "observation",
  kind: "observation",
  revision: 1,
  temporality: "live",
  aggregation: "mean",
  id: `oc:observation:publisher.test:${localId}`,
  canonicalId,
  result: reading.result,
  phenomenonTime: reading.phenomenonTime,
  freshness: reading.freshness,
  provenance: { sourceId: "publisher.test", recordId: "site", rawRef: { fetchId: 17 } },
};

describe("SQL latest observation reconstruction", () => {
  it.each(["compact", "legacy", "custom"])("preserves the complete %s record", async (shape) => {
    const own =
      shape === "compact"
        ? reading
        : {
            ...reading,
            id: shape === "custom" ? "oc:observation:publisher.test:custom:record" : expected.id,
            canonicalId,
          };
    const want = shape === "custom" ? { ...expected, id: own.id } : expected;
    const [row] =
      await db.sql`SELECT conditions.observation_record(${db.sql.json(template)}, ${db.sql.json(own)}) AS record`;
    expect(row!.record).toEqual(want);
    expect(recordOf(template, own)).toEqual(want);
  });

  it("lets a legacy reading override shared fields during a rolling upgrade", async () => {
    const own = { ...reading, id: expected.id, canonicalId, revision: 2, aggregation: "max" };
    const [row] =
      await db.sql`SELECT conditions.observation_record(${db.sql.json(template)}, ${db.sql.json(own)}) AS record`;
    expect(row!.record).toEqual({ ...expected, revision: 2, aggregation: "max" });
  });
});
