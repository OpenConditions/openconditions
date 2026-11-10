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

test.each([
  "<Text>&#x8ee2;&#x8f09;&#x7981;&#x6b62;</Text>",
  "<Text>&#169; Partner</Text>",
  '<Text description="&#67;opyright Partner">native</Text>',
  "<!-- Copyright Partner; all rights reserved -->",
  "<![CDATA[Copyright Partner]]>",
  "<?credit Copyright Partner?>",
])("withholds semantic restrictions and uninspected native forms: %s", (extra) => {
  const xml = clean.replace("</Body>", extra + "</Body>");
  expect(() => assertJmaRights(readJmaReport(Buffer.from(xml), "VXSE52"))).toThrow();
});
test("predefined and numeric references have XML semantics while original bytes remain intact", () => {
  const xml = clean.replace(
    "</Body>",
    "<Text>A &amp; B &lt; C &quot;D&quot; &apos;E&apos; &#65; &#x42;</Text></Body>",
  );
  const report = readJmaReport(Buffer.from(xml), "VXSE52");
  expect(() => assertJmaRights(report)).not.toThrow();
  expect(report.nativeXml).toBe(xml);
});

test("XML declaration cannot conceal uninspected native credits", () => {
  const xml = clean.replace('encoding="UTF-8"', 'encoding="UTF-8" credit="Copyright Partner"');
  expect(() => assertJmaRights(readJmaReport(Buffer.from(xml), "VXSE52"))).toThrow();
});

test("current Niigata JMA rain is admitted while Kanagawa embedded partner material stays withheld", () => {
  const rain = readJmaReport(
    readFileSync(new URL("live-20261109/20261107070852_0_VPWW55_150000.xml", directory)),
    "VPWW55",
  );
  expect(() => assertJmaRights(rain)).not.toThrow();
  const partner = readJmaReport(
    readFileSync(new URL("VPWW56_JPTF_170922.xml", directory)),
    "VPWW56",
  );
  expect(() => assertJmaRights(partner)).toThrow("office");
});

test.each(["20261102175318_0_VXSE53_270000.xml", "20261106105615_0_VXSE53_010000.xml"])(
  "admits reviewed Osaka and native shaking revisions without changing captured bytes: %s",
  (name) => {
    const bytes = readFileSync(new URL(`live-20261109/${name}`, directory));
    const report = readJmaReport(bytes, "VXSE53");
    expect(() => assertJmaRights(report)).not.toThrow();
    expect(report.nativeXml).toBe(bytes.toString());
    expect(report.earthquake?.shakingAreas?.length).toBeGreaterThan(0);
    const restricted = {
      ...report,
      nativeXml: report.nativeXml.replace("</Body>", "<Text>転載禁止</Text></Body>"),
    };
    expect(() => assertJmaRights(restricted)).toThrow();
  },
);
