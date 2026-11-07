import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { jmaCoordinate, readJmaReport } from "../jma/report.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/jma/${name}.xml`, import.meta.url));
describe("native JMA reports", () => {
  test.each(["32-35_06_02_100915_VXSE52", "32-35_06_06_100915_VXSE53"])(
    "cancellation without geometry: %s",
    (name) => {
      const r = readJmaReport(fixture(name), name.endsWith("52") ? "VXSE52" : "VXSE53");
      expect(r.eventId).toBe("20080614084350");
      expect(r.cancelled).toBe(true);
      expect(r.controlAt).toMatch(/^2008-06-1/);
      expect(r.earthquake).toBeUndefined();
    },
  );
  test("NaN is unknown, never zero", () => {
    const r = readJmaReport(fixture("33_12_01_240613_VXSE52"), "VXSE52");
    expect(r.earthquake?.magnitude).toBeUndefined();
    expect(r.earthquake?.position).toEqual([136.6, 35.6]);
    expect(r.earthquake?.depthM).toBe(10000);
  });
  test("coordinate units must be explicit", () => {
    expect(jmaCoordinate("+4323.18+14400.51+1499/", "degree-minute")).toEqual([
      144.0085, 43.38633333333334,
    ]);
    expect(() => jmaCoordinate("+4323.18+14400.51+1499/", "degree")).toThrow();
  });
  test("truncation, entities and namespace substitution fail whole", () => {
    const b = fixture("33_12_01_240613_VXSE52").toString();
    for (const s of [
      b.slice(0, -20),
      b.replace("<Report", '<!DOCTYPE x [<!ENTITY a "x">]><Report'),
      b.replaceAll("http://xml.kishou.go.jp/jmaxml1/", "https://attacker.invalid/"),
    ]) {
      expect(() => readJmaReport(Buffer.from(s), "VXSE52")).toThrow();
    }
  });
});

test("official rain timeline preserves escalation, downgrade and release wording", () => {
  const names = ["170922", "170925", "170928", "170930", "170932", "170934", "170936", "170938"];
  const levels = names.map((n) => readJmaReport(fixture(`VPWW55_JPTF_${n}`), "VPWW55"));
  expect(levels[0]?.eventId).toBe("");
  expect(levels[0]?.serial).toBe("");
  expect(levels.map((r) => r.warnings[0]?.wording)).toEqual([
    "レベル２大雨注意報",
    "レベル３大雨警報",
    "レベル４大雨危険警報",
    "レベル５大雨特別警報",
    "レベル４大雨危険警報",
    "レベル３大雨警報",
    "レベル２大雨注意報",
    "レベル２大雨注意報",
  ]);
  expect(levels.at(-1)?.warnings[0]?.status).toBe("解除");
  expect(levels.every((r) => !r.cancelled)).toBe(true);
});
test("a native volcanic warning retains volcano and municipality code systems without making a footprint", () => {
  const r = readJmaReport(fixture("45_01_01_200522_VFVO50"), "VFVO50");
  expect(r.eventId).toBe("306");
  expect(r.warnings[0]).toMatchObject({ area: "306", code: "13", status: "引上げ" });
  expect(r.earthquake).toBeUndefined();
});

test("header family, version, status and nested namespaces fail closed", () => {
  const xml = fixture("33_12_01_240613_VXSE52").toString();
  for (const invalid of [
    xml.replace("1.0_1", "99.0_0"),
    xml.replace("<Status>通常</Status>", "<Status>不明</Status>"),
    xml.replace("<Earthquake>", '<Earthquake xmlns="https://attacker.invalid/">'),
    xml.replace("<InfoKind>震源速報</InfoKind>", "<InfoKind>地震情報</InfoKind>"),
  ])
    expect(() => readJmaReport(Buffer.from(invalid), "VXSE52")).toThrow();
});

test.each([
  [
    "VPWW56",
    ["170922", "170925", "170928", "170930", "170932", "170936", "170938"],
    ["29", "09", "49", "39", "49", "29", "29"],
  ],
  [
    "VPWW57",
    ["151056", "151653", "152115", "160734", "161105", "161106"],
    ["19", "08", "48", "38", "48", "48"],
  ],
] as const)(
  "official %s timeline retains native warning codes and release",
  (family, names, codes) => {
    const reports = names.map((n) => readJmaReport(fixture(`${family}_JPTF_${n}`), family));
    expect(reports.map((r) => r.warnings[0]?.code)).toEqual(codes);
    expect(reports.at(-1)?.warnings[0]?.status).toBe("解除");
  },
);

test("observed volcanic downgrade is a warning release, not message cancellation", () => {
  const r = readJmaReport(fixture("20261104010017_0_VFVO50_016000"), "VFVO50");
  expect(r.eventId).toBe("105");
  expect(r.cancelled).toBe(false);
  expect(r.warnings[0]).toMatchObject({
    system: "火山名",
    area: "105",
    code: "11",
    status: "引下げ",
  });
  expect(r.warnings.find((w) => w.area === "0120600")).toMatchObject({
    system: "気象・地震・火山情報／市町村等",
    code: "04",
    status: "解除",
  });
  expect(r.earthquake).toBeUndefined();
});
