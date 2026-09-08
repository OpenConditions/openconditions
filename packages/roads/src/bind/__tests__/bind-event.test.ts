import { describe, expect, it } from "vitest";
import { bindEvent, toBindInput } from "../bind-event.js";
import { projectOntoPolyline } from "../geo.js";
import type { SpineSegment, SpineSubgraph } from "../types.js";

const offsetTo = (s: SpineSegment, p: [number, number]): number =>
  projectOntoPolyline(p, s.coords).offsetM;

function seg(
  id: string,
  coords: [number, number][],
  opts: Partial<SpineSegment> = {}
): SpineSegment {
  const [wayId, dir] = id.split(":");
  return {
    segmentId: id,
    wayId: Number(wayId),
    dir: dir as "f" | "b",
    highway: "motorway",
    ref: "A 46",
    coords,
    lengthM: 0,
    ...opts,
  };
}

// A dual carriageway: eastbound ways 10,11,12 (oneway, f only) at lat 51.2000,
// westbound ways 20,21,22 at lat 51.2003 (~33 m north), digitised west-bound.
const E = [
  seg("10:f", [
    [6.8, 51.2],
    [6.81, 51.2],
  ]),
  seg("11:f", [
    [6.81, 51.2],
    [6.82, 51.2],
  ]),
  seg("12:f", [
    [6.82, 51.2],
    [6.83, 51.2],
  ]),
];
const W = [
  seg("22:f", [
    [6.83, 51.2003],
    [6.82, 51.2003],
  ]),
  seg("21:f", [
    [6.82, 51.2003],
    [6.81, 51.2003],
  ]),
  seg("20:f", [
    [6.81, 51.2003],
    [6.8, 51.2003],
  ]),
];
// A parallel bidirectional Bundesstraße 300 m south, both directions.
const B = [
  seg(
    "30:f",
    [
      [6.8, 51.197],
      [6.83, 51.197],
    ],
    { highway: "primary", ref: "B 9" }
  ),
  seg(
    "30:b",
    [
      [6.83, 51.197],
      [6.8, 51.197],
    ],
    { highway: "primary", ref: "B 9" }
  ),
];
// A different road 22 m north of the Bundesstraße: same class, same heading,
// so only the stated ref tells the two apart.
const L = [
  seg(
    "40:f",
    [
      [6.8, 51.1974],
      [6.83, 51.1974],
    ],
    { highway: "primary", ref: "L 137" }
  ),
];
for (const s of [...E, ...W, ...B, ...L])
  s.lengthM = 700 * (s.coords.length - 1) * (/^(30|40)/.test(s.segmentId) ? 3 : 1);
const spine: SpineSubgraph = { segments: [...E, ...W, ...B, ...L] };

/** Two consecutive ways of one isolated carriageway, meeting at a node. */
const chain: SpineSubgraph = {
  segments: [
    seg("50:f", [
      [7.0, 51.0],
      [7.01, 51.0],
    ]),
    seg("51:f", [
      [7.01, 51.0],
      [7.02, 51.0],
    ]),
  ],
};
/** Two parallel same-heading roads 30 m apart: the bearing cannot separate them. */
const parallel: SpineSubgraph = {
  segments: [
    seg("60:f", [
      [7.0, 51.0],
      [7.02, 51.0],
    ]),
    seg("61:f", [
      [7.0, 51.00027],
      [7.02, 51.00027],
    ]),
  ],
};
/** The `parallel` fixture again, but the neighbouring road carries another ref. */
const parallelOtherRef: SpineSubgraph = {
  segments: [
    seg("80:f", [
      [7.0, 51.0],
      [7.02, 51.0],
    ]),
    seg(
      "81:f",
      [
        [7.0, 51.00027],
        [7.02, 51.00027],
      ],
      { ref: "L 5" }
    ),
  ],
};
/** Two roads 30 m apart carrying different refs, for events sampled midway. */
const midway: SpineSubgraph = {
  segments: [
    seg("90:f", [
      [7.0, 51.0],
      [7.02, 51.0],
    ]),
    seg(
      "91:f",
      [
        [7.0, 51.00027],
        [7.02, 51.00027],
      ],
      { ref: "L 5" }
    ),
  ],
};
/** The same pair, with the neighbouring road carrying no ref at all. */
const midwayRefless: SpineSubgraph = {
  segments: [
    seg("90:f", [
      [7.0, 51.0],
      [7.02, 51.0],
    ]),
    seg(
      "91:f",
      [
        [7.0, 51.00027],
        [7.02, 51.00027],
      ],
      { ref: null }
    ),
  ],
};
/**
 * A strong rival heading 44° away, plus a short parallel stub that is weaker
 * everywhere and only in reach of samples the angled rival also covers.
 */
