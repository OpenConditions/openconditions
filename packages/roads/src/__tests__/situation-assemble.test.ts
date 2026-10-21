import { buildRegistry, kernelModule } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import type { RoadEvent } from "../model.js";
import { type SituationDraft, situationDrafts } from "../situation/assemble.js";
import type { SourceDescriptor } from "../types.js";
import { restrictionEvent } from "./fixtures/restriction-event.js";

const registry = buildRegistry([kernelModule, roadsModule]);
const SRC: SourceDescriptor = {
  id: "nl-ndw-events",
  attribution: "NDW",
  country: "NL",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
};

function event(id: string, over: Partial<RoadEvent> = {}): RoadEvent {
  return {
    id: `nl-ndw-events:${id}`,
    source: "nl-ndw-events",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    type: "accident",
    category: "incident",
    isPlanned: false,
    severity: "unknown",
    severitySource: "derived",
    headline: "Ongeval",
    status: "active",
    geometry: { type: "Point", coordinates: [4.9, 52.37] },
    roads: [{ name: "A2", ref: "A2" }],
    validFrom: "2026-09-18T08:00:00Z",
    origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-09-18T08:00:00Z",
    fetchedAt: "2026-09-18T10:00:00.000Z",
    isStale: false,
    ...over,
  };
}

const cls = (kind: string, type: string, subtype?: string, causes?: string[]) => ({
  classification: { kind, type, ...(subtype ? { subtype } : {}), ...(causes ? { causes } : {}) },
});

function assemble(events: RoadEvent[]): SituationDraft[] {
  const drafts = situationDrafts(events, { source: SRC });
  for (const d of drafts) {
    const checked = registry.validateDraft(d);
    expect(checked.ok ? [] : checked.issues, String(d["id"])).toEqual([]);
  }
  return drafts;
}

const effects = (d: SituationDraft) => d["effects"] as Record<string, unknown>[];

describe("situationDrafts — source values the model cannot hold", () => {
  it("drops a time past the clock or the year 9999, and completes one without seconds", () => {
    const [d] = assemble([
      event("T1", {
        validFrom: "2026-10-20T10:00Z",
        validTo: "+012026-10-20T10:00:00Z",
        situation: { sourceUpdatedAt: "2026-10-20T25:00:00Z" },
      }),
    ]);
    expect(d!["validity"]).toMatchObject({ start: "2026-10-20T10:00:00.000Z" });
    expect(d!["validity"]).not.toHaveProperty("end");
    expect(d!["provenance"]).not.toHaveProperty("sourceUpdatedAt");
  });

  it("encodes a line break in a source's record id", () => {
    const [d] = assemble([event(`a\nb${String.fromCharCode(0x2028)}c`)]);
    expect(d!["id"]).toBe("oc:situation:nl-ndw-events:a%0Ab%E2%80%A8c");
  });

  it("leaves out a period whose bound is neither an instant nor a date", () => {
    const [d] = assemble([
      event("P1", {
        schedule: [
          {
            scheduleTimezone: "Europe/Amsterdam",
            startDate: "!",
            startTime: "22:00",
            repeatFrequency: "P1D",
          },
        ],
      }),
    ]);
    expect(d!["validity"]).not.toHaveProperty("periods");
  });

  it("leaves out lane counts that are no whole numbers, and a limit too large to convert", () => {
    const [d] = assemble([
      event("L1", {
        lanesAffected: { closed: 5e-324, total: Number.NaN },
        restrictions: [{ type: "weight", value: 1e308, unit: "t" }],
      }),
    ]);
    const lanes = effects(d!).find((e) => e["kind"] === "lane_restriction")!;
    expect(lanes).not.toHaveProperty("lanesClosed");
    expect(lanes).not.toHaveProperty("lanesTotal");
    expect(effects(d!)).toContainEqual(expect.objectContaining({ kind: "unsupported" }));
  });
});

