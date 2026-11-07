import { expect, it } from "vitest";
import { roadsDomain } from "../domain.js";

it("registers a dedicated Caltrans CMS decoder", () => {
  expect(roadsDomain.formats["caltrans-cms"]?.kind).toBe("features");
});

import { readFileSync } from "node:fs";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { cmsTime, parseCaltransCms } from "../caltrans-cms.js";
import type { RoadFeed } from "../feed-schema.js";

const feed = {
  id: "us-ca-caltrans-d12-signs",
  format: "caltrans-cms",
  caltransDistrict: 12,
  attribution: "Caltrans",
  license: "LicenseRef-Caltrans-Conditions-of-Use",
  licenseUrl: "https://dot.ca.gov/conditions-of-use",
} as RoadFeed;
const ctx = { fetchedAt: "2026-11-07T08:00:00Z", cadenceSec: 60, reference: {} };
const rows = JSON.parse(
  readFileSync(new URL("./fixtures/caltrans-cms/d12.json.raw", import.meta.url), "utf8"),
).data;
const parse = (data: unknown[], config = feed) =>
  parseCaltransCms(config, { main: [Buffer.from(JSON.stringify({ data }))] }, ctx);
it("preserves all D12 repeated indexes and stable identities on reorder", () => {
  const a = parse(rows),
    b = parse([...rows].reverse());
  expect(a.features).toHaveLength(66);
  expect(new Set(a.features.map((f) => f.id)).size).toBe(66);
  expect(a.features.map((f) => f.id).sort()).toEqual(b.features.map((f) => f.id).sort());
});
it("does not authorize absence withdrawal from an unqualified payload", () => {
  expect(parse(rows).featuresComplete).toBe(false);
  expect(parse([]).featuresComplete).toBe(false);
});
it("requires qualified error-free snapshots for empty withdrawal", () => {
  expect(parse([], { ...feed, caltransSnapshotQualified: true }).featuresComplete).toBe(true);
  const invalid = structuredClone(rows[0]);
  invalid.cms.location.longitude = "-12.139908";
  expect(parse([invalid], { ...feed, caltransSnapshotQualified: true }).featuresComplete).toBe(
    false,
  );
});
it("rejects ambiguous identity without choosing the first row", () => {
  expect(() => parse([rows[0], rows[0]])).toThrow(/ambiguous/);
});
it("keeps coordinates out of identity and rekeys a renamed sign", () => {
  const a = structuredClone(rows[0]);
  a.cms.location.longitude = "-117.1234";
  expect(parse([a]).features[0]?.id).toBe(parse([rows[0]]).features[0]?.id);
  a.cms.location.locationName += " corrected";
  expect(parse([a]).features[0]?.id).not.toBe(parse([rows[0]]).features[0]?.id);
});
it("seals every captured feature and observation", () => {
  const registry = buildRegistry([kernelModule, roadsModule]);
  const out = parse(rows);
  const failures = [...out.features, ...out.observations].flatMap((d) => {
    const r = sealRecord(registry, d, {
      instanceId: "test.local",
      revision: 1,
      recordedAt: ctx.fetchedAt,
    });
    return r.ok ? [] : [r.issues];
  });
  expect(failures).toEqual([]);
});
it("rejects sentinel, invalid calendar, DST gap and fold clocks", () => {
  for (const [d, t] of [
    ["1969-12-31", "16:00:00"],
    ["1970-01-01", "00:00:00"],
    ["2026-02-30", "12:00:00"],
    ["2026-03-08", "02:30:00"],
    ["2026-11-01", "01:30:00"],
  ])
    expect(cmsTime(d, t)).toBeUndefined();
  expect(cmsTime("2026-07-01", "12:00:00")).toBe("2026-07-01T19:00:00.000Z");
  expect(cmsTime("2026-12-01", "12:00:00")).toBe("2026-12-01T20:00:00.000Z");
});
it("models ordered normal/flashing/two-page displays and clears stale lines for unavailable states", () => {
  const row = structuredClone(rows[0]);
  row.cms.message.phase1 = { phase1Line1: "ONE", phase1Line2: "", phase1Line3: "THREE" };
  row.cms.message.phase2 = { phase2Line1: "FOUR", phase2Line2: "FIVE", phase2Line3: "SIX" };
  for (const [service, mode, want, pages] of [
    ["true", "1 Page (Normal)", "in_service", 1],
    ["True", "1 Page (Flashing)", "in_service", 1],
    ["true", "2 Pages (Extended)", "in_service", 2],
    ["True", "Blank", "blank", 0],
    ["false", "1 Page (Normal)", "out_of_service", 0],
    ["False", "Blank", "out_of_service", 0],
    ["Not Reported", "1 Page (Normal)", "unknown", 0],
    ["true", "Not Reported", "unknown", 0],
  ] as const) {
    row.cms.inService = service;
    row.cms.message.display = mode;
    const value = (
      parse([row]).observations[0]!.result as {
        value: { workingStatus: string; messages: { text: unknown[]; flashing: boolean }[] };
      }
    ).value;
    expect(value.workingStatus).toBe(want);
    expect(value.messages[0]?.text.length ?? 0).toBe(pages);
    if (pages) expect(value.messages[0]?.flashing).toBe(mode === "1 Page (Flashing)");
    else expect(value.messages).toEqual([]);
  }
});
it("uses configured district despite missing wire district; rejects missing configuration and invalid envelopes", () => {
  const row = structuredClone(rows[0]);
  row.cms.location.district = "Not Reported";
  expect(parse([row]).features).toHaveLength(1);
  expect(() => parse([row], { ...feed, caltransDistrict: undefined })).toThrow(/district/);
  expect(() => parseCaltransCms(feed, { main: [Buffer.from("{}")] }, ctx)).toThrow(/array/);
});
it("retains distinct D03/D11 duplicates and drops placeholders/implausible positions without snapshot authority", () => {
  for (const [district, count] of [
    [2, 42],
    [3, 107],
    [11, 80],
  ]) {
    const data = JSON.parse(
      readFileSync(
        new URL(
          `./fixtures/caltrans-cms/d${String(district).padStart(2, "0")}.json.raw`,
          import.meta.url,
        ),
        "utf8",
      ),
    ).data;
    const out = parse(data, { ...feed, caltransDistrict: district });
    expect(out.features).toHaveLength(count);
    expect(new Set(out.features.map((f) => f.id)).size).toBe(count);
    expect(out.featuresComplete).toBe(false);
  }
});
