import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDatexSituations, parseDatexSnapshot } from "../datex.js";
import { parseDigitrafficSnapshot } from "../digitraffic.js";
import { reconcileRoadSnapshots } from "../snapshot.js";
import type { SourceDescriptor } from "../types.js";

const ndw = readFileSync(new URL("./fixtures/ndw/restrictions-v3.xml", import.meta.url), "utf8");
const finland = JSON.parse(
  readFileSync(new URL("./fixtures/digitraffic/v2-restrictions.json", import.meta.url), "utf8"),
);
const source: SourceDescriptor = {
  id: "nl-ndw",
  country: "NL",
  attribution: "NDW",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
};

const finlandSource: SourceDescriptor = {
  id: "fi-digitraffic",
  country: "FI",
  attribution: "Fintraffic / Digitraffic",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
};

describe("complete snapshot essential fields (synthetic mutations of reviewed captures)", () => {
  it("rejects reversed essential parent windows in both formats", () => {
    const xml = ndw.replace(/(<com:overallEndTime>)[^<]+/, "$12000-01-01T00:00:00Z");
    expect(parseDatexSnapshot(xml, source).errors).toContainEqual(
      expect.objectContaining({ code: "invalid_window" }),
    );
    const payload = structuredClone(finland);
    payload.features[0].properties.announcements[0].timeAndDuration.endTime =
      "2000-01-01T00:00:00Z";
    expect(parseDigitrafficSnapshot(payload, finlandSource).errors).toContainEqual(
      expect.objectContaining({ code: "invalid_window" }),
    );
  });

  it("labels DATEX publication-time fallback without inventing a record update", () => {
    const xml = ndw.replace(
      /<sit:situationRecordVersionTime>[^<]+<\/sit:situationRecordVersionTime>/g,
      "",
    );
    const report = parseDatexSnapshot(xml, source);
    expect(report.errors).toEqual([]);
    const event = report.records.find((record) => record.event?.restrictionDetails)?.event;
    expect(event).toMatchObject({
      dataUpdatedAt: "2026-09-12T07:13:00.000Z",
      restrictionDetails: { source: { sourceUpdatedAt: null } },
      sourceRaw: { observationTimestampBasis: { sourcePath: "publicationTime" } },
    });
  });

  it.each(["cancelled", "suspended", "archived"])(
    "accounts for %s before DATEX localization",
    (status) => {
      const xml = ndw
        .replace(
          /<com:validityStatus>[^<]+<\/com:validityStatus>/g,
          `<com:validityStatus>${status}</com:validityStatus>`,
        )
        .replace(/<sit:locationReference\b[\s\S]*?<\/sit:locationReference>/g, "");
      const report = reconcileRoadSnapshots([parseDatexSnapshot(xml, source)]);
      expect(report.terminalIds).toHaveLength(6);
      expect(report.unlocatableIds).toEqual([]);
      expect(report.observations).toEqual([]);
    },
  );

  it.each([
    ["version", (xml: string) => xml.replace('version="133"', 'version="invalid"')],
    [
      "version time",
      (xml: string) => xml.replace(/(<sit:situationRecordVersionTime>)[^<]+/, "$1invalid"),
    ],
    [
      "event start",
      (xml: string) => xml.replace(/(<com:overallStartTime>)[^<]+/, "$12026-02-30T10:00:00Z"),
    ],
  ])("rejects a supplied malformed DATEX %s", (_label, mutate) => {
    expect(parseDatexSnapshot(mutate(ndw), source).errors.length).toBeGreaterThan(0);
  });

  it("does not revive an older located version after the newest version loses its location", () => {
    const record = ndw
      .match(/<sit:situationRecord\b[\s\S]*?<\/sit:situationRecord>/g)!
      .find((record) => record.includes('version="133"'))!;
    const newer = record
      .replace('version="133"', 'version="134"')
      .replace(/<sit:locationReference\b[\s\S]*?<\/sit:locationReference>/g, "");
    const xml = ndw.replace(record, record + newer);
    expect(
      parseDatexSituations(xml, source).some((event) =>
        event.id.endsWith("RWS01_M1080891_NARROW_LANES_D2_WWA"),
      ),
    ).toBe(false);
  });

  it.each(["versionTime", "dataUpdatedTime", "releaseTime"])(
    "rejects malformed Finland %s even when fallback is available",
    (field) => {
      const payload = structuredClone(finland);
      payload.features[0].properties[field] = "2026-02-30T10:00:00Z";
      expect(parseDigitrafficSnapshot(payload, finlandSource).errors.length).toBeGreaterThan(0);
    },
  );

  it("rejects a malformed Finland parent event window before localization", () => {
    const payload = structuredClone(finland);
    payload.features[0].geometry = null;
    payload.features[0].properties.announcements[0].timeAndDuration.startTime = "invalid";
    expect(parseDigitrafficSnapshot(payload, finlandSource).errors.length).toBeGreaterThan(0);
  });

  it("uses labelled feed publication time without inventing a record update time", () => {
    const payload = structuredClone(finland);
    payload.features = [payload.features[0]];
    for (const key of ["versionTime", "dataUpdatedTime", "releaseTime"])
      delete payload.features[0].properties[key];
    payload.dataUpdatedTime = "2026-09-12T07:00:00Z";
    const report = parseDigitrafficSnapshot(payload, finlandSource, {
      fetchedAt: "2026-09-12T09:00:00Z",
    });
    expect(report.errors).toEqual([]);
    expect(report.records[0]?.event).toMatchObject({
      dataUpdatedAt: "2026-09-12T07:00:00.000Z",
      restrictionDetails: { source: { sourceUpdatedAt: null } },
      sourceRaw: {
        observationTimestampBasis: {
          sourcePath: "$.dataUpdatedTime",
          value: "2026-09-12T07:00:00.000Z",
        },
      },
    });
    delete payload.dataUpdatedTime;
    expect(parseDigitrafficSnapshot(payload, finlandSource).errors.length).toBeGreaterThan(0);
  });
});