const masked: SpineSubgraph = {
  segments: [
    seg("72:f", [
      [7.0, 51.0],
      [7.02, 51.0],
    ]),
    seg("73:f", [
      [7.01, 51.0001],
      [7.0105, 51.0004],
    ]),
    seg("74:f", [
      [7.009857, 51.00033],
      [7.010143, 51.00033],
    ]),
  ],
};
/**
 * The same idea spread out: the angled rival is strongest near one end of the
 * event and the parallel stub only reaches samples near the other end.
 */
const maskedAcross: SpineSubgraph = {
  segments: [
    seg("82:f", [
      [7.0, 51.0],
      [7.02, 51.0],
    ]),
    seg("83:f", [
      [7.008, 51.0001],
      [7.0085, 51.0004],
    ]),
    seg("84:f", [
      [7.0117, 51.00033],
      [7.0123, 51.00033],
    ]),
  ],
};
/** A rival 21 m away but heading 45° off, which the bearing separates cleanly. */
const angled: SpineSubgraph = {
  segments: [
    seg("70:f", [
      [7.0, 51.0],
      [7.02, 51.0],
    ]),
    seg("71:f", [
      [7.01, 51.0002],
      [7.0105, 51.0005],
    ]),
  ],
};
for (const s of [
  ...chain.segments,
  ...parallel.segments,
  ...parallelOtherRef.segments,
  ...midway.segments,
  ...midwayRefless.segments,
  ...masked.segments,
  ...maskedAcross.segments,
  ...angled.segments,
])
  s.lengthM = 700;

