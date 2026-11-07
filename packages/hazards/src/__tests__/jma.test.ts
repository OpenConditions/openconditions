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

test("malformed unknown coordinates and contradictory nil dates fail closed", () => {
  expect(() => jmaCoordinate("garbageNaN/", "degree")).toThrow();
  const xml = fixture("33_12_01_240613_VXSE52").toString();
  expect(() =>
    readJmaReport(
      Buffer.from(
        xml.replace(
          "<OriginTime>",
          '<OriginTime xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true">',
        ),
      ),
      "VXSE52",
    ),
  ).toThrow();
});

test("qualitative shallow depth remains unknown across native line breaks", () => {
  const xml = fixture("33_12_01_240613_VXSE52")
    .toString()
    .replace("深さ　１０ｋｍ", "ごく\n浅い")
    .replace("-10000/", "+0/");
  expect(readJmaReport(Buffer.from(xml), "VXSE52").earthquake?.depthM).toBeUndefined();
});

test("unsupported warning systems and volcanic code/wording pairs fail closed", () => {
  const rain = fixture("VPWW55_JPTF_170922").toString();
  expect(() =>
    readJmaReport(
      Buffer.from(rain.replaceAll("気象警報・注意報（市町村等）", "未審査区域")),
      "VPWW55",
    ),
  ).toThrow("system");
  const volcano = fixture("45_01_01_200522_VFVO50").toString();
  for (const xml of [
    volcano.replaceAll("<Code>13</Code>", "<Code>99</Code>"),
    volcano.replaceAll("レベル３（入山規制）", "レベル１（活火山であることに留意）"),
    volcano.replaceAll('codeType="火山名"', 'codeType="未審査区域"'),
  ])
    expect(() => readJmaReport(Buffer.from(xml), "VFVO50")).toThrow();
});

test("impossible calendar dates and mismatched magnitude units are refused", () => {
  const xml = fixture("33_12_01_240613_VXSE52").toString();
  expect(() =>
    readJmaReport(Buffer.from(xml.replaceAll("2012-02-14", "2012-02-31")), "VXSE52"),
  ).toThrow("time");
  expect(() =>
    readJmaReport(Buffer.from(xml.replace('type="Mj"', 'type="Mj" unit="km"')), "VXSE52"),
  ).toThrow("unit");
});

test.each(["以上", "以浅", "不明", "ごく浅い"])(
  "qualitative depth %s carries no numeric depth",
  (qualifier) => {
    const xml = fixture("33_12_01_240613_VXSE52").toString().replace("深さ　１０ｋｍ", qualifier);
    expect(readJmaReport(Buffer.from(xml), "VXSE52").earthquake?.depthM).toBeUndefined();
  },
);

test("native shaking areas keep distinct code systems and validated intensity tokens", () => {
  const xml = fixture("32-35_01_03_240613_VXSE53").toString();
  const r = readJmaReport(Buffer.from(xml), "VXSE53");
  expect(r.earthquake?.shakingAreas).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ system: "地震情報／細分区域", code: "440", maxIntensity: "5-" }),
      expect.objectContaining({
        system: "気象・地震・火山情報／市町村等",
        code: "2230600",
        maxIntensity: "5-",
      }),
      expect.objectContaining({ system: "震度観測点" }),
    ]),
  );
  expect(() =>
    readJmaReport(Buffer.from(xml.replace("<Int>5-</Int>", "<Int>MMI</Int>")), "VXSE53"),
  ).toThrow("intensity");
});

test.each([
  ["VXSE51", "32-35_01_01_100806_VXSE51"],
  ["VXSE52", "33_12_01_240613_VXSE52"],
  ["VXSE53", "32-35_01_03_240613_VXSE53"],
  ["VPWW55", "VPWW55_JPTF_170922"],
  ["VPWW56", "VPWW56_JPTF_170922"],
  ["VPWW57", "VPWW57_JPTF_151056"],
  ["VFVO50", "45_01_01_200522_VFVO50"],
] as const)(
  "%s operational headers support corrections and exclude exercises/tests",
  (family, name) => {
    const original = fixture(name).toString();
    for (const status of ["通常", "訓練", "試験"]) {
      const xml = original
        .replace(/<Status>[^<]+<\/Status>/, `<Status>${status}</Status>`)
        .replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>");
      expect(readJmaReport(Buffer.from(xml), family)).toMatchObject({
        infoType: "訂正",
        operational: status === "通常",
      });
    }
    expect(() =>
      readJmaReport(
        Buffer.from(
          original.replace(
            /<InfoKindVersion>[^<]+<\/InfoKindVersion>/,
            "<InfoKindVersion>99.0_0</InfoKindVersion>",
          ),
        ),
        family,
      ),
    ).toThrow("header");
  },
);
