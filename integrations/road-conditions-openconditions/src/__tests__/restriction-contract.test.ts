import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { segmentConditionsToJson } from "@openconditions/publishers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRestrictionContractFixture,
  CONTRACT_EVALUATED_AT,
  contractRowWithoutRestrictionEvidence,
} from "./restriction-contract-fixture.js";

/**
 * The cross-repository restriction contract. The golden file is generated from
 * the real producer path once, reviewed, and thereafter only compared — so a
 * producer change that alters the wire shape fails here rather than surfacing
 * as a silent mismatch in OpenMapX.
 *
 * Regenerate deliberately with `UPDATE_RESTRICTION_CONTRACT=1`, never in CI.
 */

const GOLDEN_URL = new URL(
  "../../../../packages/publishers/src/__tests__/fixtures/contracts/road-restrictions-v1.json",
  import.meta.url,
);

// The segment publisher stamps `generated_at` from the wall clock, so the
// whole fixture is produced under the frozen contract instant.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(CONTRACT_EVALUATED_AT));
});
afterEach(() => vi.useRealTimers());

describe("restriction display and routing contract", () => {
  it("matches the reviewed golden output", () => {
    const produced = buildRestrictionContractFixture();
    if (process.env["UPDATE_RESTRICTION_CONTRACT"] === "1" && !process.env["CI"]) {
      writeFileSync(fileURLToPath(GOLDEN_URL), `${JSON.stringify(produced, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN_URL, "utf8"));
    expect(produced).toEqual(golden);
  });

  it("shows the conditional record while emitting no shared-routing condition", () => {
    const fixture = buildRestrictionContractFixture();
    expect(fixture.evaluatedAt).toBe(CONTRACT_EVALUATED_AT);
    expect(fixture.expectedConditionalIds).toEqual([
      "fi-digitraffic:GUID50465935",
      "nl-ndw:RWS01_M1080891_NARROW_LANES_D2_WWA",
      "nl-ndw:RWS01_M1080891_EMERGENCY_SERVICES_D2_WWA",
      "nl-ndw:NLRWS_0005382945_1",
      "nl-ndw:NLRWS_0005406494_1",
    ]);
    const displayed = fixture.displayEvents.find(
      (event) => event.id === "fi-digitraffic:GUID50465935",
    )!;
    expect(displayed.restrictionDetails!.facts[0]).toMatchObject({
      value: 26000,
      unit: "kg",
      state: "active",
      scope: { kind: "roadwork_phase", restrictionBinding: "not_established" },
    });
    expect(fixture.segmentConditions.conditions.map((condition) => condition.id)).toEqual([
      "contract:closure-1",
    ]);
  });

  it("attributes the exclusion to restriction evidence and nothing else", () => {
    // The identical row, with only its restriction evidence removed, does
    // emit — so nothing about its rights, binding or evidence explains the
    // exclusion above.
    const { row, at, resolverVersion } = contractRowWithoutRestrictionEvidence();
    const emitted = segmentConditionsToJson([row], at, { resolverVersion, evaluatedAt: at });
    expect(emitted.conditions.map((condition) => condition.id)).toEqual([
      "fi-digitraffic:GUID50465935",
    ]);
  });

  it("publishes complete source rights with the displayed facts", () => {
    const fixture = buildRestrictionContractFixture();
    const displayed = fixture.displayEvents.find(
      (event) => event.id === "fi-digitraffic:GUID50465935",
    )!;
    expect(displayed.restrictionDetails!.source).toMatchObject({
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Fintraffic / Digitraffic",
    });
    expect(displayed.restrictionDetails!.source.feedUrls).toHaveLength(4);
    expect(displayed.restrictionDetails!.source.modificationNotice).toContain(
      "Normalized by OpenConditions",
    );
  });

  it("publishes the NDW height condition as event applicability above 4.5 m", () => {
    const fixture = buildRestrictionContractFixture();
    const height = fixture.displayEvents.find((event) =>
      event.id.endsWith(":RWS01_M1080891_NARROW_LANES_D2_WWA"),
    )!;
    expect(height.restrictionDetails!.facts[0]).toMatchObject({
      meaning: "event_applies_when",
      dimension: "height",
      operator: "gt",
      value: 4.5,
      unit: "m",
      state: "active",
      direction: { basis: "alert_c", value: "positive", description: "aligned" },
      scope: { kind: "event_road", phaseId: null, restrictionBinding: "not_established" },
    });
    expect(height.restrictionDetails!.source).toMatchObject({
      recordId: "RWS01_M1080891_NARROW_LANES_D2_WWA",
      recordVersion: "133",
      publisher: "NDW / Rijkswaterstaat",
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    });
    expect(height.restrictionDetails!.source.feedUrls).toEqual([
      "https://opendata.ndw.nu/actueel_beeld.xml.gz",
    ]);
  });

  it("publishes the NDW class and usage facts without formalizing their prose", () => {
    const fixture = buildRestrictionContractFixture();
    for (const id of ["nl-ndw:NLRWS_0005382945_1", "nl-ndw:NLRWS_0005406494_1"]) {
      const lorry = fixture.displayEvents.find((event) => event.id === id)!;
      expect(lorry.restrictionDetails!.facts).toHaveLength(1);
      expect(lorry.restrictionDetails!.facts[0]).toMatchObject({
        kind: "vehicle_class",
        value: "truck",
        meaning: "event_applies_when",
      });
      expect(lorry.restrictionDetails!.facts[0]!.context.comments).toEqual([
        {
          text: "Verbod voor vrachtverkeer en autobussen (>3500kg). Lijnbussen toegestaan.",
          language: "nl",
        },
      ]);
      // The prose names 3500 kg and line buses; neither becomes a fact.
      expect(JSON.stringify(lorry.restrictionDetails!.facts)).not.toContain("gross_weight");
    }
    expect(
      fixture.displayEvents.find((event) =>
        event.id.endsWith(":RWS01_M1080891_EMERGENCY_SERVICES_D2_WWA"),
      )!.restrictionDetails!.facts[0],
    ).toMatchObject({
      kind: "vehicle_usage",
      value: "emergency_services",
      meaning: "event_applies_when",
    });
    expect(
      fixture.displayEvents.find((event) => event.id === "nl-ndw:NLRWS_0005406494_1")!
        .restrictionDetails!.facts[0]!.direction.value,
    ).toBe("negative");
  });

  it("keeps the unconditional control publishing for display and routing", () => {
    const fixture = buildRestrictionContractFixture();
    const control = fixture.displayEvents.find((event) => event.id === "contract:closure-1")!;
    expect(control.restrictionDetails).toBeUndefined();
    expect(control.restrictionDetailsUnsupported).toBeUndefined();
    const emitted = fixture.segmentConditions.conditions[0]!;
    expect(emitted.id).toBe("contract:closure-1");
    expect(emitted.routing_evidence.applicability.kind).toBe("all");
  });
});