describe("situationDrafts — closures except for local access", () => {
  it("closes the road to all but local access when the text says so", () => {
    const [d] = assemble([
      event("L1", {
        type: "road_closure",
        roadState: "closed",
        headline: "Vollsperrung",
        description: "Leitungsbau, Anlieger frei",
        speedLimitKph: 30,
      }),
    ]);
    const [closure, limit] = effects(d!);
    expect(closure).toMatchObject({
      kind: "closure",
      applicability: { kind: "all", except: [{ usage: "local_access" }], raw: ["Anlieger frei"] },
    });
    expect(limit).toMatchObject({ kind: "speed_limit", applicability: { kind: "all" } });
  });

  it("reads WZDx local-access-only as a closure open to local access", () => {
    const [d] = assemble([
      event("L2", {
        sourceFormat: "wzdx",
        type: "road_closure",
        roadState: "closed",
        restrictions: [{ type: "local-access-only" }],
      }),
    ]);
    expect(effects(d!).find((e) => e["kind"] === "closure")).toMatchObject({
      applicability: { kind: "all", except: [{ usage: "local_access" }] },
    });
  });

  it("leaves a closure that names its vehicles as it is", () => {
    const [d] = assemble([
      event("L3", {
        type: "road_closure",
        roadState: "closed",
        vehiclesAffected: ["trucks"],
        description: "Anlieger frei",
      }),
    ]);
    expect(effects(d!)[0]!["applicability"]).not.toHaveProperty("except");
  });
});

