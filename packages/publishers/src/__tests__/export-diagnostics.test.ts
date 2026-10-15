import { productionRegistry } from "@openconditions/model-registry";
import { describe, expect, it } from "vitest";
import type { ExportDiagnostic } from "../export-diagnostics.js";
import { datexRecordsOf } from "../situation-datex.js";
import { situationsToTraff } from "../situation-traff.js";

type Rec = Record<string, unknown>;
const registry = productionRegistry();
const at = new Date("2026-09-06T10:00:00Z");
const effect = (over: Rec = {}) => ({
  id: "closure",
  kind: "closure",
  v: 1,
  scope: "road",
  applicability: { kind: "all" },
  normalization: "complete",
  compliance: "mandatory",
  ...over,
});
const location = {
  fuzziness: "exact",
  geometry: {
    type: "LineString",
    coordinates: [
      [6, 51],
      [6.1, 51.2],
      [6.2, 51],
    ],
  },
};
const situation = (over: Rec = {}): Rec => ({
  id: "example",
  kind: "roadworks",
  type: "works",
  effects: [effect()],
  location,
  validity: { status: "active", start: "2026-09-06T08:00:00Z" },
  provenance: {},
  freshness: { fetchedAt: "2026-09-06T09:00:00Z" },
  ...over,
});
function project(s: Rec, format: "traff" | "datex") {
  const diagnostics: ExportDiagnostic[] = [];
  const collect = (d: ExportDiagnostic) => diagnostics.push(d);
  const output =
    format === "traff"
      ? situationsToTraff(registry, [s], at, collect)
      : datexRecordsOf(s, at, collect);
  const plain = format === "traff" ? situationsToTraff(registry, [s], at) : datexRecordsOf(s, at);
  expect(output).toEqual(plain);
  return { diagnostics, output };
}

describe.each(["traff", "datex"] as const)("%s exporter decisions", (format) => {
  it("identifies the exact coarse location and the whole-situation refusal", () => {
    for (const [s, path, effectId] of [
      [
        situation({ location: { ...location, fuzziness: "low_res" } }),
        "/location/fuzziness",
        undefined,
      ],
      [
        situation({
          details: {
            phases: [
              {
                effects: [
                  effect({ id: "phase/closure", location: { ...location, fuzziness: "low_res" } }),
                ],
              },
            ],
          },
        }),
        "/details/phases/0/effects/0/location/fuzziness",
        "phase/closure",
      ],
    ] as const) {
      const { diagnostics, output } = project(s, format);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: "coarse_location",
          scope: "situation",
          disposition: "withheld",
          path,
          ...(effectId ? { effectId } : {}),
        }),
      );
      expect(
        format === "traff"
          ? String(output).includes("<message ")
          : (output as unknown[]).length > 0,
      ).toBe(false);
      expect(diagnostics.some((d) => d.code.startsWith("geometry_"))).toBe(false);
    }
  });
  it("names applicability and normalization fields independently", () => {
    const { diagnostics } = project(
      situation({
        effects: [effect({ applicability: { kind: "unknown" }, normalization: "partial" })],
      }),
      format,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "vehicle_specific_effect",
          path: "/effects/0/applicability",
          effectId: "closure",
          scope: "situation",
        }),
        expect.objectContaining({
          code: "restriction_evidence",
          path: "/effects/0/normalization",
          effectId: "closure",
        }),
      ]),
    );
  });
  it("explains ended effects while the nature is still emitted", () => {
    const { diagnostics, output } = project(
      situation({
        effects: [effect({ validity: { status: "active", end: "2026-09-06T09:00:00Z" } })],
      }),
      format,
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "effect_ended",
        path: "/effects/0/validity",
        effectId: "closure",
        scope: "effect",
        disposition: "omitted",
      }),
    );
    expect(
      format === "traff" ? String(output).includes("<message ") : (output as unknown[]).length > 0,
    ).toBe(true);
  });
  it("reports unsupported effects even when a nature record survives", () => {
    const { diagnostics } = project(
      situation({ effects: [effect({ kind: "access", mode: "local_access_only" })] }),
      format,
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unsupported_effect",
        path: "/effects/0/kind",
        effectId: "closure",
      }),
    );
  });
  it("reports geometry reduction only for emitted locations", () => {
    expect(project(situation(), format).diagnostics).toContainEqual(
      expect.objectContaining({
        code: format === "traff" ? "geometry_to_endpoints" : "geometry_to_point",
        path: "/location/geometry",
        disposition: "reduced",
      }),
    );
    expect(
      project(
        situation({ location: { geometry: { type: "Point", coordinates: [6, 51] } } }),
        format,
      ).diagnostics.some((d) => d.code.startsWith("geometry_")),
    ).toBe(false);
  });
});
it("distinguishes TraFF direction refusal from DATEX direction omission", () => {
  const s = situation({
    location: { ...location, direction: { value: "unknown", basis: "unknown" } },
  });
  expect(project(s, "traff").diagnostics).toContainEqual(
    expect.objectContaining({
      code: "unrepresentable_direction",
      path: "/location/direction",
      disposition: "withheld",
    }),
  );
  expect(project(s, "datex").diagnostics).toContainEqual(
    expect.objectContaining({
      code: "direction_not_exported",
      path: "/location/direction",
      disposition: "omitted",
    }),
  );
});
it("attributes own-location reductions to their effect, not the parent", () => {
  const s = situation({
    location: { geometry: { type: "Point", coordinates: [6, 51] } },
    effects: [effect({ location })],
  });
  for (const format of ["traff", "datex"] as const) {
    expect(project(s, format).diagnostics.filter((d) => d.code.startsWith("geometry_"))).toEqual([
      expect.objectContaining({ path: "/effects/0/location/geometry", effectId: "closure" }),
    ]);
  }
});

