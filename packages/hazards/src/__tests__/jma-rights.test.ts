import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type JmaFamily, readJmaReport } from "../jma/report.js";
import { assertJmaRights } from "../jma/rights.js";

const directory = new URL("./fixtures/jma/", import.meta.url);
const clean = readFileSync(new URL("33_12_01_240613_VXSE52.xml", directory)).toString();
test("reviews every retained fixture and withholds the actual Kanagawa partner without changing bytes", () => {
  let withheld = 0;
  for (const name of readdirSync(directory).filter((n) => n.endsWith(".xml"))) {
    const xml = readFileSync(new URL(name, directory));
    const family = /(?:VXSE|VPWW|VFVO)\d{2}/.exec(name)![0] as JmaFamily;
    const report = readJmaReport(xml, family);
    if (xml.includes(Buffer.from("神奈川県県土整備局河川下水道部砂防課"))) {
      expect(() => assertJmaRights(report)).toThrow("office");
      withheld++;
    } else expect(() => assertJmaRights(report)).not.toThrow();
    expect(report.nativeXml).toBe(xml.toString());
  }
  expect(withheld).toBe(7);
});
test.each([
  clean.replace(
    "<PublishingOffice>気象庁</PublishingOffice>",
    "<PublishingOffice>partner</PublishingOffice>",
  ),
  clean.replace(
    "<EditorialOffice>気象庁本庁</EditorialOffice>",
    "<EditorialOffice>partner</EditorialOffice>",
  ),
  clean.replace(
    "</Body>",
    '<OfficeInfo><Office type="補足情報担当"><Name>partner</Name></Office></OfficeInfo></Body>',
  ),
  clean.replace("</Body>", "<Credit>partner</Credit></Body>"),
  clean.replace("</Body>", "<Text>転載禁止</Text></Body>"),
  clean.replace("</Body>", '<Text rights="all rights reserved">native</Text></Body>'),
])("refuses unknown authorities, embedded credits and explicit restrictions", (xml) => {
  expect(() => assertJmaRights(readJmaReport(Buffer.from(xml), "VXSE52"))).toThrow();
});
