import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { readJmaReport } from "../jma/report.js";
import { applyJmaReports } from "../jma/state.js";

const xml = readFileSync(new URL("./fixtures/jma/33_12_01_240613_VXSE52.xml", import.meta.url));
const report = readJmaReport(xml, "VXSE52");
test("family tombstones survive serialized state and block old replay", () => {
  const initial = applyJmaReports({}, [report]);
  const cancel = {
    ...report,
    cancelled: true,
    controlAt: "2012-02-14T13:00:00Z",
    earthquake: undefined,
  };
  const ended = applyJmaReports(initial, [cancel]);
  expect(applyJmaReports(JSON.parse(JSON.stringify(ended)), [report])).toEqual(ended);
  expect(Object.values(ended)[0]?.cancelled).toBe(true);
  expect(applyJmaReports(ended, [])).toEqual(ended);
});
test("conflicting same-clock revisions refuse the whole poll", () => {
  expect(() => applyJmaReports({}, [report, { ...report, serial: "2" }])).toThrow();
});
