import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDatexSituations } from "../../datex.js";
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
  readFileSync(new URL("./fixtures/finland-road40/spine.json", import.meta.url), "utf8"),
) as SpineSubgraph;

const raw = JSON.parse(
  readFileSync(
    new URL("../../__tests__/fixtures/digitraffic/v2-restrictions.json", import.meta.url),
    "utf8",
  ),
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
      spine,
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
      spine,
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
      spine,
    );
    expect(result.reason).toBe("disconnected_geometry");
  });
});

/**
 * NDW event binding against a frozen OSM spine around the A76 near Kerkrade.
 * The spine is OpenStreetMap data under ODbL (see its companion manifest) and is
 * separate from the CC0-1.0 NDW source fixture it is exercised with.
 *
 * The height record supplies two endpoints, not a traced path, so this graph
 * matches it ambiguously. That is the honest outcome and the assertions below
 * pin it: the record stays displayable, and no threshold is tuned to force an
 * exact match the source geometry does not support.
 */
describe("ndw restriction event binding on the frozen A76 spine", () => {
  const a76 = JSON.parse(
    readFileSync(new URL("./fixtures/ndw-a76/spine.json", import.meta.url), "utf8"),
  ) as SpineSubgraph;

  const ndwSource: SourceDescriptor = {
    id: "nl-ndw",
    attribution: "NDW / Rijkswaterstaat",
    country: "NL",
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  };

  const ndwEvents = parseDatexSituations(
    readFileSync(
      new URL("../../__tests__/fixtures/ndw/restrictions-v3.xml", import.meta.url),
      "utf8",
    ),
    ndwSource,
  );

  function ndwEventById(id: string) {
    const event = ndwEvents.find((e) => e.id === id);
    if (!event) throw new Error(`fixture has no event ${id}`);
    if (event.geometry === undefined) throw new Error(`fixture event ${id} has no geometry`);
    return event as Extract<typeof event, { geometry: object }>;
  }

  const heightId = "nl-ndw:RWS01_M1080891_NARROW_LANES_D2_WWA";

  it("reports the endpoint geometry as ambiguous rather than inventing a path", () => {
    const result = bindEvent(toBindInput(ndwEventById(heightId)), a76);
    expect(result.status).toBe("ambiguous");
    const known = new Set(a76.segments.map((segment) => segment.segmentId));
    for (const span of result.segments) {
      expect(known.has(span.segmentId), span.segmentId).toBe(true);
    }
  });

  it("produces the same outcome on repeated runs", () => {
    const input = toBindInput(ndwEventById(heightId));
    const first = bindEvent(input, a76);
    const second = bindEvent(toBindInput(ndwEventById(heightId)), a76);
    expect(second.status).toBe(first.status);
    expect(second.segments.map((s) => s.segmentId)).toEqual(first.segments.map((s) => s.segmentId));
  });

  it("establishes no restriction extent even where the parent event matched", () => {
    const event = ndwEventById(heightId);
    bindEvent(toBindInput(event), a76);
    for (const fact of event.restrictionDetails!.facts) {
      expect(fact.scope.restrictionBinding).toBe("not_established");
      expect(fact.scope).not.toHaveProperty("segments");
    }
  });

  it("keeps the source Alert-C direction independent of any matched OSM direction", () => {
    const event = ndwEventById(heightId);
    expect(event.restrictionDetails!.facts[0]!.direction).toEqual({
      basis: "alert_c",
      value: "positive",
      description: "aligned",
    });
  });

  it("reports no coverage for a record outside this extract", () => {
    // The lorry closures are near Gorinchem, far outside the A76 bbox.
    const result = bindEvent(toBindInput(ndwEventById("nl-ndw:NLRWS_0005382945_1")), a76);
    expect(result.segments).toEqual([]);
    expect(["unresolved", "no_coverage"]).toContain(result.status);
  });
});
