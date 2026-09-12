import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDatexSituations, parseDatexSnapshot } from "../datex.js";
import { projectRoadRestrictionDetails } from "../restrictions.js";
import { reconcileRoadSnapshots } from "../snapshot.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Source fixture: the reviewed 2026-09-12 NDW capture reduced to six real
 * records. Every mutation below is synthetic and labelled as such; each one is
 * applied to the source XML and reparsed, so the assertions exercise the real
 * extraction path rather than hand-built expectations.
 */
const xml = readFileSync(new URL("./fixtures/ndw/restrictions-v3.xml", import.meta.url), "utf8");

const ndwSource: SourceDescriptor = {
  id: "nl-ndw",
  attribution: "NDW / Rijkswaterstaat",
  country: "NL",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
};

const HEIGHT_SUFFIX = ":RWS01_M1080891_NARROW_LANES_D2_WWA";
const LORRY_POSITIVE_ID = "nl-ndw:NLRWS_0005382945_1";
const LORRY_NEGATIVE_ID = "nl-ndw:NLRWS_0005406494_1";

const HEIGHT_VALIDITY =
  "<sit:validity><com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2025-09-05T22:59:03Z</com:overallStartTime><com:overallEndTime>2027-03-30T21:59:00Z</com:overallEndTime></com:validityTimeSpecification></sit:validity>";

// biome-ignore lint/suspicious/noExplicitAny: observations are a union of resolved and unresolved events.
function eventOf(id: string, source = xml): any {
  const found = reconcileRoadSnapshots([parseDatexSnapshot(source, ndwSource)]).observations.find(
    (e) => e.id === id,
  );
  if (!found) throw new Error(`no observation ${id}`);
  return found;
}

// biome-ignore lint/suspicious/noExplicitAny: the same union as above.
function heightOf(source = xml): any {
  const found = reconcileRoadSnapshots([parseDatexSnapshot(source, ndwSource)]).observations.find(
    (e) => e.id.endsWith(HEIGHT_SUFFIX),
  );
  if (!found) throw new Error("no height observation");
  return found;
}

/** The evaluated view of the height record at a fixed instant. */
function heightView(source = xml, at = new Date("2026-09-12T07:14:00Z")) {
  const details = heightOf(source).restrictionDetails;
  const projected = projectRoadRestrictionDetails(details, {
    at,
    sourceCheckedAt: "2026-09-12T07:13:00Z",
    freshnessWindowSec: 300,
  });
  if (!projected.restrictionDetails) throw new Error("height details did not project");
  return projected.restrictionDetails;
}

/** Replace only the height record's validity block with a synthetic variant. */
function withHeightValidity(replacement: string): string {
  if (!xml.includes(HEIGHT_VALIDITY)) throw new Error("fixture height validity moved");
  // Only the first occurrence belongs to the height record.
  return xml.replace(HEIGHT_VALIDITY, replacement);
}

