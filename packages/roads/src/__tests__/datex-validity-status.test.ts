import { type Effect, effectStateAt, type Validity } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { parseDatexSituations, parseDatexSnapshot } from "../datex.js";
import { parseEvents } from "../parse.js";
import { reconcileRoadSnapshots } from "../snapshot.js";
import { roadFeed } from "./helpers/road-feed.js";

/**
 * Every `ValidityStatusEnum` literal of DATEX II v2.3 (`active`, `suspended`,
 * `definedByValidityTimeSpec`) and v3.7 (adding `planned` and `_extended`),
 * each in a document that validates against that version's official schema.
 */
const FETCHED_AT = "2026-09-18T10:00:00.000Z";
const SOURCE = {
  id: "xx-test-events",
  country: "NL",
  attribution: "test",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
} as const;

function v3(validityStatus: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:sit="http://datex2.eu/schema/3/situation" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:com="http://datex2.eu/schema/3/common" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="sit:SituationPublication" lang="en" modelBaseVersion="3">
  <com:publicationTime>2026-09-18T09:00:00Z</com:publicationTime>
  <com:publicationCreator><com:country>nl</com:country><com:nationalIdentifier>TEST</com:nationalIdentifier></com:publicationCreator>
  <sit:situation id="S1">
    <sit:headerInformation><com:informationStatus>real</com:informationStatus></sit:headerInformation>
    <sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="R1" version="1">
      <sit:situationRecordCreationTime>2026-09-18T08:00:00Z</sit:situationRecordCreationTime>
      <sit:situationRecordVersionTime>2026-09-18T08:00:00Z</sit:situationRecordVersionTime>
      <sit:probabilityOfOccurrence>certain</sit:probabilityOfOccurrence>
      <sit:validity>
        ${validityStatus}
        <com:validityTimeSpecification><com:overallStartTime>2026-09-18T08:00:00Z</com:overallStartTime></com:validityTimeSpecification>
      </sit:validity>
      <sit:locationReference xsi:type="loc:PointLocation">
        <loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>52.37</loc:latitude><loc:longitude>4.89</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates>
      </sit:locationReference>
      <sit:operatorActionStatus>implemented</sit:operatorActionStatus>
      <sit:complianceOption>mandatory</sit:complianceOption>
      <sit:roadOrCarriagewayOrLaneManagementType>roadClosed</sit:roadOrCarriagewayOrLaneManagementType>
    </sit:situationRecord>
  </sit:situation>
</d2:payload>`;
}

function v2(validityStatus: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="2">
  <exchange><supplierIdentification><country>nl</country><nationalIdentifier>TEST</nationalIdentifier></supplierIdentification></exchange>
  <payloadPublication xsi:type="SituationPublication" lang="en">
    <publicationTime>2026-09-18T09:00:00Z</publicationTime>
    <publicationCreator><country>nl</country><nationalIdentifier>TEST</nationalIdentifier></publicationCreator>
    <situation id="S1" version="1">
      <headerInformation><confidentiality>noRestriction</confidentiality><informationStatus>real</informationStatus></headerInformation>
      <situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" id="R1" version="1">
        <situationRecordCreationTime>2026-09-18T08:00:00Z</situationRecordCreationTime>
        <situationRecordVersionTime>2026-09-18T08:00:00Z</situationRecordVersionTime>
        <probabilityOfOccurrence>certain</probabilityOfOccurrence>
        <validity>
          ${validityStatus}
          <validityTimeSpecification><overallStartTime>2026-09-18T08:00:00Z</overallStartTime></validityTimeSpecification>
        </validity>
        <groupOfLocations xsi:type="Point">
          <pointByCoordinates><pointCoordinates><latitude>52.37</latitude><longitude>4.89</longitude></pointCoordinates></pointByCoordinates>
        </groupOfLocations>
        <operatorActionStatus>implemented</operatorActionStatus>
        <complianceOption>mandatory</complianceOption>
        <roadOrCarriagewayOrLaneManagementType>roadClosed</roadOrCarriagewayOrLaneManagementType>
      </situationRecord>
    </situation>
  </payloadPublication>
</d2LogicalModel>`;
}

const v3Status = (value: string, attrs = "") =>
  v3(`<com:validityStatus${attrs}>${value}</com:validityStatus>`);
const v2Status = (value: string) => v2(`<validityStatus>${value}</validityStatus>`);