describe("situationDrafts — DATEX situations", () => {
  it("folds a situation's records into one situation with record-scoped effects", () => {
    const [d] = assemble([
      event("R1", { situationId: "S1", situation: cls("incident", "accident") }),
      event("R2", {
        situationId: "S1",
        type: "lane_closure",
        situation: cls("closure", "closure", "lane"),
        lanesAffected: { total: 3, closed: 1 },
        validTo: "2026-09-18T12:00:00Z",
      }),
    ]);
    expect(d).toMatchObject({
      id: "oc:situation:nl-ndw-events:S1",
      kind: "incident",
      type: "accident",
    });
    expect(effects(d!)).toEqual([
      expect.objectContaining({
        id: "R2/lane_restriction",
        sourceRecordRef: "R2",
        lanesTotal: 3,
        lanesClosed: 1,
        vehicleImpact: "some_lanes_closed",
        validity: { status: "active", start: "2026-09-18T08:00:00Z", end: "2026-09-18T12:00:00Z" },
      }),
    ]);
    // One of three lanes closed reaches the one-third share: the lane rule says moderate.
    expect(d!["severity"]).toEqual({ label: "moderate", source: "derived" });
  });

  it("assembles the same situation whichever order the publisher lists its records in", () => {
    const records = [
      event("28493712", {
        situationId: "S9",
        type: "lane_closure",
        situation: cls("closure", "closure", "lane"),
        geometry: { type: "Point", coordinates: [-5.6313, 36.5565] },
        relatedIds: ["S9.3", "S9.1"],
      }),
      event("28493713", {
        situationId: "S9",
        type: "lane_closure",
        situation: cls("closure", "closure", "lane"),
        geometry: { type: "Point", coordinates: [-5.6454, 36.5381] },
        relatedIds: ["S9.1", "S9.3"],
      }),
    ];
    const listed = assemble(records);
    expect(assemble([...records].reverse())).toEqual(listed);
    expect(listed[0]!["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [-5.6313, 36.5565] },
    });
    expect(effects(listed[0]!).map((e) => e["sourceRecordRef"])).toEqual(["28493712", "28493713"]);
    expect((listed[0]!["relations"] as { ref: { id: string } }[]).map((r) => r.ref.id)).toEqual([
      "oc:situation:nl-ndw-events:S9.1",
      "oc:situation:nl-ndw-events:S9.3",
    ]);
  });

  it("splits records of different natures and links them by groupId", () => {
    const drafts = assemble([
      event("R1", { situationId: "S2", situation: cls("incident", "accident") }),
      event("R2", { situationId: "S2", type: "hazard", situation: cls("incident", "fire") }),
    ]);
    expect(drafts.map((d) => [d["id"], d["type"], d["groupId"]])).toEqual([
      ["oc:situation:nl-ndw-events:R1", "accident", "S2"],
      ["oc:situation:nl-ndw-events:R2", "fire", "S2"],
    ]);
  });

  it("names a situation of management records alone by its most restrictive record", () => {
    const records = [
      event("M1_SPEED_MANAGEMENT", {
        situationId: "S7",
        type: "speed_restriction",
        speedLimitKph: 70,
        situation: cls("restriction", "speed", "temporary"),
      }),
      event("M1_CLOSED_LANES", {
        situationId: "S7",
        type: "lane_closure",
        situation: cls("closure", "closure", "lane"),
      }),
      event("M1_DISPLACEMENT", { situationId: "S7", situation: cls("other", "other") }),
    ];
    for (const listed of [records, [...records].reverse()]) {
      const [d] = assemble(listed);
      expect(d).toMatchObject({ kind: "closure", type: "closure", subtype: "lane" });
    }
    const [speed] = assemble([records[2]!, records[0]!]);
    expect(speed).toMatchObject({ kind: "restriction", type: "speed", subtype: "temporary" });
  });

  it("takes the nature from the stated cause when only management records exist", () => {
    const [works] = assemble([
      event("R1", {
        situationId: "S3",
        type: "lane_closure",
        isPlanned: true,
        situation: cls("closure", "closure", "lane", ["maintenance"]),
      }),
    ]);
    expect(works).toMatchObject({
      kind: "roadworks",
      type: "works",
      subtype: "maintenance",
      causes: [{ type: "maintenance" }],
    });
    expect(effects(works!).map((e) => e["kind"])).toEqual(["lane_restriction"]);

    const [speed] = assemble([
      event("R4", {
        situationId: "S4",
        type: "speed_restriction",
        speedLimitKph: 70,
        situation: cls("restriction", "speed", "temporary"),
      }),
    ]);
    expect(speed).toMatchObject({ kind: "restriction", type: "speed", subtype: "temporary" });
  });

  it("does not turn a lane-management record that opens a lane into a closure", () => {
    const [d] = assemble([
      event("R1", { situationId: "S5", type: "lane_closure", situation: cls("other", "other") }),
    ]);
    expect(d).toMatchObject({ kind: "other", type: "other" });
    expect(effects(d!)).toEqual([]);
  });
});

describe("situationDrafts — detours", () => {
  const detour = (related: string) =>
    event("D1", {
      sourceFormat: "wzdx",
      type: "detour",
      headline: "Detour via Main St",
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [0, 1],
        ],
      },
      relatedEvents: [{ id: related, type: "related-work-zone" }],
    });

  it("attaches a detour to its work zone when the snapshot holds it", () => {
    const drafts = assemble([
      event("W1", {
        sourceFormat: "wzdx",
        type: "roadworks",
        situation: cls("roadworks", "works"),
      }),
      detour("W1"),
    ]);
    expect(drafts).toHaveLength(1);
    expect(effects(drafts[0]!)).toEqual([
      expect.objectContaining({ id: "D1/detour", kind: "detour", compliance: "advisory" }),
    ]);
  });

  it("synthesises a derived closure situation for a detour without its parent", () => {
    const [d] = assemble([detour("gone")]);
    expect(d).toMatchObject({ kind: "closure", type: "closure" });
    expect((d!["provenance"] as { origin: string }).origin).toBe("derived");
    expect(effects(d!).map((e) => e["kind"])).toEqual(["detour"]);
  });
});

