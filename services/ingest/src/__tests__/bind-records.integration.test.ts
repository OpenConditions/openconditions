import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bindRecords } from "../pipeline/bind-records.js";
import { situationDraft, writeSituations } from "./helpers/situations.js";

let db: TestDatabase;
let sql: postgres.Sql;
const NOW = "2026-09-06T10:00:00.000Z";
type Rec = Record<string, unknown>;
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

  it("reads the street a record's description names where its roads name none", async () => {
    await sql`INSERT INTO conditions.osm_road (way_id, geom, highway, oneway, name, region, imported_at)
      SELECT way_id, geom, highway, false, 'Kölner Straße', 'de-nw', ${NOW}
        FROM conditions.road_segment WHERE way_id IN (10, 11)`;
    try {
      const named = (local: string, description: string) => {
        const draft = situationDraft(local);
        return {
          ...draft,
          headline: [{ lang: "de", text: "Vollsperrung" }],
          description: [{ lang: "de", text: description }],
          location: {
            ...(draft["location"] as Rec),
            roads: [{ name: [{ lang: "und", text: "G" }] }],
          },
        };
      };
      await writeSituations(sql, "de-autobahn-events", [
        named("other", "Vollsperrung der Bahnhofstraße"),
        named("same", "Vollsperrung der Kölner Straße"),
      ]);
      await bindRecords(sql, [id("other"), id("same")], { now });
      expect(await bindings()).toEqual([
        { record_id: id("other"), effect_id: "", status: "unresolved", reason: "road_mismatch" },
        expect.objectContaining({ record_id: id("same"), effect_id: "" }),
      ]);
      expect(await spans(id("same"))).toEqual(["10:f", "11:f"]);
    } finally {
      await sql`DELETE FROM conditions.osm_road WHERE way_id IN (10, 11)`;
    }
  });

  describe("in the direction an effect or location states", () => {
    // A two-way road north of the A 46: way 40 runs east (f) and west (b).
    beforeAll(async () => {
      await sql`INSERT INTO conditions.road_segment (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, computed_at) VALUES
        ('40:f', 40, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.80 51.25, 6.82 51.25)'),4326), 'primary', 'B 9', 1400, 5, ${NOW}),
        ('40:b', 40, 'b', ST_SetSRID(ST_GeomFromText('LINESTRING(6.82 51.25, 6.80 51.25)'),4326), 'primary', 'B 9', 1400, 5, ${NOW})`;
    });
    afterAll(async () => {
      await sql`DELETE FROM conditions.road_segment WHERE way_id = 40`;
    });

    const EAST = { value: "unknown", basis: "compass", compass: "E", text: "eastbound" };
    const onTwoWay = (local: string, geometry: Record<string, unknown>, over: Rec = {}) => {
      const draft = situationDraft(local);
      const closure = (draft["effects"] as Rec[])[0]!;
      return {
        ...draft,
        effects: [
          { ...closure, direction: EAST },
          { ...closure, id: `${local}/closure:2` },
        ],
        location: {
          ...(draft["location"] as Rec),
          geometry,
          extent: geometry["type"] === "Point" ? "point" : "linear",
          roads: [{ ref: "B 9" }],
        },
        ...over,
      };
    };
    const binding = async (recordId: string, effectId = "") => {
      const [row] = await sql<
        { status: string; direction_mode: string; reason: string | null }[]
      >`SELECT status, direction_mode, reason FROM conditions.record_binding
         WHERE record_id = ${recordId} AND effect_id = ${effectId}`;
      return row;
    };

    it("binds an effect's own direction on its own, narrowing its location's binding", async () => {
      await writeSituations(sql, "de-autobahn-events", [
        onTwoWay("narrow", { type: "Point", coordinates: [6.81, 51.25001] }),
      ]);
      await bindRecords(sql, [id("narrow")], { now });
      // The situation's point states no direction: both sides, as before.
      expect(await binding(id("narrow"))).toMatchObject({ direction_mode: "both" });
      expect((await spans(id("narrow"))).sort()).toEqual(["40:b", "40:f"]);
      // The eastbound closure binds only the eastbound side, and routes.
      expect(await binding(id("narrow"), "narrow/closure")).toMatchObject({
        status: expect.stringMatching(/^(exact|likely)$/),
        direction_mode: "single",
      });
      expect(await spans(id("narrow"), "narrow/closure")).toEqual(["40:f"]);
      // The effect without a direction reads the situation's binding.
      expect(await binding(id("narrow"), "narrow/closure:2")).toBeUndefined();
      expect((await bindRecords(sql, [id("narrow")], { now })).skippedUnchanged).toBe(2);
    });

    it("drops an effect's own binding once its direction is its location's", async () => {
      await writeSituations(sql, "de-autobahn-events", [
        onTwoWay("same", { type: "Point", coordinates: [6.81, 51.25001] }),
      ]);
      await bindRecords(sql, [id("same")], { now });
      expect(await binding(id("same"), "same/closure")).toBeDefined();
      const draft = onTwoWay("same", { type: "Point", coordinates: [6.81, 51.25001] });
      await writeSituations(sql, "de-autobahn-events", [
        { ...draft, location: { ...(draft["location"] as Rec), direction: EAST } },
      ]);
      const r = await bindRecords(sql, [id("same")], { now });
      expect(r.cleared).toBe(1);
      expect(await binding(id("same"), "same/closure")).toBeUndefined();
      // The location's own direction now narrows the situation's binding.
      expect(await spans(id("same"))).toEqual(["40:f"]);
    });

    it("binds a location stated in its geometry's order in that order only", async () => {
      const west = {
        type: "LineString",
        coordinates: [
          [6.81009, 51.25001],
          [6.81, 51.25001],
        ],
      };
      const draft = onTwoWay("drawn", west);
      await writeSituations(sql, "de-autobahn-events", [
        {
          ...draft,
          effects: [(draft["effects"] as Rec[])[1]],
          location: {
            ...(draft["location"] as Rec),
            direction: { value: "positive", basis: "geometry" },
          },
        },
      ]);
      await bindRecords(sql, [id("drawn")], { now });
      expect(await binding(id("drawn"))).toMatchObject({ direction_mode: "single" });
      expect(await spans(id("drawn"))).toEqual(["40:b"]);
    });

    it("keeps a single direction it cannot place off the routing statuses", async () => {
      const draft = onTwoWay("tmc", { type: "Point", coordinates: [6.81, 51.25001] });
      await writeSituations(sql, "de-autobahn-events", [
        {
          ...draft,
          effects: [(draft["effects"] as Rec[])[1]],
          location: {
            ...(draft["location"] as Rec),
            direction: { value: "positive", basis: "alert_c" },
          },
        },
      ]);
      await bindRecords(sql, [id("tmc")], { now });
      expect(await binding(id("tmc"))).toEqual({
        status: "ambiguous",
        direction_mode: "unknown",
        reason: "direction_undecided",
      });
    });

    it("reports an effect against its one-directional location instead of binding it", async () => {
      const draft = situationDraft("against");
      const closure = (draft["effects"] as Rec[])[0]!;
      await writeSituations(sql, "de-autobahn-events", [
        {
          ...draft,
          effects: [{ ...closure, direction: { value: "negative", basis: "alert_c" } }],
          location: {
            ...(draft["location"] as Rec),
            direction: { value: "positive", basis: "alert_c" },
          },
        },
      ]);
      await bindRecords(sql, [id("against")], { now });
      expect(await spans(id("against"))).toEqual(["10:f", "11:f"]);
      expect(await binding(id("against"), "against/closure")).toEqual({
        status: "unresolved",
        direction_mode: "unknown",
        reason: "conflicting_direction",
      });
      expect(await spans(id("against"), "against/closure")).toEqual([]);
    });

    it("keeps a measure opposite to a location without an axis off routing", async () => {
      // DATEX pointByCoordinates with a bearing east, and a measure on the
      // opposite side of a flow the location never names.
      const draft = onTwoWay("opposite", { type: "Point", coordinates: [6.81, 51.25001] });
      const closure = (draft["effects"] as Rec[])[1]!;
      await writeSituations(sql, "de-autobahn-events", [
        {
          ...draft,
          effects: [
            { ...closure, direction: { value: "negative", basis: "unknown", text: "opposite" } },
          ],
          location: {
            ...(draft["location"] as Rec),
            direction: { value: "unknown", basis: "bearing", bearingDeg: 90 },
          },
        },
      ]);
      await bindRecords(sql, [id("opposite")], { now });
      // The location's bearing still narrows the situation's own binding ...
      expect(await spans(id("opposite"))).toEqual(["40:f"]);
      // ... but not the measure's, which may lie on either side.
      expect(await binding(id("opposite"), "opposite/closure:2")).toEqual({
        status: "ambiguous",
        direction_mode: "unknown",
        reason: "direction_undecided",
      });
      expect((await spans(id("opposite"), "opposite/closure:2")).sort()).toEqual(["40:b", "40:f"]);
    });

    it("does not read a measure aligned with no stated direction as a drawn line's order", async () => {
      const east = {
        type: "LineString",
        coordinates: [
          [6.805, 51.25001],
          [6.815, 51.25001],
        ],
      };
      const draft = onTwoWay("aligned", east);
      const closure = (draft["effects"] as Rec[])[1]!;
      await writeSituations(sql, "de-autobahn-events", [
        {
          ...draft,
          effects: [
            { ...closure, direction: { value: "positive", basis: "unknown", text: "aligned" } },
          ],
        },
      ]);
      await bindRecords(sql, [id("aligned")], { now });
      expect(await binding(id("aligned"))).toMatchObject({
        status: expect.stringMatching(/^(exact|likely)$/),
        direction_mode: "single",
      });
      expect(await binding(id("aligned"), "aligned/closure:2")).toEqual({
        status: "ambiguous",
        direction_mode: "unknown",
        reason: "direction_undecided",
      });
    });
  });

  describe("a ramp closure", () => {
    // An on-ramp merging into the eastbound A 46 where way 10 starts.
    beforeAll(async () => {
      await sql`INSERT INTO conditions.road_segment (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, computed_at) VALUES
        ('30:f', 30, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(6.795 51.1994, 6.798 51.1998, 6.80 51.2)'),4326), 'motorway_link', NULL, 400, 5, ${NOW})`;
    });
    afterAll(async () => {
      await sql`DELETE FROM conditions.road_segment WHERE way_id = 30`;
    });

    // The ramp, drawn on 200 m along the acceleration lane of way 10.
    const onRamp = (local: string, scope: string) => {
      const draft = situationDraft(local, { subtype: "ramp" });
      const closure = (draft["effects"] as Rec[])[0]!;
      return {
        ...draft,
        effects: [{ ...closure, scope }],
        location: {
          ...(draft["location"] as Rec),
          geometry: {
            type: "LineString",
            coordinates: [
              [6.795, 51.1994],
              [6.798, 51.1998],
              [6.8, 51.2],
              [6.803, 51.2],
            ],
          },
        },
      };
    };

    it("binds its closure on the slip road alone, beside the situation's own path", async () => {
      await writeSituations(sql, "de-autobahn-events", [onRamp("ramp", "ramp")]);
      await bindRecords(sql, [id("ramp")], { now });
      expect(await spans(id("ramp"))).toEqual(["30:f", "10:f"]);
      expect(await spans(id("ramp"), "ramp/closure")).toEqual(["30:f"]);
      expect(await bindings()).toEqual([
        expect.objectContaining({ effect_id: "", status: "likely" }),
        expect.objectContaining({ effect_id: "ramp/closure", status: "likely" }),
      ]);
      expect((await bindRecords(sql, [id("ramp")], { now })).skippedUnchanged).toBe(2);
    });

    it("binds the entry its location says it closes, where the location starts after the merge", async () => {
      // Drawn along way 10 only, from 70 m after ramp 30 merges.
      const afterMerge = (local: string, carriageway?: string) => {
        const draft = onRamp(local, "ramp");
        const location = draft.location as Rec;
        return {
          ...draft,
          location: {
            ...location,
            roads: [{ ref: "A 46", ...(carriageway ? { carriageway } : {}) }],
            geometry: {
              type: "LineString",
              coordinates: [
                [6.801, 51.2],
                [6.806, 51.2],
              ],
            },
          },
        };
      };
      await writeSituations(sql, "de-autobahn-events", [
        afterMerge("entry", "entry"),
        afterMerge("unsaid"),
      ]);
      await bindRecords(sql, [id("entry"), id("unsaid")], { now });
      expect(await spans(id("entry"), "entry/closure")).toEqual(["30:f"]);
      expect(await spans(id("unsaid"), "unsaid/closure")).toEqual([]);
      const own = await sql<{ record_id: string; status: string; reason: string | null }[]>`
        SELECT record_id, status, reason FROM conditions.record_binding
         WHERE record_id IN (${id("entry")}, ${id("unsaid")}) AND effect_id <> '' ORDER BY record_id`;
      expect(own).toEqual([
        { record_id: id("entry"), status: "likely", reason: null },
        { record_id: id("unsaid"), status: "unresolved", reason: "no_slip_road" },
      ]);
    });

    it("drops the closure's own binding once it closes the road", async () => {
      await writeSituations(sql, "de-autobahn-events", [onRamp("widened", "ramp")]);
      await bindRecords(sql, [id("widened")], { now });
      await writeSituations(sql, "de-autobahn-events", [onRamp("widened", "road")]);
      const r = await bindRecords(sql, [id("widened")], { now });
      expect(r.cleared).toBe(1);
      expect(await spans(id("widened"), "widened/closure")).toEqual([]);
      expect(await spans(id("widened"))).toEqual(["30:f", "10:f"]);
    });
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
