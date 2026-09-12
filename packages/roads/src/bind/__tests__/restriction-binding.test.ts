import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDigitraffic } from "../../digitraffic.js";
import type { SourceDescriptor } from "../../types.js";
import { bindEvent, toBindInput } from "../bind-event.js";
import type { SpineSubgraph } from "../types.js";

/**
 * Event binding for the Finnish restriction records, against a frozen OSM
 * spine around Road 40 near Lieto. The spine is OpenStreetMap data under ODbL
 * (see the companion manifest) and is separate from the CC BY 4.0 Fintraffic
 * source fixture it is exercised with.
 *
 * The point of these cases is what binding does NOT establish: matching the
 * parent event to segments says nothing about where a phase or detour
 * restriction actually applies.
 */

const spine = JSON.parse(
  readFileSync(new URL("./fixtures/finland-road40/spine.json", import.meta.url), "utf8")
) as SpineSubgraph;

const raw = JSON.parse(
  readFileSync(
    new URL("../../__tests__/fixtures/digitraffic/v2-restrictions.json", import.meta.url),
    "utf8"
  )
);

const src: SourceDescriptor = {
  id: "fi-digitraffic",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
};

const events = parseDigitraffic(raw, src);

function eventById(id: string) {
  const event = events.find((e) => e.id === id);
  if (!event) throw new Error(`fixture has no event ${id}`);
  return event;
}

describe("restriction event binding on a frozen spine", () => {
  it("resolves the Road 40 width record onto real directed segments", () => {
    const event = eventById("fi-digitraffic:GUID50470575");
    const result = bindEvent(toBindInput(event), spine);
    expect(result.status).toBe("exact");
    expect(result.directionMode).toBe("single");
    expect(result.segments.map((span) => span.segmentId)).toEqual([
      "1089416142:f",
      "724030614:f",
      "1117139737:f",
    ]);
    const known = new Set(spine.segments.map((segment) => segment.segmentId));
    for (const span of result.segments) {
      expect(known.has(span.segmentId), span.segmentId).toBe(true);
      expect(span.startFraction).toBeGreaterThanOrEqual(0);
      expect(span.endFraction).toBeLessThanOrEqual(1);
      expect(span.startFraction).toBeLessThan(span.endFraction);
    }
  });

  it("never promotes the event binding to a restriction extent", () => {
    const event = eventById("fi-digitraffic:GUID50470575");
    const result = bindEvent(toBindInput(event), spine);
    expect(result.segments.length).toBeGreaterThan(0);
    for (const fact of event.restrictionDetails!.facts) {
      expect(fact.scope.restrictionBinding).toBe("not_established");
      expect(fact.scope).not.toHaveProperty("segments");
    }
  });

  it("keeps the source's own direction independent of the matched OSM direction", () => {
    const event = eventById("fi-digitraffic:GUID50470575");
    const result = bindEvent(toBindInput(event), spine);
    // Every matched segment runs forward along its way, while the source says
    // the affected carriageway is the decreasing road reference. Neither
    // statement may be rewritten into the other.
    expect(new Set(result.segments.map((span) => span.dir))).toEqual(new Set(["f"]));
    expect(event.restrictionDetails!.facts[0]!.direction).toEqual({
      basis: "road_reference",
      value: "negative",
      description: "Naantali",
    });
  });

  it("reports no coverage rather than binding to a nearby higher-class road", () => {
    // Road 7840 is far outside this spine's extract, and its own class is not
    // among the default imported ones.
    const result = bindEvent(toBindInput(eventById("fi-digitraffic:GUID50468844")), spine);
    expect(result.segments).toEqual([]);
    expect(["unresolved", "no_coverage"]).toContain(result.status);
  });
});

describe("disconnected linear geometry", () => {
  const base = () => toBindInput(eventById("fi-digitraffic:GUID50470575"));

  it("refuses to join components across a gap", () => {
    const input = base();
    const original = input.geometry as { type: string; coordinates: number[][][] };
    const component = original.coordinates[0]!;
    // Synthetic: split the real line and move the second half away, so the gap
    // crosses roads the source never mentioned.
    const half = Math.floor(component.length / 2);
    const gapped = {
      type: "MultiLineString" as const,
      coordinates: [
        component.slice(0, half),
        component.slice(half).map(([lon, lat]) => [lon! + 0.01, lat! + 0.005]),
      ],
    };
    const result = bindEvent({ ...input, geometry: gapped }, spine);
    expect(result.status).toBe("unresolved");
    expect(result.reason).toBe("disconnected_geometry");
    expect(result.segments).toEqual([]);
  });

  it("still binds a contiguous multi-component line", () => {
    const input = base();
    const original = input.geometry as { type: string; coordinates: number[][][] };
    const component = original.coordinates[0]!;
    const half = Math.floor(component.length / 2);
    const contiguous = {
      type: "MultiLineString" as const,
      coordinates: [component.slice(0, half + 1), component.slice(half)],
    };
    const result = bindEvent({ ...input, geometry: contiguous }, spine);
    expect(result.status).toBe("exact");
    expect(result.segments.map((span) => span.segmentId)).toEqual([
      "1089416142:f",
      "724030614:f",
      "1117139737:f",
    ]);
  });

  it("leaves points and polygons on their existing behaviour", () => {
    const point = bindEvent(
      { ...base(), geometry: { type: "Point", coordinates: [22.4, 60.4652] } },
      spine
    );
    expect(point.reason).not.toBe("disconnected_geometry");

    const polygon = bindEvent(
      {
        ...base(),
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [22.38, 60.455],
              [22.42, 60.455],
              [22.42, 60.475],
              [22.38, 60.475],
              [22.38, 60.455],
            ],
          ],
        },
      },
      spine
    );
    expect(polygon.status).toBe("not_applicable");
    expect(polygon.reason).toBe("polygon_geometry");
  });

  it("rejects an empty component rather than silently dropping it", () => {
    const input = base();
    const original = input.geometry as { type: string; coordinates: number[][][] };
    const result = bindEvent(
      {
        ...input,
        geometry: {
          type: "MultiLineString" as const,
          coordinates: [original.coordinates[0]!, []],
        },
      },
      spine
    );
    expect(result.reason).toBe("disconnected_geometry");
  });
});