describe("situationDrafts — flow-derived congestion", () => {
  it("marks congestion computed from a site's readings as derived from that site", () => {
    const [d] = assemble([
      event("S4:congestion", {
        type: "congestion",
        category: "conditions",
        headline: "Traffic congestion (S4)",
        situation: {
          classification: { kind: "congestion", type: "congestion", subtype: "stationary" },
          headlineFromSource: false,
          derivedFromSite: "S4",
        },
      }),
    ]);
    const site = { class: "feature", id: "oc:feature:nl-ndw-events:S4" };
    expect(d!["headline"]).toBeUndefined();
    expect(d!["provenance"]).toMatchObject({
      origin: "derived",
      derivedFrom: { records: [site], method: "los_threshold", version: "1" },
    });
    expect(d!["details"]).toMatchObject({
      kind: "congestion",
      los: "stationary",
      derivedFrom: site,
    });
  });
});

describe("situationDrafts — fields", () => {
  it("keeps a declared severity and never invents a headline or update time", () => {
    const [d] = assemble([
      event("R1", {
        severity: "high",
        severitySource: "declared",
        situation: { headlineFromSource: false },
      }),
    ]);
    expect(d!["severity"]).toEqual({ label: "major", source: "declared" });
    expect(d!["headline"]).toBeUndefined();
    expect((d!["provenance"] as Record<string, unknown>)["sourceUpdatedAt"]).toBeUndefined();
  });

  it("names a road in the language its source states, or every one it gave", () => {
    const names = [
      { lang: "fr", text: "Boulevard du Jardin Botanique" },
      { lang: "nl", text: "Kruidtuinlaan" },
    ];
    const [d] = assemble([
      event("R1", {
        roads: [
          { name: "Hauptstraße", nameLang: "de", ref: "B1" },
          { name: "A2" },
          { name: names[0]!.text, nameLang: "fr", names },
          { ref: "N1" },
        ],
      }),
    ]);
    expect((d!["location"] as Record<string, unknown>)["roads"]).toEqual([
      { name: [{ lang: "de", text: "Hauptstraße" }], ref: "B1" },
      { name: [{ lang: "und", text: "A2" }] },
      { name: names },
      { ref: "N1" },
    ]);
  });

  it("lets the restriction contract decide the vehicles of a closure", () => {
    const [d] = situationDrafts([{ ...restrictionEvent(), roadState: "closed" }], {
      source: { ...SRC, id: "fi-digitraffic-events", country: "FI" },
    });
    expect(registry.validateDraft(d).ok).toBe(true);
    const kinds = effects(d!).map((e) => e["kind"]);
    expect(kinds).not.toContain("closure");
    const phases = (d!["details"] as { phases?: { effects: unknown[] }[] }).phases;
    expect(phases?.[0]?.effects).toEqual([
      expect.objectContaining({ kind: "dimension_limit", value: { value: 26000, unit: "kg" } }),
    ]);
  });

  it("keeps a legacy restriction as partial evidence, converted to canonical units", () => {
    const [d] = assemble([
      event("R1", {
        restrictions: [
          { type: "weight", value: 7.5, unit: "t" },
          { type: "height", value: 4, unit: "tons" },
        ],
      }),
    ]);
    expect(effects(d!)).toEqual([
      expect.objectContaining({
        kind: "dimension_limit",
        dimension: "gross_weight",
        value: { value: 7500, unit: "kg" },
        normalization: "partial",
      }),
      expect.objectContaining({ kind: "unsupported", normalization: "unsupported" }),
    ]);
  });

  it("reads DATEX period bounds as local dates and splits a table number with its edition", () => {
    const [d] = assemble([
      event("R1", {
        schedule: [
          {
            scheduleTimezone: "Europe/Amsterdam",
            startDate: "2026-09-19T22:00:00Z",
            endDate: "2026-09-21T03:00:00Z",
            startTime: "22:00",
            endTime: "05:00",
            repeatFrequency: "P1D",
          },
        ],
        externalRefs: { tmc: { country: "8", table: 6.13, code: 1234 } },
      }),
    ]);
    const validity = d!["validity"] as { periods: { startDate: string; endDate: string }[] };
    expect(validity.periods[0]).toMatchObject({ startDate: "2026-09-20", endDate: "2026-09-21" });
    expect((d!["location"] as { tmc: unknown }).tmc).toEqual({
      country: "8",
      table: 6,
      version: "6.13",
      code: 1234,
    });
  });
});

