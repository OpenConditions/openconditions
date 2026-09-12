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
    expect(fixture.expectedConditionalIds).toEqual(["fi-digitraffic:GUID50465935"]);
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
