import { describe, expect, it } from "vitest";
import type { Observation } from "@openconditions/core";
import { observationsToGeoJSON } from "../geojson.js";
import { observationsToJsonLd } from "../jsonld.js";
import { restrictionDetails, roadEvent } from "./fixture.js";

/**
 * The publication edge is where source semantics become a dated, freshness-
 * bounded view. These cases pin the two directions that matter: the stored
 * observation must never gain computed state, and an unparseable envelope must
 * never quietly become an absent restriction.
 */

const AT = new Date("2026-09-12T07:14:00.000Z");

function conditional(over: Record<string, unknown> = {}): Observation {
  return roadEvent({
    id: "fi-digitraffic:GUID50465935",
    source: "fi-digitraffic",
    type: "roadworks",
    restrictionDetails: restrictionDetails(),
    sourceCheckedAt: "2026-09-12T07:13:00.000Z",
    freshnessWindowSec: 600,
    ...over,
  } as never) as Observation;
}

describe("restriction publication", () => {
  it("publishes an evaluated view without mutating the stored observation", () => {
    const event = conditional();
    const fc = observationsToGeoJSON([event], {}, { at: AT });
    expect(fc.features[0]!.properties!["restrictionDetails"]).toMatchObject({
      schemaVersion: 1,
      evaluatedAt: AT.toISOString(),
      sourceCheckedAt: "2026-09-12T07:13:00.000Z",
      freshUntil: "2026-09-12T07:23:00.000Z",
      isStale: false,
      facts: [expect.objectContaining({ value: 26000, state: "active" })],
    });
    const stored = (event as Observation & { restrictionDetails: { facts: object[] } })
      .restrictionDetails;
    expect(stored).not.toHaveProperty("evaluatedAt");
    expect(stored).not.toHaveProperty("isStale");
    expect(stored.facts[0]).not.toHaveProperty("state");
  });

  it("keeps a source's rights, scope and provenance losslessly", () => {
    const properties = observationsToGeoJSON([conditional()], {}, { at: AT }).features[0]!
      .properties!;
    const details = properties["restrictionDetails"] as {
      source: Record<string, unknown>;
      facts: Array<Record<string, unknown>>;
    };
    expect(details.source).toMatchObject({
      sourceId: "fi-digitraffic",
      recordId: "GUID50465935",
      recordVersion: "31",
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    });
    expect(details.facts[0]!["scope"]).toMatchObject({
      kind: "roadwork_phase",
      phaseId: "GUID50469933",
      restrictionBinding: "not_established",
    });
  });

  it("reports an unparseable envelope as unsupported, not as no restriction", () => {
    const properties = observationsToGeoJSON(
      [conditional({ restrictionDetails: { schemaVersion: 9 } })],
      {},
      { at: AT }
    ).features[0]!.properties!;
    expect(properties["restrictionDetailsUnsupported"]).toBe(true);
    expect(properties).not.toHaveProperty("restrictionDetails");
  });

  it("preserves a producer-supplied unsupported marker", () => {
    const properties = observationsToGeoJSON(
      [roadEvent({ id: "x:1", restrictionDetailsUnsupported: true } as never) as Observation],
      {},
      { at: AT }
    ).features[0]!.properties!;
    expect(properties["restrictionDetailsUnsupported"]).toBe(true);
    expect(properties).not.toHaveProperty("restrictionDetails");
  });

  it("adds no marker at all to an observation that makes no restriction claim", () => {
    const properties = observationsToGeoJSON([roadEvent() as Observation], {}, { at: AT })
      .features[0]!.properties!;
    expect(properties).not.toHaveProperty("restrictionDetails");
    expect(properties).not.toHaveProperty("restrictionDetailsUnsupported");
  });

  it("marks a view stale when the source has no checked time", () => {
    const properties = observationsToGeoJSON(
      [conditional({ sourceCheckedAt: null })],
      {},
      { at: AT }
    ).features[0]!.properties!;
    const details = properties["restrictionDetails"] as { isStale: boolean; freshUntil: null };
    expect(details.freshUntil).toBeNull();
    expect(details.isStale).toBe(true);
  });

  it("keeps two collocated distinct source records separate", () => {
    const fc = observationsToGeoJSON(
      [conditional(), conditional({ id: "fi-digitraffic:GUID50461965" })],
      {},
      { at: AT }
    );
    expect(fc.features.map((f) => f.properties!["id"])).toEqual([
      "fi-digitraffic:GUID50465935",
      "fi-digitraffic:GUID50461965",
    ]);
  });

  it("carries the same evaluated view into JSON-LD", () => {
    const fc = observationsToJsonLd([conditional()], {}, { at: AT });
    const details = (fc.features[0]!.properties as Record<string, unknown>)[
      "restrictionDetails"
    ] as { evaluatedAt: string; facts: Array<{ state: string }> };
    expect(details.evaluatedAt).toBe(AT.toISOString());
    expect(details.facts[0]!.state).toBe("active");
  });

  it("evaluates a historical export at its own instant, not at now", () => {
    const historical = new Date("2027-01-01T00:00:00.000Z");
    const details = observationsToGeoJSON([conditional()], {}, { at: historical }).features[0]!
      .properties!["restrictionDetails"] as { facts: Array<{ state: string }>; isStale: boolean };
    expect(details.facts[0]!.state).toBe("ended");
    expect(details.isStale).toBe(true);
  });
});
