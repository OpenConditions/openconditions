import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSevasSnapshot } from "../sevas.js";
import { reconcileRoadSnapshots } from "../snapshot.js";

const SOURCE = {
  id: "de-nw-sevas-conditions",
  country: "DE",
  attribution: "NRW.Mobidrom / SEVAS",
  license: "DL-DE-ZERO-2.0",
  licenseUrl: "https://www.govdata.de/dl-de/zero-2-0",
};
const FIXTURE = readFileSync(new URL("./fixtures/sevas/restrictions.gml", import.meta.url), "utf8");

describe("SEVAS complete GML reader", () => {
  it("accounts real segments and converts explicit GML EPSG axes", () => {
    const report = parseSevasSnapshot(FIXTURE, SOURCE);
    expect(report.inputCount).toBe(14);
    expect(report.errors).toEqual([]);
    expect(report.records).toHaveLength(14);
    const first = report.records[0]!;
    expect(first.id).toBe(`${SOURCE.id}:segment-5855075`);
    expect(first.event?.geometry?.type).toBe("LineString");
    expect((first.event!.geometry as { coordinates: number[][] }).coordinates[0]).toEqual([
      8.294101, 51.158885,
    ]);
    expect(report.records.some((r) => r.disposition === "terminal")).toBe(true);
  });

  it.each([
    ["wrong count", (s: string) => s.replace('numberMatched="14"', 'numberMatched="15"')],
    ["unknown total", (s: string) => s.replace('numberMatched="14"', 'numberMatched="unknown"')],
    [
      "continuation",
      (s: string) =>
        s.replace('numberReturned="14"', 'numberReturned="14" next="https://sevas.nrw.de/next"'),
    ],
    ["truncation", (s: string) => s.slice(0, -50)],
    [
      "wrong namespace",
      (s: string) => s.replace("http://www.opengis.net/wfs/2.0", "https://wrong.test"),
    ],
    ["DTD", (s: string) => s.replace("?>", '?><!DOCTYPE x [<!ENTITY test "test">]>')],
    [
      "duplicate property",
      (s: string) => s.replace("<ms:typ>253</ms:typ>", "<ms:typ>253</ms:typ><ms:typ>253</ms:typ>"),
    ],
  ])("refuses %s instead of publishing an empty/partial source", (_name, mutate) => {
    expect(() => parseSevasSnapshot(mutate(FIXTURE), SOURCE)).toThrow();
  });

  it("protects known identities when geometry is unusable", () => {
    const bad = FIXTURE.replace(
      /<gml:posList[^>]*>[^<]+<\/gml:posList>/,
      '<gml:posList srsDimension="2">999 999 999 999</gml:posList>',
    );
    expect(parseSevasSnapshot(bad, SOURCE).records[0]?.disposition).toBe("unlocatable");
  });

  it("rejects missing identity and conflicting semantic duplicates", () => {
    const missing = FIXTURE.replace("<ms:segment_id>5855075</ms:segment_id>", "");
    expect(() => reconcileRoadSnapshots([parseSevasSnapshot(missing, SOURCE)])).toThrow();
    const report = parseSevasSnapshot(FIXTURE, SOURCE);
    const changed = FIXTURE.replace(
      "<ms:vz_1020_30>true</ms:vz_1020_30>",
      "<ms:vz_1020_30>false</ms:vz_1020_30>",
    );
    expect(() => reconcileRoadSnapshots([report, parseSevasSnapshot(changed, SOURCE)])).toThrow();
  });

  it("accepts an explicitly counted empty source", () => {
    const xml =
      '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0" numberReturned="0"/>';
    expect(parseSevasSnapshot(xml, SOURCE)).toMatchObject({
      inputCount: 0,
      records: [],
      errors: [],
    });
  });

  it.each(["244.1", "257-57", "250", "260", "251"])(
    "accounts non-scoped sign %s without rejecting a valid source",
    (code) => {
      const report = parseSevasSnapshot(
        FIXTURE.replace("<ms:typ>253</ms:typ>", `<ms:typ>${code}</ms:typ>`),
        SOURCE,
      );
      expect(report.records[0]?.disposition).toBe("terminal");
    },
  );
});