describe("situationDrafts — what the source said", () => {
  it("reads a one-off DATEX period as its exact window", () => {
    const [d] = assemble([
      event("R1", {
        schedule: [
          {
            scheduleTimezone: "Europe/Amsterdam",
            startDate: "2026-10-05T18:00:00Z",
            endDate: "2026-10-08T03:00:00Z",
            repeatFrequency: "P1D",
          },
        ],
      }),
    ]);
    expect((d!["validity"] as { periods: unknown[] }).periods).toEqual([
      {
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        startTime: "20:00:00",
        duration: "P2DT9H",
        scheduleTimezone: "Europe/Amsterdam",
      },
    ]);
  });

  it("keeps every language the source wrote its texts in", () => {
    const headline = [
      { lang: "nl", text: "Ongeval" },
      { lang: "en", text: "Accident" },
    ];
    const description = [{ lang: "nl", text: "Twee voertuigen" }];
    const comments = [{ type: "public" as const, text: [{ lang: "en", text: "Expect delays" }] }];
    const [d] = assemble([event("R1", { situation: { headline, description, comments } })]);
    expect(d).toMatchObject({ headline, description, comments });
  });

  it("keeps the severity token the source declared", () => {
    const [d] = assemble([
      event("R1", {
        severity: "critical",
        severitySource: "declared",
        situation: { severityRaw: "highest" },
      }),
    ]);
    expect(d!["severity"]).toEqual({
      label: "critical",
      source: "declared",
      declaredRaw: "highest",
    });
  });

  it("keeps a suspended situation suspended rather than ended", () => {
    const [d] = assemble([
      event("R1", { status: "inactive", situation: { validityStatus: "suspended" } }),
    ]);
    expect((d!["validity"] as { status: string }).status).toBe("suspended");
  });
});

describe("situationDrafts — access mode", () => {
  it("records the source's access mode, bulk unless it says otherwise", () => {
    const bulk = situationDrafts([event("A")], { source: SRC })[0]!;
    expect((bulk["provenance"] as { accessMode: string }).accessMode).toBe("bulk");
    const onDemand = situationDrafts([event("A")], {
      source: { ...SRC, accessMode: "on_demand" },
    })[0]!;
    expect((onDemand["provenance"] as { accessMode: string }).accessMode).toBe("on_demand");
  });
});

describe("grouped location precision", () => {
  it.each([true, false])(
    "preserves coarse member precision/provenance even when geometry is the same: %s",
    (sameGeometry) => {
      const geometry = { type: "Point" as const, coordinates: [4.9, 52.37] };
      const drafts = assemble([
        event("nature", {
          situationId: "precision",
          type: "roadworks",
          situation: cls("roadworks", "works", "maintenance"),
          geometry,
        }),
        event("coarse", {
          situationId: "precision",
          type: "road_closure",
          roadState: "closed",
          situation: cls("closure", "closure", "full"),
          geometry: sameGeometry ? geometry : { type: "Point", coordinates: [5.7, 50.8] },
          fuzziness: "low_res",
          locationTable: { ref: "VILD", version: "6.13.A", license: "CC0-1.0" },
        }),
      ]);
      const closure = effects(drafts[0]!).find((e) => e["kind"] === "closure")!;
      expect(closure["location"]).toMatchObject({
        fuzziness: "low_res",
        geometryOrigin: "tmc_table",
        locationTable: { ref: "VILD", version: "6.13.A" },
      });
    },
  );
});
