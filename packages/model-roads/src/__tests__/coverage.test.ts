import {
  buildRegistry,
  CAUSES,
  CERTAINTIES,
  kernelModule,
  parseSituationCode,
  SEVERITY_LABELS,
  situationCode,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { CAUSE_NATURES } from "../cause-natures.js";
import {
  DATEX2_CAUSES,
  DATEX2_CERTAINTIES,
  DATEX2_SEVERITIES,
  DATEX2_SITUATIONS,
} from "../crosswalk/datex2.js";
import {
  DATEX2_RECORDS,
  GTFS_RT_CAUSE_VALUES,
  GTFS_RT_CAUSES,
  ROAD511_TYPES,
  TRAFF_EVENTS,
} from "../crosswalk/emitters.js";
import { IBI511_SITUATIONS } from "../crosswalk/ibi511.js";
import {
  OPEN511_CERTAINTIES,
  OPEN511_SEVERITIES,
  OPEN511_SITUATIONS,
} from "../crosswalk/open511.js";
import {
  AUTOBAHN_SITUATIONS,
  DIGITRAFFIC_SITUATIONS,
  GDDKIA_SITUATIONS,
  LTA_SITUATIONS,
  OHGO_SITUATIONS,
  TRAFIKVERKET_SITUATIONS,
  VIC_SITUATIONS,
} from "../crosswalk/providers.js";
import {
  WZDX_LANE_STATUSES,
  WZDX_LANE_TYPES,
  WZDX_RELATIONS,
  WZDX_SITUATIONS,
  WZDX_VEHICLE_IMPACTS,
} from "../crosswalk/wzdx.js";
import { roadsModule } from "../module.js";
import { DATEX2_V2, DATEX2_V3 } from "../vocabularies/datex2.js";
import { GTFS_RT } from "../vocabularies/gtfs-rt.js";
import { IBI511 } from "../vocabularies/ibi511.js";
import { OPEN511 } from "../vocabularies/open511.js";
import { TRAFF } from "../vocabularies/traff.js";
import { WZDX } from "../vocabularies/wzdx.js";

/**
 * Vocabulary coverage: every value of every source vocabulary OpenConditions
 * parses is mapped or explicitly marked `null`, every table key is a real
 * source value, every mapped code is a registered classification, and every
 * registered classification has an emitter code or an explicit `null`. This
 * is what keeps the declared enum and the data from drifting apart.
 */
const registry = buildRegistry([kernelModule, roadsModule]);

/** DATEX `_extended` is a placeholder for national extensions; it falls back to the class. */
const real = (values: readonly string[]) => values.filter((v) => v !== "_extended");
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

function datexKeys(v: typeof DATEX2_V3 | typeof DATEX2_V2): string[] {
  const discriminators = v.discriminators as Record<string, { values: readonly string[] }>;
  return v.recordClasses.flatMap((cls) => [
    cls,
    ...real(discriminators[cls]?.values ?? []).map((value) => `${cls}:${value}`),
  ]);
}

function isRegistered(code: string): boolean {
  const c = parseSituationCode(code);
  const kind = registry.kind("situation", c.kind);
  const subtypes = kind?.types?.[c.type];
  return subtypes !== undefined && (c.subtype === undefined || subtypes.includes(c.subtype));
}

const registeredTypes = registry
  .kinds("situation")
  .flatMap((k) => Object.keys(k.types ?? {}).map((t) => situationCode({ kind: k.code, type: t })));

describe("source crosswalk coverage", () => {
  it("maps every DATEX v2.3 and v3 record class and discriminator value", () => {
    expect(sorted(Object.keys(DATEX2_SITUATIONS))).toEqual(
      sorted([...datexKeys(DATEX2_V3), ...datexKeys(DATEX2_V2)]),
    );
    for (const cls of [...DATEX2_V3.recordClasses, ...DATEX2_V2.recordClasses]) {
      expect(DATEX2_SITUATIONS[cls], cls).not.toBeNull();
    }
  });

  it("maps every DATEX cause type, severity and probability", () => {
    expect(sorted(Object.keys(DATEX2_CAUSES))).toEqual(
      sorted(real([...DATEX2_V3.causeTypes, ...DATEX2_V2.causeTypes])),
    );
    expect(sorted(Object.keys(DATEX2_SEVERITIES))).toEqual(
      sorted(real([...DATEX2_V3.severities, ...DATEX2_V2.severities])),
    );
    expect(sorted(Object.keys(DATEX2_CERTAINTIES))).toEqual(
      sorted(real([...DATEX2_V3.probabilities, ...DATEX2_V2.probabilities])),
    );
  });

  it("maps every WZDx 4.2 event type, work type and restriction type", () => {
    expect(sorted(Object.keys(WZDX_SITUATIONS))).toEqual(
      sorted([
        ...WZDX.eventType,
        ...WZDX.workTypeName.map((t) => `work-zone:${t}`),
        ...WZDX.restrictionType.map((t) => `restriction:${t}`),
      ]),
    );
    expect(sorted(Object.keys(WZDX_VEHICLE_IMPACTS))).toEqual(sorted(WZDX.vehicleImpact));
    expect(sorted(Object.keys(WZDX_LANE_STATUSES))).toEqual(sorted(WZDX.laneStatus));
    expect(sorted(Object.keys(WZDX_LANE_TYPES))).toEqual(sorted(WZDX.laneType));
    expect(sorted(Object.keys(WZDX_RELATIONS))).toEqual(sorted(WZDX.relatedRoadEventType));
  });

  it("maps every Open511 event type, subtype, severity and certainty", () => {
    expect(sorted(Object.keys(OPEN511_SITUATIONS))).toEqual(
      sorted([...OPEN511.eventTypes, ...OPEN511.eventSubtypes]),
    );
    expect(sorted(Object.keys(OPEN511_SEVERITIES))).toEqual(sorted(OPEN511.severities));
    expect(sorted(Object.keys(OPEN511_CERTAINTIES))).toEqual(sorted(OPEN511.certainties));
  });

  it("maps every documented IBI 511 event type", () => {
    expect(sorted(Object.keys(IBI511_SITUATIONS))).toEqual(sorted(IBI511.eventTypes));
  });

  it("maps only to registered classifications and values", () => {
    for (const table of [
      DATEX2_SITUATIONS,
      WZDX_SITUATIONS,
      OPEN511_SITUATIONS,
      IBI511_SITUATIONS,
      DIGITRAFFIC_SITUATIONS,
      LTA_SITUATIONS,
      GDDKIA_SITUATIONS,
      TRAFIKVERKET_SITUATIONS,
      AUTOBAHN_SITUATIONS,
      OHGO_SITUATIONS,
      VIC_SITUATIONS,
    ]) {
      for (const [code, target] of Object.entries(table)) {
        if (target !== null) expect(isRegistered(target), `${code} → ${target}`).toBe(true);
      }
    }
    for (const value of Object.values(DATEX2_CAUSES)) {
      if (value !== null) expect(CAUSES).toContain(value);
    }
    for (const value of [
      ...Object.values(DATEX2_SEVERITIES),
      ...Object.values(OPEN511_SEVERITIES),
    ]) {
      if (value !== null) expect(SEVERITY_LABELS).toContain(value);
    }
    for (const value of [
      ...Object.values(DATEX2_CERTAINTIES),
      ...Object.values(OPEN511_CERTAINTIES),
    ]) {
      if (value !== null) expect(CERTAINTIES).toContain(value);
    }
    const effect = (vehicleImpact: string, status: string, type: string | null) => ({
      id: "x/lane_restriction",
      kind: "lane_restriction",
      v: 1,
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
      vehicleImpact,
      lanes: [{ index: 1, status, ...(type !== null ? { type } : {}) }],
    });
    const schema = registry.effectSchema("lane_restriction")!;
    for (const impact of Object.values(WZDX_VEHICLE_IMPACTS)) {
      for (const status of Object.values(WZDX_LANE_STATUSES)) {
        for (const type of Object.values(WZDX_LANE_TYPES)) {
          expect(
            schema.safeParse(effect(impact, status, type)).success,
            `${impact}/${status}/${type}`,
          ).toBe(true);
        }
      }
    }
    for (const relation of Object.values(WZDX_RELATIONS)) {
      expect(registry.vocabulary("relation")!.values).toContain(relation);
    }
  });
});

describe("emitter crosswalk coverage", () => {
  it.each([
    ["TraFF", TRAFF_EVENTS, TRAFF.eventTypes as readonly string[]],
    ["GTFS-RT", GTFS_RT_CAUSES, GTFS_RT.causes as readonly string[]],
    ["Road511", ROAD511_TYPES, null],
  ] as const)(
    "gives every registered type a %s code or an explicit null",
    (_, table, vocabulary) => {
      for (const type of registeredTypes) expect(Object.keys(table), type).toContain(type);
      for (const [code, target] of Object.entries(table)) {
        expect(isRegistered(code), code).toBe(true);
        if (target !== null && vocabulary !== null) expect(vocabulary, code).toContain(target);
      }
    },
  );

  it("gives every registered type a DATEX record that reads back as the same kind, or an explicit null", () => {
    for (const type of registeredTypes) expect(Object.keys(DATEX2_RECORDS), type).toContain(type);
    for (const [code, record] of Object.entries(DATEX2_RECORDS)) {
      expect(isRegistered(code), code).toBe(true);
      if (record === null) continue;
      const [cls, value] = record.split(":") as [string, string | undefined];
      expect(DATEX2_V3.recordClasses as readonly string[], record).toContain(cls);
      const discriminators = DATEX2_V3.discriminators as Record<
        string,
        { values: readonly string[] }
      >;
      if (value !== undefined) expect(discriminators[cls]?.values, record).toContain(value);
      const read = DATEX2_SITUATIONS[record];
      expect(read && parseSituationCode(read).kind, record).toBe(parseSituationCode(code).kind);
    }
  });

  it("gives every cause a nature or an explicit null", () => {
    expect(sorted(Object.keys(CAUSE_NATURES))).toEqual(sorted(CAUSES));
    for (const [cause, code] of Object.entries(CAUSE_NATURES)) {
      if (code !== null) expect(isRegistered(code), cause).toBe(true);
    }
  });

  it("gives every cause a GTFS-RT cause", () => {
    expect(sorted(Object.keys(GTFS_RT_CAUSE_VALUES))).toEqual(sorted(CAUSES));
    for (const cause of Object.values(GTFS_RT_CAUSE_VALUES))
      expect(GTFS_RT.causes).toContain(cause);
  });
});
