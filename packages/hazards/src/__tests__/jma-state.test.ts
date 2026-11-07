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

import { applyJmaAreaReports } from "../jma/state.js";

const rain = readJmaReport(
  readFileSync(new URL("./fixtures/jma/VPWW55_JPTF_170922.xml", import.meta.url)),
  "VPWW55",
);
test("area omissions and unchanged areas retain previous state across restart", () => {
  const state = applyJmaAreaReports({ areas: {}, products: {} }, [rain]);
  const changed = { ...rain, controlAt: "2026-02-17T01:00:00Z", warnings: [rain.warnings[0]!] };
  const next = applyJmaAreaReports(JSON.parse(JSON.stringify(state)), [changed]);
  expect(Object.keys(next.areas)).toHaveLength(Object.keys(state.areas).length);
  expect(applyJmaAreaReports(next, []).areas).toEqual(next.areas);
});
test("per-area releases survive old and empty replays", () => {
  const release = {
    ...rain,
    controlAt: "2026-02-17T01:00:00Z",
    warnings: [{ ...rain.warnings[0]!, status: "解除" }],
  };
  const state = applyJmaAreaReports({ areas: {}, products: {} }, [rain, release]);
  expect(Object.values(state.areas).filter((a) => a.ended)).toHaveLength(1);
  expect(applyJmaAreaReports(JSON.parse(JSON.stringify(state)), [rain])).toEqual(state);
});
test("cancelling one earthquake family leaves the other family intact", () => {
  const other = { ...report, family: "VXSE53" as const };
  const state = applyJmaReports({}, [report, other]);
  const next = applyJmaReports(state, [
    { ...report, cancelled: true, controlAt: "2012-02-14T13:00:00Z" },
  ]);
  expect(Object.values(next).find((r) => r.family === "VXSE53")?.cancelled).toBe(false);
});

test("batch recovery applies older area deltas before later partial reports", () => {
  const changed = { ...rain, controlAt: "2026-02-17T01:00:00Z", warnings: [rain.warnings[0]!] };
  const expected = applyJmaAreaReports(applyJmaAreaReports({ areas: {}, products: {} }, [rain]), [
    changed,
  ]);
  expect(applyJmaAreaReports({ areas: {}, products: {} }, [changed, rain])).toEqual(expected);
});

test("JSONB key ordering does not turn a duplicate into a same-clock conflict", () => {
  const original = report;
  const reordered = Object.fromEntries(
    Object.entries(original).reverse(),
  ) as unknown as typeof original;
  const held = applyJmaAreaReports({ products: {}, areas: {} }, [original]);
  expect(() => applyJmaAreaReports(held, [reordered])).not.toThrow();
});
