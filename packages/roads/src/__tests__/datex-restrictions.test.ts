import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDatexSnapshot } from "../datex.js";
import { isRoadRestrictionDetails } from "../restrictions.js";
import { reconcileRoadSnapshots } from "../snapshot.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Source fixture: the reviewed 2026-09-12 NDW capture reduced to six real
 * records (see its companion manifest). Variants below are built by mutating
 * that XML and are explicitly labelled synthetic; none of them claims to have
 * appeared in the live feed.
 */
const xml = readFileSync(new URL("./fixtures/ndw/restrictions-v3.xml", import.meta.url), "utf8");

const ndwSource: SourceDescriptor = {
  id: "nl-ndw",
  attribution: "NDW / Rijkswaterstaat",
  country: "NL",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
};

const HEIGHT_ID = "nl-ndw:RWS01_M1080891_NARROW_LANES_D2_WWA";
const EMERGENCY_ID = "nl-ndw:RWS01_M1080891_EMERGENCY_SERVICES_D2_WWA";
const DISPLACEMENT_ID = "nl-ndw:RWS01_M1080891_DISPLACEMENT_D2_WWA";
const OBSTRUCTION_ID = "nl-ndw:NDW08_2e188db4-9bff-492d-bf28-90e17bffac8c";
const LORRY_POSITIVE_ID = "nl-ndw:NLRWS_0005382945_1";
const LORRY_NEGATIVE_ID = "nl-ndw:NLRWS_0005406494_1";

function snapshot(source = xml) {
  return reconcileRoadSnapshots([parseDatexSnapshot(source, ndwSource)]);
}

// biome-ignore lint/suspicious/noExplicitAny: observations are a union of resolved and unresolved events.
function eventOf(id: string, source = xml): any {
  const found = snapshot(source).observations.find((e) => e.id === id);
  if (!found) throw new Error(`no observation ${id}`);
  return found;
}

/** Replace the height record's applicability group with a synthetic variant. */
function withHeightApplicability(replacement: string): string {
  const original =
    "<sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator><com:vehicleHeight>4.5</com:vehicleHeight></com:heightCharacteristic></sit:forVehiclesWithCharacteristicsOf>";
  if (!xml.includes(original)) throw new Error("fixture height applicability group moved");
  return xml.replace(original, replacement);
}

describe("ndw applicability extraction from the real capture", () => {
  it("keeps every distinct source id, including the collocated records", () => {
    const parsed = snapshot();
    expect(parsed.uniqueCount).toBe(6);
    const ids = parsed.observations.map((e) => e.id).sort();
    expect(ids).toEqual(
      [
        HEIGHT_ID,
        EMERGENCY_ID,
        DISPLACEMENT_ID,
        OBSTRUCTION_ID,
        LORRY_POSITIVE_ID,
        LORRY_NEGATIVE_ID,
      ].sort(),
    );
  });

  it("accounts for every input record exactly once", () => {
    const report = parseDatexSnapshot(xml, ndwSource);
    const parsed = reconcileRoadSnapshots([report]);
    const accounted = [
      ...parsed.acceptedIds,
      ...parsed.terminalIds,
      ...parsed.unlocatableIds,
    ].sort();
    expect(report.inputCount).toBe(6);
    expect(new Set(accounted).size).toBe(6);
  });

  it("normalizes the live height condition as event applicability above 4.5 m", () => {
    const height = eventOf(HEIGHT_ID);
    expect(height.type).toBe("road_closure");
    expect(height.roadState).toBe("closed");
    expect(isRoadRestrictionDetails(height.restrictionDetails)).toBe(true);
    expect(height.restrictionDetails.facts).toEqual([
      expect.objectContaining({
        kind: "dimension",
        dimension: "height",
        value: 4.5,
        unit: "m",
        operator: "gt",
        meaning: "event_applies_when",
        scope: expect.objectContaining({
          kind: "event_road",
          phaseId: null,
          restrictionBinding: "not_established",
        }),
      }),
    ]);
    expect(height.restrictionDetails.vehicleScope).toBe("specific");
    expect(height.restrictionDetails.source).toMatchObject({
      sourceId: "nl-ndw",
      recordId: "RWS01_M1080891_NARROW_LANES_D2_WWA",
      recordVersion: "133",
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: "NDW / Rijkswaterstaat",
    });
    expect(height.restrictionDetails.facts[0].context.compliance).toBe("mandatory");
  });

  it("reads the source management type rather than the record id headline", () => {
    // The source id says NARROW_LANES; the source measure says roadClosed.
    expect(eventOf(HEIGHT_ID).subtype ?? "").not.toBe("road_closure");
    expect(eventOf(DISPLACEMENT_ID).type).not.toBe("road_closure");
  });

  it("treats an obstruction participant as context, never as applicability", () => {
    const obstruction = eventOf(OBSTRUCTION_ID);
    expect(obstruction.restrictionDetails).toBeUndefined();
    expect(obstruction.restrictionDetailsUnsupported).toBeUndefined();
    expect(obstruction.vehiclesAffected ?? []).not.toContain("constructionOrMaintenanceVehicle");
  });

  it("maps both live lorry records to a truck class fact and keeps their prose", () => {
    for (const id of [LORRY_POSITIVE_ID, LORRY_NEGATIVE_ID]) {
      const event = eventOf(id);
      expect(event.restrictionDetails.facts).toHaveLength(1);
      const fact = event.restrictionDetails.facts[0];
      expect(fact).toMatchObject({
        kind: "vehicle_class",
        value: "truck",
        meaning: "event_applies_when",
      });
      expect(fact.context.comments).toEqual([
        {
          text: "Verbod voor vrachtverkeer en autobussen (>3500kg). Lijnbussen toegestaan.",
          language: "nl",
        },
      ]);
      // The prose mentions 3500 kg and line buses; neither becomes a fact.
      expect(event.restrictionDetails.facts).toHaveLength(1);
      expect(JSON.stringify(event.restrictionDetails.facts)).not.toContain("gross_weight");
      expect(event.restrictionDetails.completeness).toBe("complete");
      expect(event.vehiclesAffected).toEqual(["lorry"]);
    }
  });

  it("maps the live emergency-services usage without turning it into a class", () => {
    const event = eventOf(EMERGENCY_ID);
    expect(event.restrictionDetails.facts).toEqual([
      expect.objectContaining({
        kind: "vehicle_usage",
        value: "emergency_services",
        meaning: "event_applies_when",
      }),
    ]);
    expect(event.restrictionDetails.facts[0].context.compliance).toBe("advisory");
    expect(event.vehiclesAffected).toEqual(["emergencyServices"]);
  });

  it("leaves a collocated nonconditional record free of restriction evidence", () => {
    const displacement = eventOf(DISPLACEMENT_ID);
    expect(displacement.restrictionDetails).toBeUndefined();
    expect(displacement.restrictionDetailsUnsupported).toBeUndefined();
  });

  it("derives legacy numeric restrictions from the verified fact only", () => {
    expect(eventOf(HEIGHT_ID).restrictions).toEqual([
      { type: "height", value: 4.5, unit: "m", operator: "gt" },
    ]);
  });
});

