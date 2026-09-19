import { buildRegistry, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  DATEX2_DEVICE_HEALTH,
  DATEX2_MEASURED_TRAFFIC,
  DATEX2_TRAFFIC_STATUSES,
  DATEX2_VMS_TYPES,
  DATEX2_VMS_WORKING_STATUSES,
  WZDX_DEVICE_STATUSES,
  WZDX_DEVICE_TYPES,
} from "../crosswalk/infrastructure.js";
import { roadsModule } from "../module.js";
import {
  DATEX2_V2_INFRASTRUCTURE,
  DATEX2_V3_INFRASTRUCTURE,
} from "../vocabularies/datex2-infrastructure.js";
import { WZDX_DEVICES } from "../vocabularies/wzdx-devices.js";

/**
 * Coverage of the infrastructure crosswalks: every value the standards define
 * is mapped or explicitly `null`, every table key is a real value, and every
 * mapped classification, property or vocabulary value is registered.
 */
const registry = buildRegistry([kernelModule, roadsModule]);
type Table = Readonly<Record<string, string | null>>;

const union = (...lists: readonly (readonly string[])[]) => [...new Set(lists.flat())];

function expectCovers(table: Table, values: readonly string[], key = (v: string) => v) {
  const keys = values.map(key);
  expect(keys.filter((k) => !(k in table))).toEqual([]);
  expect(Object.keys(table).filter((k) => !keys.includes(k))).toEqual([]);
}

function isFeature(code: string): boolean {
  const [kind, type] = code.split(".");
  const entry = registry.kind("feature", kind!);
  return entry !== undefined && (type === undefined || type in (entry.types ?? {}));
}

const mapped = (table: Table) => Object.values(table).filter((v): v is string => v !== null);

describe("roads infrastructure crosswalk coverage", () => {
  it("maps every DATEX vmsType of both versions to a registered sign type", () => {
    expectCovers(
      DATEX2_VMS_TYPES,
      union(DATEX2_V3_INFRASTRUCTURE.vmsTypes, DATEX2_V2_INFRASTRUCTURE.vmsTypes),
      (v) => `vmsType:${v}`,
    );
    expect(mapped(DATEX2_VMS_TYPES).filter((c) => !isFeature(c))).toEqual([]);
  });

  it("maps every WZDx field device type to a registered feature or null", () => {
    expectCovers(WZDX_DEVICE_TYPES, WZDX_DEVICES.fieldDeviceTypes, (v) => `device_type:${v}`);
    expect(mapped(WZDX_DEVICE_TYPES).filter((c) => !isFeature(c))).toEqual([]);
  });

  it.each([
    ["vms_working_status", DATEX2_VMS_WORKING_STATUSES, DATEX2_V3_INFRASTRUCTURE.workingStatuses],
    ["device_status", DATEX2_DEVICE_HEALTH, DATEX2_V3_INFRASTRUCTURE.deviceHealth],
    ["device_status", WZDX_DEVICE_STATUSES, WZDX_DEVICES.fieldDeviceStatuses],
    [
      "los",
      DATEX2_TRAFFIC_STATUSES,
      union(DATEX2_V3_INFRASTRUCTURE.trafficStatuses, DATEX2_V2_INFRASTRUCTURE.trafficStatuses),
    ],
  ] as const)("maps every source status to %s", (vocabulary, table, values) => {
    expectCovers(table, values);
    const registered = registry.vocabulary(vocabulary)!.values;
    expect(mapped(table).filter((v) => !registered.includes(v))).toEqual([]);
  });

  it("covers every DATEX traffic measured value of both versions", () => {
    const leaves = new Set<string>();
    for (const v of [DATEX2_V3_INFRASTRUCTURE, DATEX2_V2_INFRASTRUCTURE]) {
      for (const [cls, paths] of Object.entries(v.measuredValues)) {
        if (paths.length === 0) leaves.add(cls);
        for (const p of paths) leaves.add(`${cls}/${p}`);
      }
    }
    const covered = (leaf: string) =>
      leaf in DATEX2_MEASURED_TRAFFIC || leaf.split("/")[0]! in DATEX2_MEASURED_TRAFFIC;
    expect([...leaves].filter((l) => !covered(l))).toEqual([]);
    const known = (key: string) =>
      leaves.has(key) || [...leaves].some((l) => l.startsWith(`${key}/`));
    expect(Object.keys(DATEX2_MEASURED_TRAFFIC).filter((k) => !known(k))).toEqual([]);
    expect(mapped(DATEX2_MEASURED_TRAFFIC).filter((p) => !registry.property(p))).toEqual([]);
  });

  it("resolves the mapped codes through the module's crosswalk", () => {
    expect(registry.crosswalk.feature("datex2_v3", "vmsType:colourGraphic")).toEqual({
      kind: "vms",
      type: "matrix",
    });
    expect(registry.crosswalk.feature("datex2_v2", "vmsType:matrixSign")).toEqual({
      kind: "vms",
      type: "pictogram",
    });
    expect(registry.crosswalk.feature("datex2_v2", "vmsType:rollerBlindSign")).toBeUndefined();
    expect(registry.crosswalk.property("datex2_v2", "TrafficFlow/vehicleFlow")).toBe(
      "traffic.volume",
    );
    expect(registry.crosswalk.value("los", "datex2_v2", "impossible")).toBe("blocked");
    expect(registry.crosswalk.value("los", "datex2_v3", "impossible")).toBeUndefined();
  });
});