describe("ndw source direction and location references", () => {
  it("keeps the height record's nested Alert-C direction and identifiers apart", () => {
    const fact = heightOf().restrictionDetails.facts[0];
    expect(fact.direction).toEqual({
      basis: "alert_c",
      value: "positive",
      description: "aligned",
    });
    expect(fact.scope.sourceLocationRefs).toMatchObject({
      scheme: "alert_c",
      countryCode: "8",
      // Table number and version are distinct source fields, never "6.13A".
      tableNumber: "6.13",
      tableVersion: "A",
      primaryLocation: "10439",
      secondaryLocation: "10436",
    });
    expect(JSON.stringify(fact.scope.sourceLocationRefs)).not.toContain("6.13A");
  });

  it("keeps the supplied coordinate geometry of the height record", () => {
    expect(heightOf().geometry).toEqual({
      type: "LineString",
      coordinates: [
        [6.010251, 50.832798],
        [6.023702, 50.819553],
      ],
    });
  });

  it("retains both lorry records with their opposite source directions", () => {
    const positive = eventOf(LORRY_POSITIVE_ID).restrictionDetails.facts[0];
    const negative = eventOf(LORRY_NEGATIVE_ID).restrictionDetails.facts[0];
    expect(positive.direction.value).toBe("positive");
    expect(negative.direction.value).toBe("negative");
    // A source-scheme direction is never mapped onto an OSM f/b orientation.
    for (const fact of [positive, negative]) {
      expect(["f", "b"]).not.toContain(fact.direction.value);
      expect(fact.validTo).toBeNull();
    }
  });

  it("records the source version time as the update instant, not the fetch time", () => {
    expect(heightOf().restrictionDetails.source.sourceUpdatedAt).toBe("2026-09-09T15:00:38.000Z");
    expect(eventOf(LORRY_POSITIVE_ID).restrictionDetails.source.sourceUpdatedAt).toBe(
      "2026-09-12T04:35:25.588Z",
    );
  });

  it("reports conflicting nested direction alternatives as unknown", () => {
    // Synthetic: the second location alternative of the height record is flipped.
    const source = xml.replace(
      "<loc:alertCDirectionCoded>positive</loc:alertCDirectionCoded><loc:alertCAffectedDirection>aligned</loc:alertCAffectedDirection></loc:alertCDirection><loc:alertCMethod4PrimaryPointLocation><loc:alertCLocation><loc:specificLocation>10439</loc:specificLocation>",
      "<loc:alertCDirectionCoded>negative</loc:alertCDirectionCoded><loc:alertCAffectedDirection>aligned</loc:alertCAffectedDirection></loc:alertCDirection><loc:alertCMethod4PrimaryPointLocation><loc:alertCLocation><loc:specificLocation>10439</loc:specificLocation>",
    );
    const extra =
      '<loc:locationContainedInItinerary index="2"><loc:location xsi:type="loc:SingleRoadLinearLocation"><loc:alertCLinear xsi:type="loc:AlertCMethod4Linear"><loc:alertCLocationCountryCode>8</loc:alertCLocationCountryCode><loc:alertCLocationTableNumber>6.13</loc:alertCLocationTableNumber><loc:alertCLocationTableVersion>A</loc:alertCLocationTableVersion><loc:alertCDirection><loc:alertCDirectionCoded>positive</loc:alertCDirectionCoded></loc:alertCDirection></loc:alertCLinear></loc:location></loc:locationContainedInItinerary>';
    const conflicted = source.replace(
      "</loc:locationContainedInItinerary></sit:locationReference><sit:operatorActionStatus>implemented</sit:operatorActionStatus><sit:complianceOption>mandatory</sit:complianceOption><sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic>",
      `</loc:locationContainedInItinerary>${extra}</sit:locationReference><sit:operatorActionStatus>implemented</sit:operatorActionStatus><sit:complianceOption>mandatory</sit:complianceOption><sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic>`,
    );
    const details = heightOf(conflicted).restrictionDetails;
    expect(details.facts[0].direction.value).toBe("unknown");
    expect(details.issues).toContainEqual(
      expect.objectContaining({ code: "conflicting_direction" }),
    );
    expect(JSON.stringify(details.issues)).toContain("negative");
  });
});