function draftOf(xml: string, complete = false) {
  const feed = roadFeed({
    id: SOURCE.id,
    ...(complete ? { snapshot: { completeness: "complete" as const } } : {}),
  });
  const { situations } = parseEvents(feed, [Buffer.from(xml)], { fetchedAt: FETCHED_AT });
  expect(situations).toHaveLength(1);
  const draft = situations[0]!;
  const validity = draft["validity"] as Validity;
  const effects = draft["effects"] as Effect[];
  expect(effects.length).toBeGreaterThan(0);
  return {
    validity,
    temporality: draft["temporality"],
    effects,
    states: effects.map((e) => effectStateAt(e, validity, new Date(FETCHED_AT)).state),
  };
}

describe("DATEX validityStatus", () => {
  describe.each([
    ["v2.3", v2Status],
    ["v3.7", v3Status],
  ])("%s", (_version, doc) => {
    it.each(["active", "definedByValidityTimeSpec"])(
      "keeps %s in force within its time specification",
      (status) => {
        const [event] = parseDatexSituations(doc(status), SOURCE);
        expect(event?.status).toBe("active");
        const draft = draftOf(doc(status));
        expect(draft.validity.status).toBe("active");
        expect(draft.effects.flatMap((e) => e.issues ?? [])).toEqual([]);
        expect(draft.states.every((s) => s === "active")).toBe(true);
      },
    );

    it("keeps suspended out of effect whatever its time specification", () => {
      const [event] = parseDatexSituations(doc("suspended"), SOURCE);
      expect(event?.status).toBe("inactive");
      const draft = draftOf(doc("suspended"));
      expect(draft.validity.status).toBe("suspended");
      expect(draft.states.every((s) => s === "unknown")).toBe(true);
      for (const effect of draft.effects) {
        expect(effect.issues).toContainEqual({
          code: "unsupported_status",
          sourcePath: "situationRecord.validity.validityStatus",
          sourceTokens: { validityStatus: "suspended" },
        });
      }
      const snapshot = reconcileRoadSnapshots([parseDatexSnapshot(doc("suspended"), SOURCE)]);
      expect(snapshot.terminalIds).toEqual([`${SOURCE.id}:R1`]);
    });
  });

  it("publishes v3 planned as planned, scheduled and never active", () => {
    const xml = v3Status("planned");
    const [event] = parseDatexSituations(xml, SOURCE);
    expect(event?.situation?.validityStatus).toBe("planned");
    for (const complete of [false, true]) {
      const draft = draftOf(xml, complete);
      expect(draft.validity.status).toBe("planned");
      expect(draft.temporality).toBe("scheduled");
      expect(draft.states.every((s) => s === "unknown")).toBe(true);
      for (const effect of draft.effects) {
        expect(effect.issues).toContainEqual({
          code: "unsupported_status",
          sourcePath: "situationRecord.validity.validityStatus",
          sourceTokens: { validityStatus: "planned" },
        });
      }
    }
    // A planned record is still current source content, not a withdrawal.
    const snapshot = reconcileRoadSnapshots([parseDatexSnapshot(xml, SOURCE)]);
    expect(snapshot.acceptedIds).toEqual([`${SOURCE.id}:R1`]);
    expect(snapshot.terminalIds).toEqual([]);
  });

  it("reports a v3 _extended status as unknown with its extended value", () => {
    const xml = v3Status("_extended", ' _extendedValue="closedForSeason"');
    const draft = draftOf(xml);
    expect(draft.validity.status).toBe("unknown");
    expect(draft.states.every((s) => s === "unknown")).toBe(true);
    for (const effect of draft.effects) {
      expect(effect.issues).toContainEqual({
        code: "unsupported_status",
        sourcePath: "situationRecord.validity.validityStatus",
        sourceTokens: { validityStatus: "_extended", extendedValue: "closedForSeason" },
      });
    }
    const snapshot = reconcileRoadSnapshots([parseDatexSnapshot(xml, SOURCE)]);
    expect(snapshot.acceptedIds).toEqual([`${SOURCE.id}:R1`]);
  });

  // Not schema-valid: an unrecognised literal and a missing mandatory status.
  it.each([
    ["an unrecognised", v3Status("somethingNew"), { validityStatus: "somethingNew" }],
    ["a missing", v3(""), { validityStatus: null }],
  ])("does not read %s status as active", (_label, xml, sourceTokens) => {
    const draft = draftOf(xml);
    expect(draft.validity.status).toBe("unknown");
    expect(draft.states.every((s) => s === "unknown")).toBe(true);
    for (const effect of draft.effects) {
      expect(effect.issues).toContainEqual({
        code: "unsupported_status",
        sourcePath: "situationRecord.validity.validityStatus",
        sourceTokens,
      });
    }
  });
});
