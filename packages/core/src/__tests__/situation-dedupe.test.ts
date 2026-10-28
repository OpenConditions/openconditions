import { describe, expect, it } from "vitest";
import { dedupeSituations } from "../situations.js";

type Rec = Record<string, unknown>;
const START = "2026-10-15T08:00:00Z";
const END = "2026-10-15T18:00:00Z";
const point = (lon = 6.81) => ({ type: "Point", coordinates: [lon, 51.2] });
const direction = (value = "positive", basis = "road_reference") => ({ value, basis });
const closure = (id: string): Rec => ({
  id: `${id}/closure`,
  kind: "closure",
  v: 1,
  scope: "road",
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
});
function situation(source: string, local = "a", lon = 6.81): Rec {
  return {
    id: `oc:situation:${source}:${local}`,
    class: "situation",
    domain: "roads",
    kind: "closure",
    type: "closure",
    subtype: "full",
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "major", source: "derived" },
    validity: { status: "active", start: START, end: END },
    location: {
      geometry: point(lon),
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      roads: [{ ref: "A 46" }],
      admin: { country: "DE" },
    },
    effects: [closure(local)],
    details: { kind: "closure", v: 1 },
    provenance: {
      sourceId: source,
      recordId: local,
      attribution: { provider: source, license: "CC0-1.0" },
    },
    freshness: { fetchedAt: START },
  };
}
const location = (r: Rec) => r["location"] as Rec;
const effects = (r: Rec) => r["effects"] as Rec[];
const ids = (records: Rec[]) => records.map((r) => r["id"]);
const retains = (a: Rec, b: Rec) =>
  expect(ids(dedupeSituations([a, b]))).toEqual([a["id"], b["id"]]);

