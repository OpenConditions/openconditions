import { productionRegistry } from "@openconditions/model-registry";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import type { ExportDiagnostic } from "../export-diagnostics.js";
import { datexRecordsOf } from "../situation-datex.js";
import { situationsToTraff } from "../situation-traff.js";

type Rec = Record<string, unknown>;
const registry = productionRegistry();
const at = new Date("2026-10-24T10:00:00Z");
const parent = { status: "active", start: "2026-10-24T00:00:00Z", end: "2026-10-27T00:00:00Z" };
const window = { status: "planned", start: "2026-10-25T10:00:00Z", end: "2026-10-25T11:00:00Z" };
const effect = (over: Rec = {}): Rec => ({
  id: "closure",
  kind: "closure",
  v: 1,
  scope: "road",
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  ...over,
});
const situation = (over: Rec = {}): Rec => ({
  id: "timing",
  kind: "closure",
  type: "closure",
  subtype: "full",
  validity: parent,
  effects: [effect()],
  location: { geometry: { type: "Point", coordinates: [7, 52] } },
  provenance: {},
  freshness: { fetchedAt: at.toISOString() },
  ...over,
});
const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === "message" || name === "event",
});
const messages = (s: Rec) => parser.parse(situationsToTraff(registry, [s], at)).feed.message ?? [];

it("gives a future same-place closure its own exact interval without a broad nature closure", () => {
  const out = messages(situation({ effects: [effect({ validity: window })] }));
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    "@_id": "timing#closure",
    "@_start_time": window.start,
    "@_end_time": window.end,
  });
});
it.each(["traff", "datex"] as const)("uses phase fallback validity in %s", (format) => {
  const s = situation({
    effects: [],
    details: { phases: [{ id: "phase", validity: window, effects: [effect()] }] },
  });
  if (format === "traff")
    expect(messages(s)[0]).toMatchObject({
      "@_start_time": window.start,
      "@_end_time": window.end,
    });
  else
    expect(datexRecordsOf(s, at)[0]).toMatchObject({
      "sit:validity": {
        "com:validityTimeSpecification": {
          "com:overallStartTime": window.start,
          "com:overallEndTime": window.end,
        },
      },
    });
});
it("keeps same-interval conflicts withheld after splitting and uses order-independent group IDs", () => {
  const speeds = [60, 80].map((value) =>
    effect({
      id: `speed-${value}`,
      kind: "speed_limit",
      limit: { value, unit: "km/h" },
      validity: window,
    }),
  );
  for (const effects of [speeds, [...speeds].reverse()])
    expect(messages(situation({ kind: "no_mapping", type: "no_mapping", effects }))).toEqual([]);
  const compatible = [effect({ id: "b", validity: window }), effect({ id: "a", validity: window })];
  expect(messages(situation({ effects: compatible }))).toEqual(
    messages(situation({ effects: [...compatible].reverse() })),
  );
});
it.each(["traff", "datex"] as const)(
  "does not resurrect an ended matching nature in %s",
  (format) => {
    const s = situation({
      effects: [effect({ validity: { status: "active", end: "2026-10-24T09:00:00Z" } })],
    });
    expect(format === "traff" ? messages(s) : datexRecordsOf(s, at)).toEqual([]);
  },
);

const schedules = [
  { scheduleTimezone: "Europe/Berlin", startTime: "20:00", duration: "PT9H", byDay: ["SA", "SU"] },
  { scheduleTimezone: "America/New_York", startTime: "01:30", duration: "PT2H", byDay: ["SU"] },
];
describe.each(["traff", "datex"] as const)("%s unsupported timing", (format) => {
  for (const field of ["periods", "exceptions"] as const) {
    it.each(schedules)(
      `refuses ${field} including overnight/DST schedules without flattening ($scheduleTimezone)`,
      (schedule) => {
        for (const context of ["root", "effect", "phase"]) {
          const validity = { ...parent, [field]: [schedule] };
          const s =
            context === "root"
              ? situation({ validity })
              : context === "effect"
                ? situation({ effects: [effect({ validity })] })
                : situation({
                    effects: [],
                    details: { phases: [{ validity, effects: [effect()] }] },
                  });
          const diagnostics: ExportDiagnostic[] = [];
          const output =
            format === "traff"
              ? situationsToTraff(registry, [s], at, (d) => diagnostics.push(d))
              : datexRecordsOf(s, at, (d) => diagnostics.push(d));
          expect(
            format === "traff"
              ? String(output).includes("<message ")
              : (output as Rec[]).length > 0,
          ).toBe(false);
          const base =
            context === "root"
              ? "/validity"
              : context === "effect"
                ? "/effects/0/validity"
                : "/details/phases/0/validity";
          expect(diagnostics).toContainEqual(
            expect.objectContaining({
              code: "unsupported_timing",
              scope: "situation",
              disposition: "withheld",
              path: `${base}/${field}`,
            }),
          );
          const plain =
            format === "traff" ? situationsToTraff(registry, [s], at) : datexRecordsOf(s, at);
          expect(output).toEqual(plain);
        }
      },
    );
  }
});
it("does not attach an ended, future, own-place or differently-windowed delay to a DATEX leading record", () => {
  for (const fields of [
    { validity: { status: "active", end: "2026-10-24T09:00:00Z" } },
    { validity: window },
    { location: { geometry: { type: "Point", coordinates: [8, 53] } } },
    { validity: { ...parent, start: "2026-10-24T01:00:00Z" } },
  ]) {
    const diagnostics: ExportDiagnostic[] = [];
    const records = datexRecordsOf(
      situation({
        effects: [
          effect(),
          effect({ id: "delay", kind: "delay", delay: { value: 300, unit: "s" }, ...fields }),
        ],
      }),
      at,
      (d) => diagnostics.push(d),
    );
    expect(JSON.stringify(records)).not.toContain("sit:delayTimeValue");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ effectId: "delay", disposition: "omitted" }),
    );
  }
});