describe("ndw synthetic applicability variants", () => {
  it("does not verify an unknown comparison operator", () => {
    const source = withHeightApplicability(
      "<sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic><com:comparisonOperator>lessThan</com:comparisonOperator><com:vehicleHeight>4.5</com:vehicleHeight></com:heightCharacteristic></sit:forVehiclesWithCharacteristicsOf>",
    );
    const details = eventOf(HEIGHT_ID, source).restrictionDetails;
    expect(details.facts).toEqual([]);
    expect(details.vehicleScope).toBe("unknown");
    expect(details.completeness).toBe("partial");
    expect(details.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_operator" }),
    );
  });

  it("does not verify a missing comparison operator", () => {
    const source = withHeightApplicability(
      "<sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic><com:vehicleHeight>4.5</com:vehicleHeight></com:heightCharacteristic></sit:forVehiclesWithCharacteristicsOf>",
    );
    const details = eventOf(HEIGHT_ID, source).restrictionDetails;
    expect(details.facts).toEqual([]);
    expect(details.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_operator" }),
    );
  });

  it.each(["0", "-4.5", "NaN", "Infinity", "0x10", "4.5m", ""])(
    "rejects the malformed height value %s",
    (value) => {
      const source = withHeightApplicability(
        `<sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator><com:vehicleHeight>${value}</com:vehicleHeight></com:heightCharacteristic></sit:forVehiclesWithCharacteristicsOf>`,
      );
      const details = eventOf(HEIGHT_ID, source).restrictionDetails;
      expect(details.facts).toEqual([]);
      expect(details.vehicleScope).toBe("unknown");
      expect(details.issues).toContainEqual(expect.objectContaining({ code: "invalid_value" }));
    },
  );

  it("reports a missing height quantity rather than widening applicability", () => {
    const source = withHeightApplicability(
      "<sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator></com:heightCharacteristic></sit:forVehiclesWithCharacteristicsOf>",
    );
    const details = eventOf(HEIGHT_ID, source).restrictionDetails;
    expect(details.facts).toEqual([]);
    expect(details.issues).toContainEqual(expect.objectContaining({ code: "invalid_value" }));
  });

  it("keeps an unverified weight dimension as partial context without inventing kilograms", () => {
    const source = withHeightApplicability(
      "<sit:forVehiclesWithCharacteristicsOf><com:grossWeightCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator><com:grossVehicleWeight>3500</com:grossVehicleWeight></com:grossWeightCharacteristic></sit:forVehiclesWithCharacteristicsOf>",
    );
    const event = eventOf(HEIGHT_ID, source);
    expect(event.restrictionDetails.facts).toEqual([]);
    expect(event.restrictionDetails.completeness).toBe("partial");
    expect(event.restrictionDetails.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_type" }),
    );
    expect(event.restrictions ?? []).toEqual([]);
  });

  it("does not normalize an unverified width dimension", () => {
    const source = withHeightApplicability(
      "<sit:forVehiclesWithCharacteristicsOf><com:widthCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator><com:vehicleWidth>3</com:vehicleWidth></com:widthCharacteristic></sit:forVehiclesWithCharacteristicsOf>",
    );
    const details = eventOf(HEIGHT_ID, source).restrictionDetails;
    expect(details.facts).toEqual([]);
    expect(details.issues).toContainEqual(expect.objectContaining({ code: "unsupported_type" }));
  });

  it("marks an unfamiliar vehicle token unknown instead of guessing", () => {
    const source = withHeightApplicability(
      "<sit:forVehiclesWithCharacteristicsOf><com:vehicleType>agriculturalVehicle</com:vehicleType></sit:forVehiclesWithCharacteristicsOf>",
    );
    const details = eventOf(HEIGHT_ID, source).restrictionDetails;
    expect(details.facts).toEqual([]);
    expect(details.vehicleScope).toBe("unknown");
    expect(details.issues).toContainEqual(
      expect.objectContaining({ code: "unknown_vehicle", sourceText: "agriculturalVehicle" }),
    );
  });

  it("keeps a mixed height and class group partial and does not build a boolean rule", () => {
    const source = withHeightApplicability(
      "<sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator><com:vehicleHeight>4.5</com:vehicleHeight></com:heightCharacteristic><com:vehicleType>lorry</com:vehicleType></sit:forVehiclesWithCharacteristicsOf>",
    );
    const details = eventOf(HEIGHT_ID, source).restrictionDetails;
    expect(details.completeness).toBe("partial");
    expect(details.issues).toContainEqual(expect.objectContaining({ code: "compound_condition" }));
    expect(details.facts.map((f: { kind: string }) => f.kind).sort()).toEqual([
      "dimension",
      "vehicle_class",
    ]);
  });

  it("keeps repeated applicability groups distinguishable and uninterpreted", () => {
    const source = withHeightApplicability(
      "<sit:forVehiclesWithCharacteristicsOf><com:heightCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator><com:vehicleHeight>4.5</com:vehicleHeight></com:heightCharacteristic></sit:forVehiclesWithCharacteristicsOf>" +
        "<sit:forVehiclesWithCharacteristicsOf><com:vehicleType>lorry</com:vehicleType></sit:forVehiclesWithCharacteristicsOf>",
    );
    const details = eventOf(HEIGHT_ID, source).restrictionDetails;
    expect(details.issues).toContainEqual(expect.objectContaining({ code: "compound_condition" }));
    const paths = details.facts.map(
      (f: { sourceTokens: { sourcePath: string } }) => f.sourceTokens.sourcePath,
    );
    expect(new Set(paths).size).toBe(2);
  });

  it("never emits an empty envelope that could read as all vehicles", () => {
    const source = withHeightApplicability("<sit:forVehiclesWithCharacteristicsOf/>");
    const details = eventOf(HEIGHT_ID, source).restrictionDetails;
    expect(details.facts).toEqual([]);
    expect(details.vehicleScope).toBe("unknown");
    expect(details.completeness).toBe("partial");
    expect(details.issues.length).toBeGreaterThan(0);
  });

  it("keeps a wrong-role height characteristic out of applicability", () => {
    const source = withHeightApplicability(
      "<sit:obstructingVehicle><com:vehicleCharacteristics><com:heightCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator><com:vehicleHeight>4.5</com:vehicleHeight></com:heightCharacteristic></com:vehicleCharacteristics></sit:obstructingVehicle>",
    );
    const event = eventOf(HEIGHT_ID, source);
    expect(event.restrictionDetails).toBeUndefined();
    expect(event.restrictions ?? []).toEqual([]);
  });

  it("escapes source comment markup rather than interpreting it", () => {
    const source = xml.replace(
      "Verbod voor vrachtverkeer en autobussen (&gt;3500kg). Lijnbussen toegestaan.",
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; co",
    );
    const fact = eventOf(LORRY_POSITIVE_ID, source).restrictionDetails.facts[0];
    expect(fact.context.comments).toEqual([
      { text: "<script>alert(1)</script> & co", language: "nl" },
    ]);
  });
});