describe("conservative situation deduplication", () => {
  it("retains upstream publisher credits when folding a compatible report", () => {
    const a = situation("one"),
      b = situation("two", "b");
    (b["provenance"] as Rec)["upstream"] = [
      {
        publisher: "Road manager",
        recordId: "original-7",
        attribution: "Road manager / CC-BY-4.0",
        license: "CC-BY-4.0",
      },
    ];
    const [folded] = dedupeSituations([a, b]);
    expect((folded!["provenance"] as Rec)["mergedSources"]).toEqual([
      expect.objectContaining({
        upstream: [
          {
            publisher: "Road manager",
            recordId: "original-7",
            attribution: "Road manager / CC-BY-4.0",
            license: "CC-BY-4.0",
          },
        ],
      }),
    ]);
  });

  it("keeps narrative-only reports separate when no typed effect establishes compatibility", () => {
    const a = situation("one"),
      b = situation("two", "b");
    a["effects"] = [];
    b["effects"] = [];
    a["description"] = [{ lang: "en", text: "A broken-down car" }];
    b["description"] = [{ lang: "en", text: "Spilled load on the opposing carriageway" }];
    retains(a, b);
  });

  it("folds equivalent nearby reports while preserving survivor identity and source attribution", () => {
    const a = situation("one"),
      b = situation("two", "b", 6.8102);
    a["headline"] = [{ lang: "en", text: "Road closed" }];
    b["headline"] = [{ lang: "de", text: "Straße gesperrt" }];
    const before = structuredClone([a, b]);
    const folded = dedupeSituations([a, b]);
    expect(ids(folded)).toEqual(["oc:situation:one:a"]);
    expect((folded[0]!["provenance"] as Rec)["mergedSources"]).toEqual([
      {
        source: "two",
        recordId: "b",
        attribution: { provider: "two", license: "CC0-1.0" },
        link: "same_phenomenon",
      },
    ]);
    expect(folded[0]!["effects"]).toEqual([closure("a")]);
    expect([a, b]).toEqual(before);
  });

  it.each([
    [
      "opposite directions",
      (r: Rec) => {
        location(r)["direction"] = direction("negative");
      },
    ],
    [
      "different reference axes",
      (r: Rec) => {
        location(r)["direction"] = direction("positive", "alert_c");
      },
    ],
    [
      "different carriageways",
      (r: Rec) => {
        location(r)["roads"] = [{ ref: "A46", carriageway: "exit" }];
      },
    ],
    [
      "different roads even below the short distance threshold",
      (r: Rec) => {
        location(r)["roads"] = [{ ref: "B57" }];
      },
    ],
    [
      "different lane scopes",
      (r: Rec) => {
        effects(r)[0]!["laneScope"] = [{ index: 2 }];
      },
    ],
    [
      "different effect scopes",
      (r: Rec) => {
        effects(r)[0]!["scope"] = "ramp";
      },
    ],
    [
      "different vehicles",
      (r: Rec) => {
        effects(r)[0]!["applicability"] = { kind: "classes", include: [{ class: "truck" }] };
      },
    ],
    [
      "different action status",
      (r: Rec) => {
        effects(r)[0]!["actionStatus"] = "requested";
      },
    ],
    [
      "different compliance",
      (r: Rec) => {
        effects(r)[0]!["compliance"] = "advisory";
      },
    ],
    [
      "additional restrictions",
      (r: Rec) => {
        effects(r).push({
          ...closure("speed"),
          kind: "speed_limit",
          limit: { value: 30, unit: "km/h" },
        });
      },
    ],
    [
      "different event validity",
      (r: Rec) => {
        r["validity"] = {
          status: "active",
          start: "2026-10-16T08:00:00Z",
          end: "2026-10-16T18:00:00Z",
        };
      },
    ],
    [
      "different effect validity",
      (r: Rec) => {
        effects(r)[0]!["validity"] = {
          status: "active",
          start: START,
          end: "2026-10-15T12:00:00Z",
        };
      },
    ],
    [
      "different recurrence",
      (r: Rec) => {
        (r["validity"] as Rec)["periods"] = [
          {
            repeatFrequency: "P1D",
            startTime: "08:00",
            duration: "PT4H",
            scheduleTimezone: "Europe/Berlin",
          },
        ];
      },
    ],
    [
      "different subtype",
      (r: Rec) => {
        r["subtype"] = "lane";
      },
    ],
    [
      "different severity",
      (r: Rec) => {
        r["severity"] = { label: "critical", source: "declared" };
      },
    ],
    [
      "different causes",
      (r: Rec) => {
        r["causes"] = [{ type: "infrastructure_failure" }];
      },
    ],
    [
      "different affected selectors",
      (r: Rec) => {
        r["affects"] = {
          features: [{ id: "oc:feature:one:bridge", class: "feature", kind: "structure" }],
        };
      },
    ],
    [
      "different kilometre sections",
      (r: Rec) => {
        location(r)["linear"] = { system: "kilometre_post", ref: "A46", from: 20 };
      },
    ],
    [
      "different effect locations",
      (r: Rec) => {
        effects(r)[0]!["location"] = { geometry: point(6.8101) };
      },
    ],
    [
      "different effect directions",
      (r: Rec) => {
        effects(r)[0]!["direction"] = direction("negative");
      },
    ],
  ])("keeps %s separate", (_name, change) => {
    const a = situation("one"),
      b = situation("two", "b");
    location(a)["direction"] = direction();
    location(b)["direction"] = direction();
    change(b);
    retains(a, b);
  });

  it.each([
    [
      "unknown direction",
      (r: Rec) => {
        location(r)["direction"] = direction("unknown", "text");
      },
    ],
    [
      "unanchored source direction",
      (r: Rec) => {
        location(r)["direction"] = direction("positive", "alert_c");
      },
    ],
    [
      "coarse geometry",
      (r: Rec) => {
        location(r)["fuzziness"] = "low_res";
      },
    ],
    [
      "missing precision",
      (r: Rec) => {
        delete location(r)["fuzziness"];
      },
    ],
    [
      "unknown validity",
      (r: Rec) => {
        (r["validity"] as Rec)["status"] = "unknown";
      },
    ],
    [
      "unknown vehicles",
      (r: Rec) => {
        effects(r)[0]!["applicability"] = { kind: "unknown" };
      },
    ],
    [
      "partial normalization",
      (r: Rec) => {
        effects(r)[0]!["normalization"] = "partial";
      },
    ],
    [
      "unresolved lanes",
      (r: Rec) => {
        effects(r)[0]!["issues"] = [{ code: "unresolved_lane", sourcePath: "lane" }];
      },
    ],
    [
      "unknown effect direction",
      (r: Rec) => {
        effects(r)[0]!["direction"] = direction("unknown", "unknown");
      },
    ],
    [
      "coarse effect location",
      (r: Rec) => {
        effects(r)[0]!["location"] = { fuzziness: "extent_unknown" };
      },
    ],
  ])("does not equate two reports with %s", (_name, change) => {
    const a = situation("one"),
      b = situation("two", "b");
    change(a);
    change(b);
    retains(a, b);
  });

  it("does not mistake equal centroids for equal road extents", () => {
    const a = situation("one"),
      b = situation("two", "b");
    Object.assign(location(a), {
      extent: "linear",
      geometry: {
        type: "LineString",
        coordinates: [
          [6.8, 51.2],
          [6.82, 51.2],
        ],
      },
    });
    Object.assign(location(b), {
      extent: "linear",
      geometry: {
        type: "LineString",
        coordinates: [
          [6.81, 51.19],
          [6.81, 51.21],
        ],
      },
    });
    retains(a, b);
  });

  it("does not equate different numeric restrictions", () => {
    const a = situation("one"),
      b = situation("two", "b");
    a["effects"] = [{ ...closure("a"), kind: "speed_limit", limit: { value: 30, unit: "km/h" } }];
    b["effects"] = [{ ...closure("b"), kind: "speed_limit", limit: { value: 80, unit: "km/h" } }];
    retains(a, b);
  });

  it("ignores effect source IDs and object key order, not effect meaning", () => {
    const a = situation("one"),
      b = situation("two", "b");
    effects(a)[0]!["sourceRecordRef"] = "provider-a";
    effects(b)[0]!["sourceRecordRef"] = "provider-b";
    effects(a)[0]!["source"] = { path: "a/record" };
    effects(b)[0]!["source"] = { path: "b/item" };
    b["effects"] = [Object.fromEntries(Object.entries(effects(b)[0]!).reverse())];
    expect(dedupeSituations([a, b])).toHaveLength(1);
  });

  it("compares effect collections independently of their order", () => {
    const a = situation("one"),
      b = situation("two", "b");
    const speed = { ...closure("speed"), kind: "speed_limit", limit: { value: 30, unit: "km/h" } };
    effects(a).push(speed);
    b["effects"] = [{ ...speed, id: "b/speed" }, closure("b")];
    expect(dedupeSituations([a, b])).toHaveLength(1);
  });

  it("keeps phase-specific restrictions and validity distinct", () => {
    const a = situation("one"),
      b = situation("two", "b");
    for (const r of [a, b])
      Object.assign(r, { kind: "roadworks", type: "works", subtype: "maintenance" });
    a["details"] = {
      kind: "roadworks",
      v: 1,
      phases: [
        { id: "a/p", validity: { status: "planned", start: START }, effects: [closure("a/p")] },
      ],
    };
    b["details"] = {
      kind: "roadworks",
      v: 1,
      phases: [
        { id: "b/p", validity: { status: "planned", start: END }, effects: [closure("b/p")] },
      ],
    };
    retains(a, b);
  });

  it("folds equivalent phase-only effects despite different provider phase and effect IDs", () => {
    const a = situation("one"),
      b = situation("two", "b");
    for (const r of [a, b])
      Object.assign(r, { kind: "roadworks", type: "works", subtype: "maintenance" });
    a["effects"] = [];
    b["effects"] = [];
    a["details"] = {
      kind: "roadworks",
      v: 1,
      phases: [
        { id: "a/p", validity: { status: "planned", start: START }, effects: [closure("a/p")] },
      ],
    };
    b["details"] = {
      kind: "roadworks",
      v: 1,
      phases: [
        { id: "b/p", validity: { status: "planned", start: START }, effects: [closure("b/p")] },
      ],
    };
    expect(dedupeSituations([a, b])).toHaveLength(1);
  });

  it("does not fold a second report of a source through another provider's survivor", () => {
    const a = situation("one"),
      b = situation("two", "b"),
      c = situation("two", "c");
    expect(ids(dedupeSituations([a, b, c]))).toEqual([a["id"], c["id"]]);
  });

  it("requires every member of a cluster to be within the matching distance", () => {
    const a = situation("one"),
      b = situation("two", "b", 6.8109),
      c = situation("three", "c", 6.8091);
    for (const r of [a, b, c]) delete location(r)["roads"];
    expect(ids(dedupeSituations([a, b, c]))).toEqual([a["id"], c["id"]]);
  });

  it("folds nearby points on an identical normalized road within the wider distance gate", () => {
    const a = situation("one"),
      b = situation("two", "b", 6.813);
    location(b)["roads"] = [{ ref: "a46" }];
    expect(dedupeSituations([a, b])).toHaveLength(1);
  });

  it("preserves a different expiry even when every traffic effect agrees", () => {
    const a = situation("one"),
      b = situation("two", "b");
    (a["freshness"] as Rec)["expiresAt"] = END;
    (b["freshness"] as Rec)["expiresAt"] = "2026-10-15T12:00:00Z";
    retains(a, b);
  });

  it("keeps pre-aggregated reports and their source credits intact", () => {
    const a = situation("one"),
      b = situation("two", "b");
    (b["provenance"] as Rec)["mergedSources"] = [
      { source: "third", recordId: "c", attribution: { provider: "Third", license: "CC0-1.0" } },
    ];
    const original = structuredClone(b);
    retains(a, b);
    expect(b).toEqual(original);
  });

  it.each(["road_reference", "alert_c", "openlr"])(
    "folds equivalent directions anchored to the same %s axis",
    (basis) => {
      const a = situation("one"),
        b = situation("two", "b");
      for (const r of [a, b]) {
        location(r)["direction"] = direction("positive", basis);
        if (basis === "alert_c")
          location(r)["tmc"] = { country: "D", table: 1, version: "22.0", code: 100 };
        if (basis === "openlr") location(r)["openlr"] = "CwRbWyNG9RpsCQCbAAY=";
      }
      expect(dedupeSituations([a, b])).toHaveLength(1);
    },
  );

  it("does not equate unknown certainty", () => {
    const a = situation("one"),
      b = situation("two", "b");
    a["certainty"] = "unknown";
    b["certainty"] = "unknown";
    retains(a, b);
  });

  it("preserves same-source and distant records", () => {
    retains(situation("one"), situation("one", "b"));
    retains(situation("one"), situation("two", "b", 7));
  });
});

