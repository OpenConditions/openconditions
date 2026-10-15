import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bindRecords } from "../pipeline/bind-records.js";
import { situationDraft, writeSituations } from "./helpers/situations.js";

let db: TestDatabase;
let sql: postgres.Sql;
const NOW = "2026-09-06T10:00:00.000Z";
const now = () => NOW;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  // The fixture is on the German A 46; the test pins its own region.
  process.env["SEGMENT_REGIONS"] = JSON.stringify([
    { id: "de-nw", bbox: [5.8, 50.3, 9.5, 52.6], tz: "Europe/Berlin" },
  ]);
  await sql`INSERT INTO conditions.road_graph_state
    (singleton, generation, regions, highway_classes, pbf_provenance, imported_at, activated_at)
    VALUES (true, 'graph-test', '[]', '["motorway"]', '[]', ${NOW}, ${NOW})`;
  await sql`INSERT INTO conditions.road_segment (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, computed_at) VALUES
    ('10:f', 10, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.80 51.2, 6.81 51.2)'),4326), 'motorway', 'A 46', 700, 5, ${NOW}),
    ('11:f', 11, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.81 51.2, 6.82 51.2)'),4326), 'motorway', 'A 46', 700, 5, ${NOW}),
    ('20:f', 20, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.82 51.2003, 6.80 51.2003)'),4326), 'motorway', 'A 46', 1400, 5, ${NOW})`;
}, 120_000);

