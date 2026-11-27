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
  it("accepts the provider's WFS boundedBy envelope without counting it as a member", () => {
    const xml = FIXTURE.replace(
      "<wfs:member>",
      '<wfs:boundedBy><gml:Envelope srsName="urn:ogc:def:crs:EPSG::4326"><gml:lowerCorner>50 6</gml:lowerCorner><gml:upperCorner>53 9</gml:upperCorner></gml:Envelope></wfs:boundedBy><wfs:member>',
    );
    expect(parseSevasSnapshot(xml, SOURCE).inputCount).toBe(14);
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
      "unexpected root member",
      (s: string) => s.replace("</wfs:FeatureCollection>", "<wfs:other/></wfs:FeatureCollection>"),
    ],
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
  it.each([
    '<gml:posList srsDimension="2">bad coordinates</gml:posList>',
    '<gml:posList srsDimension="3">51 8 1 52 9 2</gml:posList>',
  ])("accounts unusable coordinate syntax as unlocatable: %s", (replacement) => {
    const xml = FIXTURE.replace(/<gml:posList[^>]*>[^<]+<\/gml:posList>/, replacement);
    expect(parseSevasSnapshot(xml, SOURCE).records[0]?.disposition).toBe("unlocatable");
  });
  it("collapses identical duplicates without making them conflicting source revisions", () => {
    const report = parseSevasSnapshot(FIXTURE, SOURCE);
    const combined = reconcileRoadSnapshots([report, report]);
    expect(combined.inputCount).toBe(28);
    expect(combined.duplicates).toBe(14);
    expect(combined.observations).toHaveLength(13);
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

  it("ignores geometry serialization whitespace but fingerprints every source predicate", () => {
    const first = parseSevasSnapshot(FIXTURE, SOURCE).records[0]!;
    const spaced = FIXTURE.replace(
      /(<gml:posList[^>]*>)([^<]+)(<\/gml:posList>)/,
      (_s, a, b, c) => `${a}${b.trim().split(/\s+/).join("  \n ")}${c}`,
    );
    expect(parseSevasSnapshot(spaced, SOURCE).records[0]?.fingerprint).toBe(first.fingerprint);
    for (const token of [
      "<ms:vz_unrecognized>true</ms:vz_unrecognized>",
      "<ms:vz_1053_33>8,5</ms:vz_1053_33>",
    ]) {
      const changed = FIXTURE.replace(/<ms:vz_1053_33>[^<]*<\/ms:vz_1053_33>/, token);
      expect(parseSevasSnapshot(changed, SOURCE).records[0]?.fingerprint).not.toBe(
        first.fingerprint,
      );
    }
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