describe("ndw conservative restriction validity", () => {
  it("verifies the live implemented, time-specified height condition as active", () => {
    const view = heightView();
    expect(view.facts[0]!.state).toBe("active");
    expect(view.isStale).toBe(false);
  });

  it.each([undefined, "planned", "beingTerminated", "futureUnknownStatus"])(
    "does not verify active status %s",
    (status) => {
      const mutatedXml =
        status === undefined
          ? xml.replace(
              "<sit:operatorActionStatus>implemented</sit:operatorActionStatus><sit:complianceOption>mandatory</sit:complianceOption><sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic>",
              "<sit:complianceOption>mandatory</sit:complianceOption><sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic>",
            )
          : xml.replace(
              "<sit:operatorActionStatus>implemented</sit:operatorActionStatus><sit:complianceOption>mandatory</sit:complianceOption><sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic>",
              `<sit:operatorActionStatus>${status}</sit:operatorActionStatus><sit:complianceOption>mandatory</sit:complianceOption><sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic>`,
            );
      const view = heightView(mutatedXml);
      expect(view.facts[0]!.state).toBe("unknown");
      expect(view.issues).toContainEqual(expect.objectContaining({ code: "unsupported_status" }));
      expect(view.facts[0]!.context.operatorActionStatus).toBe(status ?? null);
    },
  );

  it("does not verify an unrecognized or missing validity status", () => {
    for (const replacement of [
      "<sit:validity><com:validityStatus>somethingNew</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2025-09-05T22:59:03Z</com:overallStartTime></com:validityTimeSpecification></sit:validity>",
      "<sit:validity><com:validityTimeSpecification><com:overallStartTime>2025-09-05T22:59:03Z</com:overallStartTime></com:validityTimeSpecification></sit:validity>",
    ]) {
      const view = heightView(withHeightValidity(replacement));
      expect(view.facts[0]!.state).toBe("unknown");
      expect(view.issues).toContainEqual(expect.objectContaining({ code: "unsupported_status" }));
    }
  });

  it("still labels a known future start scheduled and a passed end ended", () => {
    const future = heightView(
      withHeightValidity(
        "<sit:validity><com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2027-01-01T00:00:00Z</com:overallStartTime></com:validityTimeSpecification></sit:validity>",
      ),
    );
    expect(future.facts[0]!.state).toBe("scheduled");
    const ended = heightView(
      withHeightValidity(
        "<sit:validity><com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2025-01-01T00:00:00Z</com:overallStartTime><com:overallEndTime>2025-02-01T00:00:00Z</com:overallEndTime></com:validityTimeSpecification></sit:validity>",
      ),
    );
    expect(ended.facts[0]!.state).toBe("ended");
  });

  it("keeps the open-ended lorry conditions present with no invented end", () => {
    for (const id of [LORRY_POSITIVE_ID, LORRY_NEGATIVE_ID]) {
      const fact = eventOf(id).restrictionDetails.facts[0];
      expect(fact.validTo).toBeNull();
      expect(fact.validFrom).not.toBeNull();
    }
  });

  it("reports an unrepresentable recurrence instead of claiming continuous effect", () => {
    // Synthetic: a weekday recurrence the existing schedule model does not carry.
    const view = heightView(
      withHeightValidity(
        "<sit:validity><com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2025-09-05T22:59:03Z</com:overallStartTime><com:validPeriod><com:recurringDayWeekMonthPeriod><com:applicableDay>monday</com:applicableDay></com:recurringDayWeekMonthPeriod></com:validPeriod></com:validityTimeSpecification></sit:validity>",
      ),
    );
    expect(view.issues).toContainEqual(expect.objectContaining({ code: "unsupported_schedule" }));
    expect(view.facts[0]!.state).toBe("unknown");
  });

  it("reports an exception period as unsupported rather than ignoring it", () => {
    const view = heightView(
      withHeightValidity(
        "<sit:validity><com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2025-09-05T22:59:03Z</com:overallStartTime><com:exceptionPeriod><com:startOfPeriod>2026-12-24T00:00:00Z</com:startOfPeriod></com:exceptionPeriod></com:validityTimeSpecification></sit:validity>",
      ),
    );
    expect(view.issues).toContainEqual(expect.objectContaining({ code: "unsupported_schedule" }));
    expect(view.facts[0]!.state).toBe("unknown");
  });

  it("carries a fully represented nightly recurrence in the Amsterdam zone", () => {
    const details = heightOf(
      withHeightValidity(
        "<sit:validity><com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2025-09-05T22:59:03Z</com:overallStartTime><com:overallEndTime>2027-03-30T21:59:00Z</com:overallEndTime><com:validPeriod><com:startOfPeriod>2026-09-01T00:00:00Z</com:startOfPeriod><com:endOfPeriod>2026-10-01T00:00:00Z</com:endOfPeriod><com:recurringTimePeriodOfDay><com:startTimeOfPeriod>21:00:00</com:startTimeOfPeriod><com:endTimeOfPeriod>05:00:00</com:endTimeOfPeriod></com:recurringTimePeriodOfDay></com:validPeriod></com:validityTimeSpecification></sit:validity>",
      ),
    ).restrictionDetails;
    expect(details.issues).not.toContainEqual(
      expect.objectContaining({ code: "unsupported_schedule" }),
    );
    expect(details.facts[0].schedule).toEqual([
      expect.objectContaining({
        startTime: "21:00:00",
        endTime: "05:00:00",
        repeatFrequency: "P1D",
        scheduleTimezone: "Europe/Amsterdam",
      }),
    ]);
  });

  it.each(["cancelled", "archived", "suspended"])(
    "withdraws a %s record while retaining its diagnostic evidence in the array wrapper",
    (status) => {
      const source = withHeightValidity(
        `<sit:validity><com:validityStatus>${status}</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>2025-09-05T22:59:03Z</com:overallStartTime></com:validityTimeSpecification></sit:validity>`,
      );
      const snapshot = reconcileRoadSnapshots([parseDatexSnapshot(source, ndwSource)]);
      expect(snapshot.terminalIds).toContain(`nl-ndw${HEIGHT_SUFFIX}`);
      expect(snapshot.observations.some((event) => event.id.endsWith(HEIGHT_SUFFIX))).toBe(false);
      const event = parseDatexSituations(source, ndwSource).find((event) =>
        event.id.endsWith(HEIGHT_SUFFIX),
      )!;
      expect(event.status).toBe(status === "suspended" ? "inactive" : status);
      expect(event.restrictionDetails!.facts).toHaveLength(1);
      expect(
        projectRoadRestrictionDetails(event.restrictionDetails, {
          at: new Date("2026-09-12T07:14:00Z"),
          sourceCheckedAt: "2026-09-12T07:13:00Z",
          freshnessWindowSec: 300,
        }).restrictionDetails?.facts[0]?.state,
      ).toBe("unknown");
      expect(event.restrictionDetails!.facts[0]!.context.validityStatus).toBe(status);
      expect(event.restrictionDetails!.issues).toContainEqual(
        expect.objectContaining({ code: "unsupported_status" }),
      );
    },
  );

  it("keeps a new source version of the same geometry distinguishable", () => {
    const bumped = xml.replace(
      '<sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="RWS01_M1080891_NARROW_LANES_D2_WWA" version="133">',
      '<sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="RWS01_M1080891_NARROW_LANES_D2_WWA" version="134">',
    );
    expect(heightOf().restrictionDetails.source.recordVersion).toBe("133");
    expect(heightOf(bumped).restrictionDetails.source.recordVersion).toBe("134");
  });
});