describe("dedupeSituations of one measure published by two sources", () => {
  // Along Hofmühlenstraße, Dresden: metres east of 13.7°E.
  const line = (from: number, to: number) => ({
    type: "LineString",
    coordinates: [
      [13.7 + from * 0.0000142, 51.03],
      [13.7 + to * 0.0000142, 51.03],
    ],
  });
  const works = (source: string, local: string, geometry: Rec, over: Partial<Rec> = {}): Rec => ({
    ...situation(source, local),
    kind: "roadworks",
    type: "works",
    subtype: undefined,
    certainty: "unknown",
    effects: [],
    headline: [{ lang: "und", text: "Verlegung 110 KV - Leitungsbau" }],
    validity: { status: "active", start: "2026-10-05T22:00:00Z", end: "2026-11-13T23:00:00Z" },
    location: {
      geometry,
      extent: "linear",
      geometryOrigin: "source",
      fuzziness: "exact",
      roads: [],
    },
    ...over,
  });
  const state = works("de-sn-list-events", "DRESDEN25/10/114", line(0, 300));

  it("folds the city's record into the state's covering one, keeping the city's attribution", () => {
    const city = works("de-sn-dresden-events", "1147", line(0, 280), {
      kind: "closure",
      type: "closure",
      headline: [{ lang: "und", text: "Vollsperrung" }],
      validity: { status: "active", start: "2026-10-05T22:00:00Z", end: "2026-11-13T22:59:00Z" },
    });
    for (const order of [
      [city, state],
      [state, city],
    ]) {
      const [folded, ...rest] = dedupeSituations(order);
      expect(rest).toEqual([]);
      expect(folded!["id"]).toBe(state["id"]);
      expect((folded!["provenance"] as Rec)["mergedSources"]).toEqual([
        {
          source: "de-sn-dresden-events",
          recordId: "1147",
          attribution: { provider: "de-sn-dresden-events", license: "CC0-1.0" },
          link: "same_phenomenon",
        },
      ]);
    }
  });

  it("keeps a short element inside a long record of the same works", () => {
    retains(state, works("de-autobahn-events", "ramp", line(10, 60)));
  });

  it("folds differing dates only with one end agreeing and the headlines too", () => {
    const later = { status: "active", start: "2026-10-19T22:00:00Z", end: "2026-11-13T23:00:00Z" };
    expect(
      dedupeSituations([
        state,
        works("de-sn-dresden-events", "x", line(0, 290), { validity: later }),
      ]),
    ).toHaveLength(1);
    retains(
      state,
      works("de-sn-dresden-events", "y", line(0, 290), {
        validity: later,
        headline: [{ lang: "und", text: "Kanalreinigung" }],
      }),
    );
  });

  it("keeps records of other kinds, without dates, or both stating effects", () => {
    retains(
      state,
      works("de-sn-dresden-events", "c", line(0, 300), { kind: "congestion", type: "congestion" }),
    );
    retains(
      state,
      works("de-sn-dresden-events", "d", line(0, 300), { validity: { status: "active" } }),
    );
    retains(
      { ...state, effects: [closure("s")] },
      works("de-sn-dresden-events", "e", line(0, 300), { effects: [closure("e")] }),
    );
  });

  it("keeps the record carrying restriction evidence", () => {
    const lanes = { ...closure("m"), normalization: "partial" };
    const motorway = works("de-autobahn-events", "m", line(0, 290), { effects: [lanes] });
    const [folded, ...rest] = dedupeSituations([state, motorway]);
    expect(rest).toEqual([]);
    expect(folded!["id"]).toBe(motorway["id"]);
  });
});