afterAll(async () => {
  await db?.close();
  delete process.env["SEGMENT_REGIONS"];
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.record_binding, conditions.record_segment CASCADE`;
});

async function bindings() {
  return sql<{ record_id: string; effect_id: string; status: string; reason: string | null }[]>`
    SELECT record_id, effect_id, status, reason FROM conditions.record_binding
     ORDER BY record_id, effect_id`;
}

async function spans(recordId: string, effectId = "") {
  const rows = await sql<{ segment_id: string }[]>`
    SELECT segment_id FROM conditions.record_segment
     WHERE record_class = 'situation' AND record_id = ${recordId} AND effect_id = ${effectId}
     ORDER BY seq`;
  return rows.map((r) => r.segment_id);
}

const id = (local: string) => `oc:situation:de-autobahn-events:${local}`;

describe("bindRecords", () => {
  it("binds a situation's line, and marks one outside every region and an area kind", async () => {
    await writeSituations(sql, "de-autobahn-events", [
      situationDraft("line"),
      situationDraft("far", {
        location: {
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
          extent: "point",
          geometryOrigin: "source",
          fuzziness: "exact",
          admin: { country: "DE" },
        },
      }),
      situationDraft("fog", {
        kind: "weather_condition",
        type: "weather",
        subtype: "fog",
        effects: [],
        details: { kind: "weather_condition", v: 1 },
      }),
    ]);
    const r = await bindRecords(sql, [id("line"), id("far"), id("fog")], { now });
    expect(r.attempted).toBe(3);
    expect(await bindings()).toEqual([
      { record_id: id("far"), effect_id: "", status: "no_coverage", reason: "outside_regions" },
      expect.objectContaining({ record_id: id("fog"), status: "not_applicable" }),
      expect.objectContaining({ record_id: id("line"), effect_id: "" }),
    ]);
    expect(await spans(id("line"))).toEqual(["10:f", "11:f"]);
  });

  it("binds an effect that names its own location separately", async () => {
    const draft = situationDraft("works");
    const closure = (draft["effects"] as Record<string, unknown>[])[0]!;
    await writeSituations(sql, "de-autobahn-events", [
      {
        ...draft,
        effects: [
          {
            ...closure,
            location: {
              geometry: {
                type: "LineString",
                coordinates: [
                  [6.818, 51.2002],
                  [6.805, 51.2002],
                ],
              },
            },
          },
        ],
      },
    ]);
    await bindRecords(sql, [id("works")], { now });
    expect(await spans(id("works"))).toEqual(["10:f", "11:f"]);
    expect(await spans(id("works"), "works/closure")).toEqual(["20:f"]);
  });

  it("uses an effect's own road references instead of the parent's", async () => {
    await sql`INSERT INTO conditions.road_segment (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, computed_at)
      VALUES ('30:f', 30, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.80 51.2, 6.82 51.2)'),4326), 'motorway', 'B 57', 1400, 5, ${NOW})`;
    try {
      const draft = situationDraft("own-road");
      const effect = (draft["effects"] as Record<string, unknown>[])[0]!;
      await writeSituations(sql, "de-autobahn-events", [
        {
          ...draft,
          effects: [
            { ...effect, location: { ...(draft["location"] as object), roads: [{ ref: "B 57" }] } },
          ],
        },
      ]);
      await bindRecords(sql, [id("own-road")], { now });
      expect(await spans(id("own-road"))).toEqual(["10:f", "11:f"]);
      expect(await spans(id("own-road"), "own-road/closure")).toEqual(["30:f"]);
    } finally {
      await sql`DELETE FROM conditions.road_segment WHERE segment_id = '30:f'`;
    }
  });

  it("skips an unchanged situation and rebinds a new revision", async () => {
    await writeSituations(sql, "de-autobahn-events", [situationDraft("line")]);
    await bindRecords(sql, [id("line")], { now });
    expect((await bindRecords(sql, [id("line")], { now })).skippedUnchanged).toBe(1);
    await writeSituations(
      sql,
      "de-autobahn-events",
      [
        situationDraft("line", {
          location: {
            ...(situationDraft("line")["location"] as object),
            geometry: {
              type: "LineString",
              coordinates: [
                [6.818, 51.2002],
                [6.805, 51.2002],
              ],
            },
          },
        }),
      ],
      "2026-09-06T10:05:00.000Z",
    );
    const again = await bindRecords(sql, [id("line")], { now });
    expect(again.attempted).toBe(1);
    expect(await spans(id("line"))).toEqual(["20:f"]);
  });

  it("clears exact routing spans when a location becomes coarse", async () => {
    const draft = situationDraft("precision");
    await writeSituations(sql, "de-autobahn-events", [draft]);
    await bindRecords(sql, [id("precision")], { now });
    expect(await spans(id("precision"))).toEqual(["10:f", "11:f"]);
    await writeSituations(
      sql,
      "de-autobahn-events",
      [
        {
          ...draft,
          location: {
            ...(draft["location"] as object),
            fuzziness: "low_res",
            geometryOrigin: "tmc_table",
            locationTable: { ref: "VILD", version: "6.13.A" },
          },
        },
      ],
      "2026-09-06T10:05:00.000Z",
    );
    await bindRecords(sql, [id("precision")], { now });
    expect(await spans(id("precision"))).toEqual([]);
    expect(await bindings()).toEqual([
      expect.objectContaining({
        record_id: id("precision"),
        status: "unresolved",
        reason: "location_not_exact",
      }),
    ]);
  });

  it.each([
    {
      parent: "exact",
      effect: "low_res",
      own: false,
      rootSpans: ["10:f", "11:f"],
      effectSpans: [],
    },
    { parent: "exact", effect: "low_res", own: true, rootSpans: ["10:f", "11:f"], effectSpans: [] },
    { parent: "low_res", effect: "exact", own: true, rootSpans: [], effectSpans: ["20:f"] },
    {
      parent: "low_res",
      effect: "exact",
      own: false,
      rootSpans: [],
      effectSpans: ["10:f", "11:f"],
    },
    { parent: "low_res", effect: undefined, own: true, rootSpans: [], effectSpans: [] },
  ])(
    "uses effective precision for effect locations: %j",
    async ({ parent, effect, own, rootSpans, effectSpans }) => {
      const draft = situationDraft("effect-precision");
      const closure = (draft["effects"] as Record<string, unknown>[])[0]!;
      const location = { ...(draft["location"] as object), fuzziness: parent };
      const effectLocation = {
        ...(effect ? { fuzziness: effect } : {}),
        ...(own
          ? {
              geometry: {
                type: "LineString",
                coordinates: [
                  [6.818, 51.2002],
                  [6.805, 51.2002],
                ],
              },
            }
          : {}),
      };
      await writeSituations(sql, "de-autobahn-events", [
        { ...draft, location, effects: [{ ...closure, location: effectLocation }] },
      ]);
      await bindRecords(sql, [id("effect-precision")], { now });
      expect(await spans(id("effect-precision"))).toEqual(rootSpans);
      expect(await spans(id("effect-precision"), "effect-precision/closure")).toEqual(effectSpans);
      if (effectSpans.length === 0)
        expect(await bindings()).toContainEqual(
          expect.objectContaining({
            effect_id: "effect-precision/closure",
            status: "unresolved",
            reason: "location_not_exact",
          }),
        );
    },
  );

  it("drops the binding of a situation its source withdrew", async () => {
    await writeSituations(sql, "de-autobahn-events", [situationDraft("line")]);
    await bindRecords(sql, [id("line")], { now });
    await writeSituations(sql, "de-autobahn-events", [], "2026-09-06T10:05:00.000Z");
    const r = await bindRecords(sql, [id("line")], { now });
    expect(r.cleared).toBe(1);
    expect(await bindings()).toEqual([]);
    expect(await spans(id("line"))).toEqual([]);
  });

  it("does not bind before the graph is ready", async () => {
    await writeSituations(sql, "de-autobahn-events", [situationDraft("line")]);
    await sql`UPDATE conditions.road_graph_state SET status = 'rebuilding'`;
    try {
      expect((await bindRecords(sql, [id("line")], { now })).attempted).toBe(0);
    } finally {
      await sql`UPDATE conditions.road_graph_state SET status = 'ready'`;
    }
  });
});