describe("bindEvent", () => {
  it("binds an eastbound LineString closure to the eastbound carriageway only, with fractions", () => {
    const r = bindEvent(
      toBindInput({
        id: "e1",
        type: "road_closure",
        roads: [{ name: "A46", ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [6.805, 51.20001],
            [6.815, 51.20001],
            [6.825, 51.20001],
          ],
        },
      }),
      spine
    );
    expect(r.status).toBe("exact");
    expect(r.directionMode).toBe("single");
    expect(r.segments.map((s) => s.segmentId)).toEqual(["10:f", "11:f", "12:f"]);
    expect(r.segments[0]!.startFraction).toBeCloseTo(0.5, 1);
    expect(r.segments[0]!.endFraction).toBe(1);
    expect(r.segments[2]!.startFraction).toBe(0);
    expect(r.segments[2]!.endFraction).toBeCloseTo(0.5, 1);
  });

  it("binds a westbound line to the westbound carriageway (bearing decides, not distance)", () => {
    const r = bindEvent(
      toBindInput({
        id: "w1",
        type: "roadworks",
        roads: [{ name: "A46", ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [6.825, 51.20005],
            [6.815, 51.20005],
            [6.805, 51.20005],
          ],
        },
      }),
      spine
    );
    // The wrong carriageway is the nearer one here, so only the heading can
    // explain the answer.
    const mid: [number, number] = [6.815, 51.20005];
    expect(offsetTo(E[1]!, mid)).toBeLessThan(offsetTo(W[1]!, mid));
    expect(offsetTo(W[1]!, mid)).toBeLessThan(40);
    expect(r.segments.map((s) => s.segmentId)).toEqual(["22:f", "21:f", "20:f"]);
  });

  it("reconstructs the path between DATEX endpoint pairs along the matching ref", () => {
    const r = bindEvent(
      toBindInput({
        id: "mp",
        type: "road_closure",
        roads: [{ name: "A46", ref: "A 46" }],
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [6.802, 51.20001],
            [6.828, 51.20001],
          ],
        },
      }),
      spine
    );
    expect(r.segments.map((s) => s.segmentId)).toEqual(["10:f", "11:f", "12:f"]);
    expect(["exact", "likely"]).toContain(r.status);
  });

  it("a point on a bidirectional way binds both directions", () => {
    const r = bindEvent(
      toBindInput({
        id: "p",
        type: "accident",
        roads: [{ name: "B9", ref: "B 9" }],
        geometry: { type: "Point", coordinates: [6.815, 51.19701] },
      }),
      spine
    );
    expect(r.directionMode).toBe("both");
    expect(r.segments.map((s) => s.segmentId).sort()).toEqual(["30:b", "30:f"]);
    expect(r.segments[0]!.startFraction).toBeCloseTo(r.segments[0]!.endFraction, 5);
  });

  it("a point on a dual carriageway is ambiguous with direction unknown", () => {
    const r = bindEvent(
      toBindInput({
        id: "p2",
        type: "hazard",
        roads: [{ name: "A46", ref: "A 46" }],
        geometry: { type: "Point", coordinates: [6.815, 51.20015] },
      }),
      spine
    );
    expect(r.status).toBe("ambiguous");
    expect(r.directionMode).toBe("unknown");
    expect(r.segments).toHaveLength(1);
    expect(r.confidence).toBeLessThan(0.7);
  });

  it("polygon geometry and area types are not_applicable; far-away events are unresolved", () => {
    expect(
      bindEvent(
        toBindInput({
          id: "poly",
          type: "road_closure",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [6.8, 51.2],
                [6.81, 51.2],
                [6.81, 51.21],
                [6.8, 51.2],
              ],
            ],
          },
        }),
        spine
      ).status
    ).toBe("not_applicable");
    expect(
      bindEvent(
        toBindInput({
          id: "wx",
          type: "weather",
          geometry: { type: "Point", coordinates: [6.815, 51.2] },
        }),
        spine
      ).status
    ).toBe("not_applicable");
    const far = bindEvent(
      toBindInput({
        id: "far",
        type: "road_closure",
        geometry: { type: "Point", coordinates: [7.5, 51.5] },
      }),
      spine
    );
    expect(far.status).toBe("unresolved");
    expect(far.reason).toBe("no_candidates");
  });

  it("a stated ref mismatch loses to the matching road", () => {
    const r = bindEvent(
      toBindInput({
        id: "ref",
        type: "roadworks",
        roads: [{ name: "B9", ref: "B 9" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [6.805, 51.1972],
            [6.825, 51.1972],
          ],
        },
      }),
      spine
    );
    // Both roads sit 22 m away with the same class and heading, so the ref is
    // the only thing between them.
    const mid: [number, number] = [6.815, 51.1972];
    expect(offsetTo(B[0]!, mid)).toBeCloseTo(offsetTo(L[0]!, mid), 1);
    expect(offsetTo(L[0]!, mid)).toBeLessThan(40);
    expect(r.segments.every((s) => s.wayId === 30)).toBe(true);
    // A road with another ref is not a competing carriageway, so the loss of
    // the ref term is the whole penalty and the direction stays decided.
    expect(r.debug.ambiguity).toBe(0);
    expect(r.directionMode).toBe("single");
    expect(r.alternativeConfidence).toBeNull();
    expect(r.status).toBe("likely");
    expect(r.confidence).toBeGreaterThan(0.69);
  });

  it("a node shared by two consecutive path segments creates no ambiguity", () => {
    const r = bindEvent(
      toBindInput({
        id: "node",
        type: "road_closure",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [6.805, 51.20001],
            [6.825, 51.20001],
          ],
        },
      }),
      spine
    );
    const atNode = r.debug.samples.filter(
      (s) =>
        s.candidates.filter((c) => r.segments.some((x) => x.segmentId === c.segment.segmentId))
          .length > 1
    );
    expect(atNode.length).toBeGreaterThan(0);
    expect(r.debug.ambiguity).toBe(0);
    expect(r.status).toBe("exact");
    expect(r.alternativeConfidence).toBeNull();
  });

  it("reports alternativeConfidence as ambiguity times confidence", () => {
    const r = bindEvent(
      toBindInput({
        id: "alt",
        type: "hazard",
        roads: [{ ref: "A 46" }],
        geometry: { type: "Point", coordinates: [6.815, 51.20015] },
      }),
      spine
    );
    expect(r.debug.ambiguity).toBeCloseTo(1, 5);
    expect(r.alternativeConfidence).toBeCloseTo(r.debug.ambiguity! * r.confidence!, 10);
    expect(r.alternativeConfidence).toBeCloseTo(0.69, 5);
  });

  it("scores an endpoint pair on the ends of the winning path, not the best candidates", () => {
    const r = bindEvent(
      toBindInput({
        id: "mp2",
        type: "road_closure",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [6.802, 51.20001],
            [6.828, 51.20031],
          ],
        },
      }),
      spine
    );
    // The end point is 1.1 m from the westbound carriageway but 34.5 m from
    // the eastbound one the reconstructed path actually runs along.
    expect(r.segments.map((s) => s.segmentId)).toEqual(["10:f", "11:f", "12:f"]);
    expect(r.debug.meanOffsetM).toBeCloseTo(17.8, 0);
    expect(r.confidence).toBeCloseTo(0.911, 2);
  });

  it("treats the next way of the same carriageway as a continuation, not a rival", () => {
    const r = bindEvent(
      toBindInput({
        id: "adj",
        type: "accident",
        roads: [{ ref: "A 46" }],
        geometry: { type: "Point", coordinates: [7.01, 51.00001] },
      }),
      chain
    );
    expect(r.debug.samples[0]!.candidates).toHaveLength(2);
    expect(r.directionMode).toBe("single");
    expect(r.debug.ambiguity).toBe(0);
    expect(r.status).toBe("exact");
  });

  it("still calls the opposite carriageway a rival at a node between two ways", () => {
    const r = bindEvent(
      toBindInput({
        id: "adj2",
        type: "accident",
        roads: [{ ref: "A 46" }],
        geometry: { type: "Point", coordinates: [6.81, 51.20001] },
      }),
      spine
    );
    // Ways 10 and 11 meet here, but the westbound carriageway is 32 m away
    // and shares no node, so the side of the road stays undecided.
    expect(r.directionMode).toBe("unknown");
    expect(r.confidence).toBeLessThanOrEqual(0.69);
  });

  it("a line too short to have a bearing is as undecided as the same point", () => {
    const geometries = [
      {
        type: "LineString" as const,
        coordinates: [
          [6.815, 51.20015],
          [6.8151, 51.20015],
        ],
      },
      { type: "Point" as const, coordinates: [6.815, 51.20015] },
    ];
    for (const geometry of geometries) {
      const r = bindEvent(
        toBindInput({ id: "short", type: "hazard", roads: [{ ref: "A 46" }], geometry }),
        spine
      );
      expect(r.directionMode).toBe("unknown");
      expect(r.status).toBe("ambiguous");
      expect(r.confidence).toBeLessThanOrEqual(0.69);
    }
  });

  it("leaves the direction unknown when the bearing cannot separate two parallel roads", () => {
    const r = bindEvent(
      toBindInput({
        id: "par",
        type: "roadworks",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [7.005, 51.00001],
            [7.015, 51.00001],
          ],
        },
      }),
      parallel
    );
    expect(r.segments.map((s) => s.segmentId)).toEqual(["60:f"]);
    expect(r.directionMode).toBe("unknown");
    expect(r.confidence).toBeLessThanOrEqual(0.69);
  });

  it("counts a second carriageway of the same road as a rival", () => {
    const r = bindEvent(
      toBindInput({
        id: "same-ref",
        type: "roadworks",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [7.005, 51.00001],
            [7.015, 51.00001],
          ],
        },
      }),
      parallel
    );
    const mid: [number, number] = [7.01, 51.00001];
    expect(offsetTo(parallel.segments[1]!, mid)).toBeLessThan(40);
    expect(r.debug.ambiguity).toBeGreaterThan(0);
    expect(r.directionMode).toBe("unknown");
  });

  it("does not count a parallel road with another ref as a rival", () => {
    const r = bindEvent(
      toBindInput({
        id: "other-ref",
        type: "roadworks",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [7.005, 51.00001],
            [7.015, 51.00001],
          ],
        },
      }),
      parallelOtherRef
    );
    // Same geometry as the fixture above; only the neighbour's ref differs.
    const mid: [number, number] = [7.01, 51.00001];
    expect(offsetTo(parallelOtherRef.segments[1]!, mid)).toBeLessThan(40);
    expect(r.segments.map((s) => s.segmentId)).toEqual(["80:f"]);
    expect(r.debug.ambiguity).toBe(0);
    expect(r.directionMode).toBe("single");
    expect(r.status).toBe("exact");

    // It is the event's own ref that settles this, not the two roads being
    // named differently: drop the ref and the neighbour is a rival again.
    const refless = bindEvent(
      toBindInput({
        id: "other-ref-refless",
        type: "roadworks",
        geometry: {
          type: "LineString",
          coordinates: [
            [7.005, 51.00001],
            [7.015, 51.00001],
          ],
        },
      }),
      parallelOtherRef
    );
    expect(refless.directionMode).toBe("unknown");
    expect(refless.debug.ambiguity).toBeGreaterThan(0);
  });

  it("leaves the carriageway unknown when the event's ref cannot pick a road", () => {
    const cases = [
      { id: "no-ref", spine: midway, roads: undefined },
      { id: "unmatched-ref", spine: midway, roads: [{ ref: "K 12" }] },
      { id: "refless-neighbour", spine: midwayRefless, roads: undefined },
    ];
    for (const c of cases) {
      const r = bindEvent(
        toBindInput({
          id: c.id,
          type: "accident",
          ...(c.roads ? { roads: c.roads } : {}),
          geometry: { type: "Point", coordinates: [7.01, 51.000135] },
        }),
        c.spine
      );
      const mid: [number, number] = [7.01, 51.000135];
      expect(offsetTo(c.spine.segments[0]!, mid)).toBeCloseTo(
        offsetTo(c.spine.segments[1]!, mid),
        1
      );
      expect(r.directionMode).toBe("unknown");
      expect(r.status).toBe("ambiguous");
      expect(r.confidence).toBeLessThanOrEqual(0.69);
    }
  });

  it("does not let a well-angled rival hide a parallel one", () => {
    const r = bindEvent(
      toBindInput({
        id: "masked",
        type: "roadworks",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [7.005, 51.00001],
            [7.015, 51.00001],
          ],
        },
      }),
      masked
    );
    // The 44°-off rival outscores the parallel one, so the strongest rival
    // alone would say the heading decides; the parallel rival says otherwise.
    expect(r.segments.map((s) => s.segmentId)).toEqual(["72:f"]);
    expect(r.directionMode).toBe("unknown");
    expect(r.confidence).toBeLessThanOrEqual(0.69);
  });

  it("does not let the loudest rival at one sample settle the heading for all", () => {
    const r = bindEvent(
      toBindInput({
        id: "masked-across",
        type: "roadworks",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [7.005, 51.00001],
            [7.015, 51.00001],
          ],
        },
      }),
      maskedAcross
    );
    // The angled rival wins the ambiguity contest at its own sample; the
    // parallel stub, several samples away, is what actually decides direction.
    expect(r.segments.map((s) => s.segmentId)).toEqual(["82:f"]);
    expect(r.directionMode).toBe("unknown");
    expect(r.confidence).toBeLessThanOrEqual(0.69);
  });

  it("keeps the direction when the chosen road fits the heading 30° better", () => {
    const r = bindEvent(
      toBindInput({
        id: "ang",
        type: "roadworks",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "LineString",
          coordinates: [
            [7.005, 51.00001],
            [7.015, 51.00001],
          ],
        },
      }),
      angled
    );
    expect(r.segments.map((s) => s.segmentId)).toEqual(["70:f"]);
    expect(r.debug.ambiguity).toBeGreaterThan(0);
    expect(r.directionMode).toBe("single");
    expect(r.status).toBe("exact");
  });

  it("reports no_path when both endpoints match but nothing connects them", () => {
    const r = bindEvent(
      toBindInput({
        id: "np",
        type: "road_closure",
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [6.805, 51.19701],
            [6.825, 51.20001],
          ],
        },
      }),
      spine
    );
    expect(r.status).toBe("unresolved");
    expect(r.reason).toBe("no_path");
    expect(r.candidateCount).toBeGreaterThan(0);
    expect(r.segments).toEqual([]);
  });

  it("reports no_candidates for an endpoint pair with nothing in reach", () => {
    const r = bindEvent(
      toBindInput({
        id: "mpfar",
        type: "road_closure",
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [7.5, 51.5],
            [7.6, 51.6],
          ],
        },
      }),
      spine
    );
    expect(r.status).toBe("unresolved");
    expect(r.reason).toBe("no_candidates");
  });

  it("refuses a subgraph larger than the cap", () => {
    const many: SpineSubgraph = {
      segments: Array.from({ length: 5001 }, (_, i) =>
        seg(`${100000 + i}:f`, [
          [6.8, 51.2],
          [6.81, 51.2],
        ])
      ),
    };
    const r = bindEvent(
      toBindInput({
        id: "big",
        type: "road_closure",
        geometry: { type: "Point", coordinates: [6.805, 51.2] },
      }),
      many
    );
    expect(r.status).toBe("unresolved");
    expect(r.reason).toBe("subgraph_too_large");
  });

  it("handles degenerate lines: empty is unresolved, one coordinate is a point", () => {
    const empty = bindEvent(
      toBindInput({
        id: "empty",
        type: "road_closure",
        geometry: { type: "LineString", coordinates: [] },
      }),
      spine
    );
    expect(empty.status).toBe("unresolved");
    expect(empty.reason).toBe("no_candidates");

    const single = bindEvent(
      toBindInput({
        id: "single",
        type: "accident",
        roads: [{ ref: "B 9" }],
        geometry: { type: "LineString", coordinates: [[6.815, 51.19701]] },
      }),
      spine
    );
    expect(single.directionMode).toBe("both");
    expect(single.segments.map((s) => s.segmentId).sort()).toEqual(["30:b", "30:f"]);
  });

  it("a refless endpoint pair midway between two equal roads is ambiguous, never likely", () => {
    // Both roads are 15 m away with the same class, ref and heading: the two
    // reconstructed paths score the same, so the winner is a coin flip.
    const r = bindEvent(
      toBindInput({
        id: "coin",
        type: "road_closure",
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [7.005, 51.000135],
            [7.015, 51.000135],
          ],
        },
      }),
      parallel
    );
    expect(r.debug.ambiguity).toBeCloseTo(1, 5);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.status).toBe("ambiguous");
    expect(r.alternativeConfidence).toBeCloseTo(r.confidence!, 10);
  });

  it("an endpoint pair starting just past a node treats the previous way as a continuation", () => {
    // The start is 14 m past the node between ways 10 and 11, so both are
    // start candidates and both yield a path to way 12. The path entered from
    // way 10 covers the same road plus a 14 m stub, which is no rival.
    const r = bindEvent(
      toBindInput({
        id: "cont",
        type: "road_closure",
        roads: [{ ref: "A 46" }],
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [6.8102, 51.20001],
            [6.825, 51.20001],
          ],
        },
      }),
      spine
    );
    expect(r.debug.samples[0]!.candidates.map((c) => c.segment.segmentId)).toContain("10:f");
    expect(r.segments.map((s) => s.segmentId)).toEqual(["11:f", "12:f"]);
    expect(r.debug.ambiguity).toBeLessThan(0.1);
    expect(r.status).toBe("exact");
  });
});
