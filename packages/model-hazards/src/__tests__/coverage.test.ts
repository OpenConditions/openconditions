import {
  buildRegistry,
  kernelModule,
  parseSituationCode,
  situationCode,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  CAP_CP_CLASSES,
  DWD_II_CLASSES,
  METEOALARM_CLASSES,
  NWS_CLASSES,
  SAME_CLASSES,
  VTEC_CLASSES,
} from "../crosswalk/cap-events.js";
import { GTFS_RT_HAZARD_CAUSES, ROAD511_HAZARD_TYPES } from "../crosswalk/emitters.js";
import { hazardsModule } from "../module.js";
import {
  CAP_CP_EVENTS,
  DWD_II_EVENTS,
  METEOALARM_AWARENESS_TYPES,
  NWS_PRODUCTS,
  SAME_EVENTS,
  VTEC_PHENOMENA,
} from "../vocabularies/cap-events.js";

/**
 * Vocabulary coverage: every code of every publisher event list is mapped or
 * explicitly `null`, no table holds a code the list does not, every mapped
 * classification is registered and every registered subtype is reachable,
 * and every registered type has an emitter entry.
 */
const registry = buildRegistry([kernelModule, hazardsModule]);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const keys = (prefix: string, list: Readonly<Record<string, string>>) =>
  sorted(Object.keys(list).map((code) => `${prefix}${code}`));
const TABLES = [
  DWD_II_CLASSES,
  CAP_CP_CLASSES,
  VTEC_CLASSES,
  METEOALARM_CLASSES,
  NWS_CLASSES,
  SAME_CLASSES,
];

function isRegistered(code: string): boolean {
  const c = parseSituationCode(code);
  const subtypes = registry.kind("situation", c.kind)?.types?.[c.type];
  return subtypes !== undefined && (c.subtype === undefined || subtypes.includes(c.subtype));
}

const registeredTypes = registry
  .kinds("situation")
  .flatMap((k) => Object.keys(k.types ?? {}).map((t) => situationCode({ kind: k.code, type: t })));

describe("CAP event list coverage", () => {
  it("maps every code of every publisher event list", () => {
    expect(sorted(Object.keys(DWD_II_CLASSES))).toEqual(keys("II:", DWD_II_EVENTS));
    expect(sorted(Object.keys(CAP_CP_CLASSES))).toEqual(keys("CAP-CP:", CAP_CP_EVENTS));
    expect(sorted(Object.keys(VTEC_CLASSES))).toEqual(keys("VTEC:", VTEC_PHENOMENA));
    expect(sorted(Object.keys(METEOALARM_CLASSES))).toEqual(
      keys("awareness_type:", METEOALARM_AWARENESS_TYPES),
    );
    expect(sorted(Object.keys(NWS_CLASSES))).toEqual(keys("NWS:", NWS_PRODUCTS));
    expect(sorted(Object.keys(SAME_CLASSES))).toEqual(keys("SAME:", SAME_EVENTS));
  });

  it("maps only onto registered classifications", () => {
    const unregistered = TABLES.flatMap((t) => Object.values(t)).filter(
      (c): c is string => c !== null && !isRegistered(c),
    );
    expect(unregistered).toEqual([]);
  });

  it("reaches every alert subtype from some list", () => {
    const mapped = new Set(TABLES.flatMap((t) => Object.values(t)));
    const alert = registry.kind("situation", "alert")!;
    const unused = Object.entries(alert.types!).flatMap(([type, subtypes]) =>
      subtypes.filter((s) => !mapped.has(`alert.${type}.${s}`)).map((s) => `${type}.${s}`),
    );
    expect(unused).toEqual([]);
  });

  it("gives every registered type a Road511 entry and every hazard event a GTFS-Realtime cause", () => {
    expect(
      sorted(Object.keys(ROAD511_HAZARD_TYPES).filter((k) => k.split(".").length === 2)),
    ).toEqual(sorted(registeredTypes));
    expect(sorted(Object.keys(GTFS_RT_HAZARD_CAUSES))).toEqual(
      sorted(registeredTypes.filter((t) => t.startsWith("natural_hazard."))),
    );
  });
});
