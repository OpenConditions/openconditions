import { productionRegistry } from "@openconditions/model-registry";
import { describe, expect, it } from "vitest";
import { datexRecordsOf } from "../situation-datex.js";
import { situationsToGeoJSON } from "../situation-geojson.js";
import { situationsToTraff } from "../situation-traff.js";

const registry = productionRegistry();
const at = new Date("2026-10-15T12:00:00Z");
const record = (fuzziness: string, effectLocation?: Record<string, unknown>) => ({
  id: "oc:situation:nl-ndw-events:coarse",
  class: "situation",
  kind: "closure",
  type: "closure",
  subtype: "full",
  temporality: "live",
  certainty: "observed",
  validity: { status: "active", start: "2026-10-15T10:00:00Z" },
  provenance: {},
  freshness: { fetchedAt: "2026-10-15T11:00:00Z" },
  location: {
    geometry: { type: "Point", coordinates: [5.7, 50.8] },
    extent: "point",
    geometryOrigin: "tmc_table",
    fuzziness,
  },
  effects: [
    {
      id: "coarse/closure",
      kind: "closure",
      v: 1,
      scope: "road",
      applicability: { kind: "all" },
      normalization: "complete",
      compliance: "mandatory",
      ...(effectLocation ? { location: effectLocation } : {}),
    },
  ],
});

describe("coarse locations are display-only", () => {
  it.each([
    record("low_res"),
    record("extent_unknown"),
    record("exact", { fuzziness: "low_res" }),
    record("exact", {
      geometry: { type: "Point", coordinates: [5.8, 50.9] },
      fuzziness: "low_res",
    }),
  ])(
    "keeps canonical GeoJSON but withholds XML that cannot preserve the location uncertainty",
    (situation) => {
      expect(situationsToGeoJSON([situation]).features).toHaveLength(1);
      expect(situationsToTraff(registry, [situation], at)).not.toContain("<message ");
      expect(datexRecordsOf(situation, at)).toEqual([]);
    },
  );
  it("continues exporting an exact point", () => {
    expect(situationsToTraff(registry, [record("exact")], at)).toContain("<message ");
    expect(datexRecordsOf(record("exact"), at).length).toBeGreaterThan(0);
  });
});
