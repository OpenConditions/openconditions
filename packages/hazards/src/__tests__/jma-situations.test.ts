import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { readJmaReport } from "../jma/report.js";
import { jmaSituations } from "../jma/situations.js";
import { applyJmaAreaReports } from "../jma/state.js";

const report = readJmaReport(
  readFileSync(new URL("./fixtures/jma/33_12_01_240613_VXSE52.xml", import.meta.url)),
  "VXSE52",
);
const feed = {
  id: "jp-jma-quakes",
  format: "jma-xml",
  attribution: "JMA; normalized by OpenConditions",
  license: "CC-BY-4.0",
  country: "JP",
};
const url = "https://www.data.jma.go.jp/developer/xml/data/20261106104333_0_VXSE52_010000.xml";
test("native drafts retain unknown magnitude, source clock and XML without CAP", () => {
  const state = applyJmaAreaReports({ products: {}, areas: {} }, [{ ...report, messageUrl: url }]);
  const [draft] = jmaSituations(feed, state, "2012-02-14T01:00:00Z");
  expect(draft?.["details"]).toMatchObject({
    kind: "natural_hazard",
    jma: { messageUrl: url, nativeXml: report.nativeXml },
  });
  expect(draft?.["details"]).not.toHaveProperty("magnitude");
  expect(draft?.["location"]).toMatchObject({
    geometry: { type: "Point", coordinates: [136.6, 35.6] },
  });
  expect(
    jmaSituations(
      feed,
      applyJmaAreaReports(state, [
        { ...report, messageUrl: url, controlAt: "2012-02-15T00:00:00Z", cancelled: true },
      ]),
      "2012-02-15T00:00:00Z",
    ),
  ).toEqual([]);
});
test("unreviewed offices fail closed", () => {
  const state = applyJmaAreaReports({ products: {}, areas: {} }, [
    { ...report, messageUrl: url, publishingOffice: "uncleared partner" },
  ]);
  expect(() => jmaSituations(feed, state, "2012-02-14T01:00:00Z")).toThrow("office");
});