it("keeps equivalent timestamp offsets in the parent interval", () => {
  const same = {
    status: "active",
    start: "2026-10-24T02:00:00+02:00",
    end: "2026-10-27T01:00:00+01:00",
  };
  expect(messages(situation({ effects: [effect({ validity: same })] }))[0]["@_id"]).toBe("timing");
});
it.each(["traff", "datex"] as const)(
  "reports unknown phase lifecycle at the inherited status path in %s",
  (format) => {
    const diagnostics: ExportDiagnostic[] = [];
    const s = situation({
      effects: [],
      details: { phases: [{ validity: { ...parent, status: "unknown" }, effects: [effect()] }] },
    });
    const out =
      format === "traff"
        ? situationsToTraff(registry, [s], at, (d) => diagnostics.push(d))
        : datexRecordsOf(s, at, (d) => diagnostics.push(d));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "effect_time_unknown",
        path: "/details/phases/0/validity/status",
      }),
    );
    expect(format === "traff" ? String(out).includes("<message ") : (out as Rec[]).length > 0).toBe(
      false,
    );
  },
);
it("lets an effect override a phase interval explicitly", () => {
  const s = situation({
    effects: [],
    details: { phases: [{ validity: window, effects: [effect({ validity: parent })] }] },
  });
  expect(messages(s)[0]).toMatchObject({
    "@_id": "timing",
    "@_start_time": parent.start,
    "@_end_time": parent.end,
  });
});
it("moves DATEX leading metadata to an own-place effect without a broad root closure", () => {
  const records = datexRecordsOf(
    situation({
      headline: [{ lang: "en", text: "Closed ramp" }],
      severity: { label: "major" },
      effects: [
        effect({
          validity: window,
          location: { geometry: { type: "Point", coordinates: [8, 53] } },
        }),
      ],
    }),
    at,
  );
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    "@_id": "timing#closure",
    "sit:severity": "high",
    "sit:generalPublicComment": expect.anything(),
    "sit:validity": { "com:validityTimeSpecification": { "com:overallStartTime": window.start } },
  });
});
it("keeps a suspended DATEX record but omits an active delay from it", () => {
  const s = situation({
    validity: { ...parent, status: "suspended" },
    effects: [
      effect(),
      effect({ id: "delay", kind: "delay", delay: { value: 300, unit: "s" }, validity: parent }),
    ],
  });
  const records = datexRecordsOf(s, at);
  expect(records[0]).toMatchObject({ "sit:validity": { "com:validityStatus": "suspended" } });
  expect(JSON.stringify(records)).not.toContain("sit:delayTimeValue");
  expect(messages(s)).toEqual([]);
});
it("preserves a matching DATEX delay but refuses conflicting durations", () => {
  const delay = effect({ id: "delay", kind: "delay", delay: { value: 300, unit: "s" } });
  expect(JSON.stringify(datexRecordsOf(situation({ effects: [effect(), delay] }), at))).toContain(
    '"sit:delayTimeValue":300',
  );
  const diagnostics: ExportDiagnostic[] = [];
  const out = datexRecordsOf(
    situation({
      effects: [effect(), delay, { ...delay, id: "other", delay: { value: 600, unit: "s" } }],
    }),
    at,
    (d) => diagnostics.push(d),
  );
  expect(JSON.stringify(out)).not.toContain("sit:delayTimeValue");
  expect(diagnostics.filter((d) => d.code === "conflicting_effects")).toHaveLength(2);
});

it.each(["traff", "datex"] as const)(
  "does not recreate a broad management nature when discriminators differ in %s",
  (format) => {
    for (const classification of [
      {
        kind: "closure",
        type: "closure",
        subtype: "full",
        effect: effect({ scope: "carriageway" }),
      },
      { kind: "closure", type: "closure", subtype: "ramp", effect: effect({ scope: "ramp" }) },
      {
        kind: "pass_status",
        type: "pass",
        subtype: "closed",
        effect: effect({ scope: "carriageway" }),
      },
      {
        kind: "restriction",
        type: "speed",
        effect: effect({ kind: "speed_limit", limit: { value: 60, unit: "km/h" } }),
      },
    ]) {
      for (const validity of [window, { status: "active", end: "2026-10-24T09:00:00Z" }]) {
        const s = situation({
          ...classification,
          effects: [{ ...classification.effect, validity }],
        });
        const out = format === "traff" ? messages(s) : datexRecordsOf(s, at);
        expect(out).toHaveLength(validity === window ? 1 : 0);
        if (validity === window) {
          if (format === "traff") expect(out[0]).toHaveProperty("@_start_time", window.start);
          else
            expect(out[0]).toMatchObject({
              "sit:validity": {
                "com:validityTimeSpecification": { "com:overallStartTime": window.start },
              },
            });
        }
      }
    }
  },
);
it("never exports a planned or suspended effect inside its window, or an action not in place, as an active TraFF message", () => {
  for (const status of ["planned", "suspended"]) {
    const s = situation({ effects: [effect({ validity: { ...parent, status } })] });
    expect(messages(s), status).toEqual([]);
  }
  for (const actionStatus of ["requested", "approved", "rejected"]) {
    expect(messages(situation({ effects: [effect({ actionStatus })] })), actionStatus).toEqual([]);
  }
  expect(
    messages(situation({ effects: [effect({ actionStatus: "being_terminated" })] })),
  ).toHaveLength(1);
});