it("keeps direction paths anchored to inherited canonical fields", () => {
  const s = situation({
    location: { ...location, direction: { value: "positive", basis: "road_reference" } },
    effects: [effect({ location: { geometry: { type: "Point", coordinates: [7, 52] } } })],
  });
  const traff = project(s, "traff");
  expect(traff.diagnostics.filter((d) => d.code === "unrepresentable_direction")).toEqual([
    expect.objectContaining({ scope: "message", path: "/location/direction" }),
    expect.objectContaining({ scope: "message", path: "/location/direction", effectId: "closure" }),
  ]);
  expect(
    project(s, "datex")
      .diagnostics.filter((d) => d.code === "direction_not_exported")
      .every((d) => d.path === "/location/direction"),
  ).toBe(true);
});
it("distinguishes a withheld parent message from a surviving own-place effect", () => {
  const s = situation({
    location: { ...location, direction: { value: "unknown", basis: "unknown" } },
    effects: [
      effect({ location: { ...location, direction: { value: "both", basis: "unknown" } } }),
    ],
  });
  const { diagnostics, output } = project(s, "traff");
  expect(String(output).match(/<message /g)).toHaveLength(1);
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      code: "unrepresentable_direction",
      scope: "message",
      path: "/location/direction",
    }),
  );
});
it("reports direction on an effect location even without its own geometry", () => {
  const s = situation({
    effects: [effect({ location: { direction: { value: "positive", basis: "road_reference" } } })],
  });
  expect(project(s, "datex").diagnostics).toContainEqual(
    expect.objectContaining({
      code: "direction_not_exported",
      path: "/effects/0/location/direction",
      effectId: "closure",
    }),
  );
  expect(project(s, "traff").diagnostics).toContainEqual(
    expect.objectContaining({
      code: "unrepresentable_direction",
      scope: "situation",
      path: "/effects/0/location/direction",
    }),
  );
});
it("does not claim DATEX's ended delay supplement was withheld", () => {
  const s = situation({
    effects: [
      effect({
        kind: "delay",
        delay: { value: 300, unit: "s" },
        validity: { status: "active", end: "2026-09-06T09:00:00Z" },
      }),
    ],
  });
  const { diagnostics, output } = project(s, "datex");
  expect(JSON.stringify(output)).toContain('"sit:delayTimeValue":300');
  expect(diagnostics.some((d) => d.effectId === "closure" && d.scope === "effect")).toBe(false);
});
it("does not describe unused root geometry as exported", () => {
  const s = situation({
    kind: "no_mapping",
    type: "no_mapping",
    effects: [effect({ location: { geometry: { type: "Point", coordinates: [7, 52] } } })],
  });
  for (const format of ["traff", "datex"] as const) {
    expect(project(s, format).diagnostics.some((d) => d.code.startsWith("geometry_"))).toBe(false);
  }
});
it.each(["traff", "datex"] as const)(
  "reports unknown time but keeps scheduled effects in %s",
  (format) => {
    const unknown = project(
      situation({ effects: [effect({ issues: [{ code: "unsupported_schedule" }] })] }),
      format,
    );
    expect(unknown.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "effect_time_unknown",
        effectId: "closure",
        path: "/effects/0/issues",
      }),
    );
    const scheduled = project(
      situation({
        effects: [effect({ validity: { status: "planned", start: "2026-09-07T10:00:00Z" } })],
      }),
      format,
    );
    expect(
      scheduled.diagnostics.some(
        (d) => d.code === "effect_ended" || d.code === "effect_time_unknown",
      ),
    ).toBe(false);
  },
);
